import { Inject, Injectable } from '@nestjs/common'
import { randomUUID, randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import { Repositories } from '../database/repositories'
import { CommandStore, type Outcome } from '../database/commands'
import { Clock } from '../common/clock'
import { passwordHash, passwordMatches } from '../common/security'
import { AppError, requireCondition as check } from '../common/errors'
import type { Room, Settings } from '../common/model'
import { newRoom, join, start, guess, skip, leave, ready, host, tick, GRACE_MS } from './rules'
import { lobbySummary, roomSnapshot } from './projections'
@Injectable()
export class RoomsService {
	constructor(
		@Inject(Repositories) readonly repo: Repositories,
		@Inject(CommandStore) private commands: CommandStore,
		@Inject(Clock) private clock: Clock
	) {}
	async create(owner: string, key: unknown, input: { settings: Settings; nickname: string; password: string }) {
		const secret = await passwordHash(input.password)
		return this.commands.run(owner, 'POST /rooms', key, input, null, async (c) => {
			const id = randomBytes(9).toString('base64url'),
				now = this.clock.now()
			const room = newRoom(id, owner, input.settings, input.nickname, secret, now)
			await this.repo.saveRoom(c, room)
			return { status: 201, body: { roomId: id, snapshot: roomSnapshot(room, owner, now) } }
		})
	}
	async list() {
		return this.repo.db.transaction(async (c) => {
			const ids = (
				await c.query<{ id: string }>(
					"SELECT id FROM rooms WHERE status='waiting' AND data->'settings'->>'visibility'='public' ORDER BY updated_at DESC LIMIT 100"
				)
			).rows
			const summaries = []
			for (const { id } of ids) summaries.push(lobbySummary(await this.repo.room(c, id, false)))
			return summaries
		})
	}
	async get(owner: string, id: string) {
		return this.repo.db.transaction(async (c) => {
			const room = await this.repo.room(c, id, false)
			if (!room.players.some((p) => p.id === owner && !p.left))
				return { view: 'preview' as const, ...lobbySummary(room), status: room.status }
			return roomSnapshot(room, owner, this.clock.now())
		})
	}
	async member(owner: string, id: string) {
		return this.repo.db.transaction(async (c) => {
			const r = await this.repo.room(c, id, false)
			check(
				r.players.some((p) => p.id === owner && !p.left),
				403,
				'FORBIDDEN'
			)
			check(r.status !== 'closed', 409, 'ROOM_CLOSED')
			return roomSnapshot(r, owner, this.clock.now())
		})
	}
	async join(owner: string, id: string, key: unknown, input: { nickname: string; password: string }) {
		const observed = await this.repo.db.transaction((c) => this.repo.room(c, id, false))
		if (!observed.players.some((p) => p.id === owner && !p.left))
			check(await passwordMatches(input.password, observed.passwordHash), 403, 'WRONG_PASSWORD')
		return this.mutate(
			owner,
			id,
			'join',
			key,
			input,
			async (room) => {
				check(room.passwordHash === observed.passwordHash, 409, 'ROOM_CHANGED')
				join(room, owner, input.nickname, this.clock.now())
			},
			false
		)
	}
	async action(
		owner: string,
		id: string,
		key: unknown,
		kind: 'start' | 'guesses' | 'skip' | 'leave' | 'ready' | 'retry-preparation',
		input: { roundId?: string; movieId?: string; expectedFrameIndex?: number }
	) {
		return this.mutate(owner, id, kind, key, input, async (r, c) => {
			const now = this.clock.now()
			if (kind === 'start') start(r, owner, now)
			else if (kind === 'guesses') guess(r, owner, input.roundId!, input.movieId!, input.expectedFrameIndex!, now)
			else if (kind === 'skip') skip(r, owner, input.roundId!, input.expectedFrameIndex!, now)
			else if (kind === 'ready') ready(r, owner, input.roundId!, now)
			else if (kind === 'leave') leave(r, owner, now)
			else {
				host(r, owner)
				check(r.status === 'error', 409, 'PREPARATION_NOT_FAILED')
				r.status = 'loading'
				r.generation++
				r.leaseUntil = null
				r.error = null
			}
			if (r.status === 'loading') await this.enqueue(c, r)
		})
	}
	private async mutate(
		owner: string,
		id: string,
		kind: string,
		key: unknown,
		input: unknown,
		work: (r: Room, c: PoolClient) => Promise<void>,
		requireMember = true
	): Promise<Outcome> {
		return this.commands.run(
			owner,
			`POST /rooms/${id}/${kind}`,
			key,
			input,
			id,
			async (c) => {
				const r = await this.repo.room(c, id)
				if (requireMember)
					check(
						r.players.some((p) => p.id === owner && !p.left),
						403,
						'FORBIDDEN'
					)
				const before = kind === 'ready' ? JSON.stringify(r) : undefined
				let deadlineError: AppError | undefined
				try {
					await work(r, c)
				} catch (e) {
					if (e instanceof AppError && e.code === 'DEADLINE_EXCEEDED') {
						deadlineError = e
						if (r.status === 'loading') await this.enqueue(c, r)
					} else throw e
				}
				if (kind === 'ready' && before === JSON.stringify(r))
					return { status: 200, body: roomSnapshot(r, owner, this.clock.now()) }
				r.version++
				r.updatedAt = this.clock.now()
				await this.repo.saveRoom(c, r)
				if (deadlineError) return { status: 409, body: { code: deadlineError.code, message: deadlineError.message } }
				return { status: 200, body: kind === 'leave' ? { left: true } : roomSnapshot(r, owner, this.clock.now()) }
			},
			async (c) => {
				if (requireMember && kind !== 'leave') {
					const current = await this.repo.room(c, id)
					check(
						current.players.some((p) => p.id === owner && !p.left),
						403,
						'FORBIDDEN'
					)
					if (kind === 'start' || kind === 'retry-preparation') host(current, owner)
				}
			}
		)
	}
	async enqueue(c: PoolClient, r: Room) {
		await c.query(
			"INSERT INTO preparation_operations(id,target_id,kind,generation,state,created_at) SELECT $1,$2,'room',$3,'pending',$4 WHERE NOT EXISTS(SELECT 1 FROM preparation_operations WHERE target_id=$2 AND kind='room' AND generation=$3 AND state IN ('pending','working'))",
			[randomUUID(), r.id, r.generation, this.clock.now()]
		)
	}
	async presence(id: string, owner: string, value: boolean | (() => boolean), disconnectedAt?: number) {
		return this.repo.db.transaction(async (c) => {
			const r = await this.repo.room(c, id)
			const p = r.players.find((p) => p.id === owner && !p.left)
			check(p, 403, 'FORBIDDEN')
			const isClosed = () => r.status === 'closed'
			if (isClosed()) return
			const before = JSON.stringify(r)
			if (r.status === 'round-result') tick(r, this.clock.now())
			const reconciled = before !== JSON.stringify(r)
			if (r.status === 'loading') await this.enqueue(c, r)
			const connected = r.status !== 'closed' && (typeof value === 'function' ? value() : value)
			const changed = reconciled || p.connected !== connected
			p.connected = connected
			if (r.status !== 'closed') p.lastSeen = connected ? this.clock.now() : (disconnectedAt ?? this.clock.now())
			if (changed) {
				r.version++
				r.updatedAt = this.clock.now()
			}
			await this.repo.saveRoom(c, r, changed)
		})
	}
	async reconcile(restart = false) {
		const ids = (await this.repo.db.query<{ id: string }>("SELECT id FROM rooms WHERE status NOT IN ('closed','finished')")).rows
		for (const { id } of ids) {
			await this.repo.db.transaction(async (c) => {
				const r = await this.repo.room(c, id)
				if (restart) {
					for (const p of r.players)
						if (!p.left) {
							p.connected = false
							p.lastSeen = this.clock.now()
						}
				}
				const before = JSON.stringify(r)
				tick(r, this.clock.now())
				if (r.status === 'loading') await this.enqueue(c, r)
				if (restart || JSON.stringify(r) !== before) {
					r.version++
					r.updatedAt = this.clock.now()
					await this.repo.saveRoom(c, r)
				}
			})
		}
	}
	async expireMemberships() {
		const expired = (
			await this.repo.db.query<{ id: string }>('SELECT id FROM guest_sessions WHERE expires_at<=$1', [this.clock.now()])
		).rows
		for (const guest of expired) {
			const ids = (
				await this.repo.db.query<{ room_id: string }>('SELECT room_id FROM room_players WHERE player_id=$1 AND active', [
					guest.id
				])
			).rows
			for (const { room_id } of ids)
				await this.repo.db.transaction(async (c) => {
					const r = await this.repo.room(c, room_id)
					const p = r.players.find((p) => p.id === guest.id)
					if (p) {
						p.connected = false
						p.lastSeen = this.clock.now() - GRACE_MS
						leave(r, p.id, this.clock.now())
						r.version++
						await this.repo.saveRoom(c, r)
					}
				})
		}
	}
}
