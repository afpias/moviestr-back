import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { WebSocket, WebSocketServer } from 'ws'
import type { Server } from 'node:http'
import { z } from 'zod'
import { Database } from '../database/database'
import { SessionsService } from '../sessions/sessions'
import { RoomsService } from '../rooms/rooms.service'
import { checkOrigin, RateLimiter } from '../common/security'
import { AppError, requireCondition as check } from '../common/errors'
import { Clock } from '../common/clock'
import { randomUUID } from 'node:crypto'
const envelope = z
	.object({ event: z.string().max(40), data: z.record(z.string(), z.unknown()), requestId: z.string().max(128).optional() })
	.strict()
const empty = z.object({}).strict()
const roomData = z.object({ roomId: z.string().min(1).max(32) }).strict()
const authData = z.object({ ticket: z.string().min(20).max(128) }).strict()
interface Connection {
	id: string
	closed: boolean
	queued: number
	owner?: string
	scope?: string | null
	room?: string
	lobbies: boolean
	alive: boolean
	authTimer: ReturnType<typeof setTimeout>
	queue: Promise<void>
}
@Injectable()
export class RealtimeService implements OnModuleDestroy {
	private server?: WebSocketServer
	private states = new Map<WebSocket, Connection>()
	private limiter = new RateLimiter()
	private heartbeat?: ReturnType<typeof setInterval>
	private flushing = false
	private disconnects = new Map<string, { room: string; owner: string; at: number }>()
	constructor(
		@Inject(Database) private db: Database,
		@Inject(SessionsService) private sessions: SessionsService,
		@Inject(RoomsService) private rooms: RoomsService,
		@Inject(Clock) private clock: Clock
	) {}
	attach(http: Server) {
		this.server = new WebSocketServer({
			server: http,
			path: '/ws',
			maxPayload: 16384,
			verifyClient: (info, done) => {
				try {
					checkOrigin(info.origin || undefined)
					this.limiter.take(`connect:${info.req.socket.remoteAddress}`, 60)
					check(this.states.size < 1000, 429, 'RATE_LIMITED')
					done(true)
				} catch {
					done(false, 403, 'Forbidden')
				}
			}
		})
		this.server.on('connection', (ws: WebSocket) => {
			const state: Connection = {
				id: randomUUID(),
				closed: false,
				queued: 0,
				lobbies: false,
				alive: true,
				authTimer: setTimeout(() => ws.close(4401, 'Authentication timeout'), 5000),
				queue: Promise.resolve()
			}
			this.states.set(ws, state)
			ws.on('message', (raw: Buffer, isBinary: boolean) => {
				if (state.closed) return
				try {
					this.limiter.take(`message:${state.id}`, 120)
					check(state.queued < 32, 429, 'RATE_LIMITED')
				} catch (e) {
					this.error(ws, e)
					ws.close(4429, 'Rate limited')
					return
				}
				state.queued++
				state.queue = state.queue.then(async () => {
					try {
						if (state.closed) return
						check(!isBinary, 400, 'INVALID_MESSAGE')
						await this.handle(ws, state, raw)
					} catch (e) {
						this.error(ws, e)
					} finally {
						state.queued--
					}
				})
			})
			ws.on('pong', () => {
				if (state.closed) return
				state.alive = true
				if (state.owner && state.room)
					state.queue = state.queue
						.then(() => this.refresh(ws, state))
						.catch((e) => {
							if (e instanceof AppError && e.status === 401) ws.close(4401, 'Session expired')
						})
			})
			ws.on('close', () => {
				const disconnectedAt = this.clock.now()
				state.closed = true
				clearTimeout(state.authTimer)
				this.states.delete(ws)
				state.queue = state.queue
					.then(() => {
						if (state.owner && state.room) return this.disconnect(state.room, state.owner, disconnectedAt)
					})
					.catch(() => undefined)
			})
			ws.on('error', () => ws.terminate())
		})
		this.heartbeat = setInterval(() => {
			for (const [ws, state] of this.states) {
				if (!state.alive) {
					ws.terminate()
					continue
				}
				state.alive = false
				ws.ping()
			}
		}, 10000)
		this.heartbeat.unref()
	}
	private send(ws: WebSocket, event: string, data: unknown) {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, data }))
	}
	private error(ws: WebSocket, error: unknown, requestId?: string) {
		this.send(ws, 'session.error', {
			code: error instanceof AppError ? error.code : 'INVALID_MESSAGE',
			message: error instanceof AppError ? error.message : 'Некорректное сообщение',
			...(requestId ? { requestId } : {})
		})
	}
	private async valid(owner: string) {
		check(
			(await this.db.query('SELECT 1 FROM guest_sessions WHERE id=$1 AND expires_at>$2', [owner, Date.now()])).rowCount,
			401,
			'SESSION_EXPIRED'
		)
	}
	private async refresh(_ws: WebSocket, s: Connection) {
		if (s.closed) return
		await this.valid(s.owner!)
		if (s.closed || !s.room) return
		await this.rooms.presence(s.room, s.owner!, () => this.hasRoomSocket(s.owner!, s.room!))
	}
	private hasRoomSocket(owner: string, room: string) {
		return [...this.states.values()].some((s) => !s.closed && s.owner === owner && s.room === room)
	}
	private async disconnect(room: string, owner: string, at = this.clock.now()) {
		const key = `${room}:${owner}`,
			entry = { room, owner, at }
		this.disconnects.set(key, entry)
		try {
			await this.rooms.presence(room, owner, () => this.hasRoomSocket(owner, room), entry.at)
			if (this.disconnects.get(key) === entry) this.disconnects.delete(key)
		} catch (e) {
			if (e instanceof AppError && [403, 404].includes(e.status)) this.disconnects.delete(key)
		}
	}
	async reconcilePresence() {
		for (const [key, entry] of this.disconnects) {
			try {
				await this.rooms.presence(entry.room, entry.owner, () => this.hasRoomSocket(entry.owner, entry.room), entry.at)
				if (this.disconnects.get(key) === entry) this.disconnects.delete(key)
			} catch (e) {
				if (e instanceof AppError && [403, 404].includes(e.status)) this.disconnects.delete(key)
			}
		}
	}
	private async handle(ws: WebSocket, s: Connection, raw: Buffer) {
		let requestId: string | undefined
		try {
			const msg = envelope.parse(JSON.parse(raw.toString()) as unknown)
			requestId = msg.requestId
			if (msg.event === 'session.auth') {
				check(!s.owner, 409, 'ALREADY_AUTHENTICATED')
				const data = authData.parse(msg.data)
				const ticket = await this.sessions.consume(data.ticket)
				s.owner = ticket.owner
				s.scope = ticket.room_id
				clearTimeout(s.authTimer)
				this.send(ws, 'session.ready', { participantId: s.owner, serverTime: Date.now() })
				return
			}
			check(s.owner, 401, 'SESSION_REQUIRED')
			await this.valid(s.owner)
			if (s.closed) return
			if (msg.event === 'lobbies.subscribe') {
				empty.parse(msg.data)
				s.lobbies = true
				await this.lobbies(ws)
			} else if (msg.event === 'lobbies.unsubscribe') {
				empty.parse(msg.data)
				s.lobbies = false
			} else if (msg.event === 'room.subscribe') {
				const { roomId } = roomData.parse(msg.data)
				check(s.scope === roomId, 403, 'FORBIDDEN')
				await this.rooms.member(s.owner, roomId)
				if (s.closed) return
				s.room = roomId
				await this.rooms.presence(roomId, s.owner, () => this.hasRoomSocket(s.owner!, roomId))
				this.send(ws, 'room.snapshot', await this.rooms.member(s.owner, roomId))
			} else if (msg.event === 'room.unsubscribe') {
				empty.parse(msg.data)
				const old = s.room
				s.room = undefined
				if (old) await this.disconnect(old, s.owner)
			} else throw new AppError(400, 'UNKNOWN_EVENT')
		} catch (e) {
			this.error(ws, e, requestId)
		}
	}
	private async lobbies(ws: WebSocket) {
		const revision = (await this.db.query<{ revision: string }>('SELECT COALESCE(MAX(id),0)::text AS revision FROM event_outbox'))
			.rows[0]!.revision
		this.send(ws, 'lobbies.snapshot', { revision: Number(revision), serverTime: Date.now(), rooms: await this.rooms.list() })
	}
	async flush() {
		if (this.flushing) return
		this.flushing = true
		try {
			const events = (
				await this.db.query<{ id: string; aggregate_id: string }>(
					'SELECT id,aggregate_id FROM event_outbox WHERE NOT delivered ORDER BY id LIMIT 200'
				)
			).rows
			if (!events.length) return
			const changed = new Set(events.map((e) => e.aggregate_id))
			let retry = false
			for (const [ws, s] of this.states) {
				if (!s.owner) continue
				try {
					await this.valid(s.owner)
					if (s.room && changed.has(s.room)) this.send(ws, 'room.snapshot', await this.rooms.member(s.owner, s.room))
					if (s.lobbies) await this.lobbies(ws)
				} catch (e) {
					if (e instanceof AppError && e.status === 401) {
						this.error(ws, e)
						ws.close(4401, 'Session expired')
					} else if (e instanceof AppError && ['FORBIDDEN', 'ROOM_CLOSED', 'ROOM_NOT_FOUND'].includes(e.code)) {
						this.error(ws, e)
						const old = s.room
						s.room = undefined
						if (old) await this.disconnect(old, s.owner)
					} else {
						retry = true
						this.error(
							ws,
							new AppError(503, 'REALTIME_UNAVAILABLE', 'Временная ошибка доставки; snapshot будет отправлен повторно')
						)
					}
				}
			}
			if (!retry)
				await this.db.query('UPDATE event_outbox SET delivered=true WHERE id=ANY($1::bigint[])', [events.map((e) => e.id)])
		} finally {
			this.flushing = false
		}
	}
	async onModuleDestroy() {
		clearInterval(this.heartbeat)
		for (const [ws, s] of this.states) {
			clearTimeout(s.authTimer)
			ws.terminate()
		}
		this.states.clear()
		await new Promise<void>((resolve) => {
			if (this.server) this.server.close(() => resolve())
			else resolve()
		})
	}
}
