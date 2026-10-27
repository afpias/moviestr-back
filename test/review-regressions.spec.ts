import 'reflect-metadata'
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/bootstrap'
import { Database } from '../src/database/database'
import { RoomsService } from '../src/rooms/rooms.service'
import { PreparationService } from '../src/scheduling/preparation.service'
import { CatalogService } from '../src/catalog/catalog.service'
import { RealtimeService } from '../src/realtime/realtime.service'
import { testDatabaseUrl } from './database'
import { movie } from './fixtures'
describe('final review regressions', () => {
	let app: Awaited<ReturnType<typeof createApp>>, db: Database, url: string
	const sockets: WebSocket[] = []
	beforeAll(async () => {
		process.env.DATABASE_URL = testDatabaseUrl()
		app = await createApp({ scheduler: false })
		db = app.get(Database)
		await db.query('TRUNCATE guest_sessions,rooms,prepared_movies,event_outbox CASCADE')
		await app.listen(0, '127.0.0.1')
		url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/ws`
	})
	afterEach(() => vi.restoreAllMocks())
	afterAll(async () => {
		sockets.forEach((s) => s.terminate())
		await app.close()
	})
	async function boot() {
		const agent = request.agent(app.getHttpServer())
		const r = await agent.post('/api/v1/guest-sessions').send({}).expect(201)
		return { agent, id: r.body.participantId as string }
	}
	async function room() {
		const a = await boot()
		const r = await a.agent
			.post('/api/v1/rooms')
			.set('Idempotency-Key', randomUUID())
			.send({ nickname: 'Аня', settings: { name: 'Review', capacity: 3, filmCount: 1 } })
			.expect(201)
		return { ...a, roomId: r.body.roomId as string }
	}
	function message(ws: WebSocket, event: string) {
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				ws.off('message', listener)
				reject(Error(`no ${event}`))
			}, 5000)
			const listener = (raw: Buffer) => {
				if ((JSON.parse(raw.toString()) as { event: string }).event === event) {
					clearTimeout(timer)
					ws.off('message', listener)
					resolve()
				}
			}
			ws.on('message', listener)
		})
	}
	async function auth(a: Awaited<ReturnType<typeof room>>) {
		const t = await a.agent.post('/api/v1/realtime-tickets').send({ roomId: a.roomId }).expect(201)
		const ws = new WebSocket(url, { origin: 'http://localhost:5173' })
		sockets.push(ws)
		const ready = message(ws, 'session.ready')
		await new Promise<void>((resolve) => ws.once('open', resolve))
		ws.send(JSON.stringify({ event: 'session.auth', data: { ticket: t.body.ticket } }))
		await ready
		return ws
	}
	it('never marks a closed-during-subscribe socket as connected', async () => {
		const a = await room(),
			ws = await auth(a),
			rooms = app.get(RoomsService),
			original = rooms.member.bind(rooms)
		let release: () => void = () => undefined,
			started: () => void = () => undefined
		const begun = new Promise<void>((r) => {
				started = r
			}),
			gate = new Promise<void>((r) => {
				release = r
			})
		vi.spyOn(rooms, 'member').mockImplementationOnce(async (...args) => {
			started()
			await gate
			return original(...args)
		})
		ws.send(JSON.stringify({ event: 'room.subscribe', data: { roomId: a.roomId } }))
		await begun
		const closed = new Promise<void>((r) => ws.once('close', () => r()))
		ws.terminate()
		await closed
		release()
		await new Promise((r) => setTimeout(r, 80))
		const state = (await a.agent.get(`/api/v1/rooms/${a.roomId}`)).body
		expect(state.players.find((p: { id: string }) => p.id === a.id).connected).toBe(false)
	})
	it('retains live subscription and retries outbox after one projection failure', async () => {
		const a = await room(),
			ws = await auth(a)
		let snapshot = message(ws, 'room.snapshot')
		ws.send(JSON.stringify({ event: 'room.subscribe', data: { roomId: a.roomId } }))
		await snapshot
		vi.spyOn(app.get(RoomsService), 'member').mockRejectedValueOnce(Error('temporary DB outage'))
		await app.get(RealtimeService).flush()
		expect(
			(await db.query('SELECT count(*)::int AS n FROM event_outbox WHERE aggregate_id=$1 AND NOT delivered', [a.roomId])).rows[0]
				?.n
		).toBeGreaterThan(0)
		snapshot = message(ws, 'room.snapshot')
		await app.get(RealtimeService).flush()
		await snapshot
		expect(
			(await a.agent.get(`/api/v1/rooms/${a.roomId}`)).body.players.find((p: { id: string }) => p.id === a.id).connected
		).toBe(true)
	})
	it('excludes pre-start leavers from persistent match roster and winners', async () => {
		const a = await room(),
			b = await boot(),
			c = await boot()
		for (const [p, name] of [
			[b, 'Боря'],
			[c, 'Вера']
		] as const)
			await p.agent
				.post(`/api/v1/rooms/${a.roomId}/join`)
				.set('Idempotency-Key', randomUUID())
				.send({ nickname: name })
				.expect(200)
		for (const p of [b, c]) await app.get(RoomsService).presence(a.roomId, p.id, true)
		await a.agent.post(`/api/v1/rooms/${a.roomId}/leave`).set('Idempotency-Key', randomUUID()).send({}).expect(200)
		await b.agent.post(`/api/v1/rooms/${a.roomId}/start`).set('Idempotency-Key', randomUUID()).send({}).expect(200)
		vi.spyOn(app.get(CatalogService), 'prepare').mockResolvedValue(structuredClone(movie))
		await app.get(PreparationService).tick()
		const state = (await b.agent.get(`/api/v1/rooms/${a.roomId}`)).body
		for (const p of [b, c])
			for (let i = 0; i < 5; i++)
				await p.agent
					.post(`/api/v1/rooms/${a.roomId}/skip`)
					.set('Idempotency-Key', randomUUID())
					.send({ roundId: state.roundId, expectedFrameIndex: i })
					.expect(200)
		const final = (await b.agent.get(`/api/v1/rooms/${a.roomId}`)).body
		expect(final.players).toHaveLength(2)
		expect(final.winnerIds.sort()).toEqual([b.id, c.id].sort())
		expect((await db.query('SELECT count(*)::int AS n FROM room_players WHERE room_id=$1', [a.roomId])).rows[0]?.n).toBe(2)
	})
	it('handles an idle pooled connection loss and recreates a working connection', async () => {
		expect(db.pool.listenerCount('error')).toBeGreaterThan(0)
		const victim = await db.pool.connect()
		const pid = (await victim.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
		victim.release()
		const admin = new Database()
		try {
			await admin.query('SELECT pg_terminate_backend($1)', [pid])
			await new Promise((r) => setTimeout(r, 30))
			expect((await db.query('SELECT 1 AS value')).rows[0]?.value).toBe(1)
		} finally {
			await admin.onModuleDestroy()
		}
	})
})
