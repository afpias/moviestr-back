import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Repositories } from '../database/repositories'
import { CatalogService } from '../catalog/catalog.service'
import { Clock } from '../common/clock'
import { publish } from '../rooms/rules'
import { AppError } from '../common/errors'
import type { Room, Solo } from '../common/model'
interface Operation {
	id: string
	owner: string | null
	target_id: string
	kind: 'solo' | 'room'
	generation: number
}
@Injectable()
export class PreparationService {
	private busy = false
	constructor(
		@Inject(Repositories) private repo: Repositories,
		@Inject(CatalogService) private catalog: CatalogService,
		@Inject(Clock) private clock: Clock
	) {}
	async tick() {
		if (this.busy) return
		this.busy = true
		try {
			for (let i = 0; i < 4; i++) {
				const claimed = await this.claim()
				if (!claimed) break
				await this.prepare(claimed)
			}
		} finally {
			this.busy = false
		}
	}
	private async claim() {
		return this.repo.db.transaction(async (c) => {
			const op = (
				await c.query<Operation>(
					"SELECT id,owner,target_id,kind,generation FROM preparation_operations WHERE state='pending' OR (state='working' AND lease_until<$1) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
					[this.clock.now()]
				)
			).rows[0]
			if (!op) return
			const lease = this.clock.now() + 120000,
				token = randomUUID()
			await c.query("UPDATE preparation_operations SET state='working',lease_until=$2,lease_token=$3 WHERE id=$1", [
				op.id,
				lease,
				token
			])
			return { ...op, lease, token }
		})
	}
	private async prepare(op: Operation & { lease: number; token: string }) {
		let failure: string | undefined
		let movie: Awaited<ReturnType<CatalogService['prepare']>> | undefined
		try {
			const config = await this.repo.db.transaction(async (c) => {
				if (op.kind === 'solo') {
					const g = await this.repo.solo(c, op.target_id, op.owner!, false)
					if (g.generation !== op.generation || g.status !== 'loading') return
					return { difficulty: g.difficulty, genre: g.genre, excluded: [] as string[] }
				}
				const r = await this.repo.room(c, op.target_id, false)
				if (r.generation !== op.generation || r.status !== 'loading') return
				return { difficulty: r.settings.difficulty, genre: r.settings.genre, excluded: r.usedMovieIds }
			})
			if (config) movie = await this.catalog.prepare(config.difficulty, config.genre, config.excluded)
			else failure = 'STALE_PREPARATION'
		} catch (e) {
			failure = e instanceof AppError ? e.code : 'PREPARATION_FAILED'
		}
		await this.repo.db.transaction(async (c) => {
			let solo: Solo | undefined, room: Room | undefined
			try {
				if (op.kind === 'solo') solo = await this.repo.solo(c, op.target_id, op.owner!)
				else room = await this.repo.room(c, op.target_id)
			} catch (e) {
				if (e instanceof AppError && ['GAME_NOT_FOUND', 'ROOM_NOT_FOUND'].includes(e.code)) failure = 'STALE_PREPARATION'
				else throw e
			}
			const current = (
				await c.query<{ state: string; lease_until: string; lease_token: string }>(
					'SELECT state,lease_until,lease_token FROM preparation_operations WHERE id=$1 FOR UPDATE',
					[op.id]
				)
			).rows[0]
			if (!current || current.state !== 'working' || current.lease_token !== op.token || Number(current.lease_until) !== op.lease)
				return
			if (this.clock.now() >= op.lease) {
				await c.query("UPDATE preparation_operations SET state='pending',lease_until=NULL,lease_token=NULL WHERE id=$1", [op.id])
				return
			}
			try {
				if (solo) {
					const g = solo
					if (g.status !== 'loading' || g.generation !== op.generation) failure = 'STALE_PREPARATION'
					else {
						g.status = movie ? 'playing' : 'error'
						g.error = failure ?? null
						g.movie = movie ?? null
						g.version++
						g.updatedAt = this.clock.now()
						await this.repo.saveSolo(c, g)
					}
				} else if (room) {
					const r = room
					if (r.status !== 'loading' || r.generation !== op.generation) failure = 'STALE_PREPARATION'
					else {
						if (movie) publish(r, movie, this.clock.now())
						else {
							r.status = 'error'
							r.error = failure ?? 'PREPARATION_FAILED'
						}
						r.version++
						r.updatedAt = this.clock.now()
						await this.repo.saveRoom(c, r)
					}
				}
			} catch (e) {
				if (e instanceof AppError && ['GAME_NOT_FOUND', 'ROOM_NOT_FOUND'].includes(e.code)) failure = 'STALE_PREPARATION'
				else throw e
			}
			await c.query('UPDATE preparation_operations SET state=$2,error=$3,lease_until=NULL,lease_token=NULL WHERE id=$1', [
				op.id,
				movie && !failure ? 'ready' : 'error',
				failure ?? null
			])
		})
	}
	async scheduleRooms() {
		await this.repo.db.transaction(async (c) => {
			const rows = (
				await c.query<{ id: string; data: { generation: number } }>("SELECT id,data FROM rooms WHERE status='loading'")
			).rows
			for (const r of rows)
				await c.query(
					"INSERT INTO preparation_operations(id,target_id,kind,generation,state,created_at) SELECT $1,$2,'room',$3,'pending',$4 WHERE NOT EXISTS(SELECT 1 FROM preparation_operations WHERE target_id=$2 AND kind='room' AND generation=$3 AND state IN ('pending','working'))",
					[randomUUID(), r.id, r.data.generation, this.clock.now()]
				)
		})
	}
}
