import { testDatabaseUrl } from './database'
import 'reflect-metadata'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { WebSocket } from 'ws'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/bootstrap'
import { Database } from '../src/database/database'
import { RealtimeService } from '../src/realtime/realtime.service'
import { SchedulerService } from '../src/scheduling/scheduler.service'
import { PreparationService } from '../src/scheduling/preparation.service'
import { CatalogService } from '../src/catalog/catalog.service'
import { Clock } from '../src/common/clock'
import { movie } from './fixtures'

describe('native WS and restart', () => {
	let app: Awaited<ReturnType<typeof createApp>>, url: string
	const sockets: WebSocket[] = []
	beforeAll(async () => {
		process.env.DATABASE_URL = testDatabaseUrl()
		app = await createApp({ scheduler: false })
		await app.get(Database).query('TRUNCATE guest_sessions, rooms, prepared_movies, event_outbox CASCADE')
		await app.listen(0, '127.0.0.1')
		url = `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/ws`
		vi.spyOn(app.get(CatalogService), 'prepare').mockImplementation(async () => structuredClone(movie))
	})
	afterAll(async () => {
		sockets.forEach((s) => s.terminate())
		await app?.close()
	})
	async function boot() {
		const agent = request.agent(app.getHttpServer())
		const r = await agent.post('/api/v1/guest-sessions').send({})
		return { agent, id: r.body.participantId as string, cookie: String(r.headers['set-cookie']).split(';')[0]! }
	}
	function open() {
		const ws = new WebSocket(url, { origin: 'http://localhost:5173' })
		sockets.push(ws)
		return ws
	}
	function message(ws: WebSocket, event: string) {
		return new Promise<{ event: string; data: Record<string, unknown> }>((resolve, reject) => {
			const timer = setTimeout(() => {
				ws.off('message', listener)
				reject(new Error(`missing event ${event}`))
			}, 5000)
			const listener = (raw: Buffer) => {
				const m = JSON.parse(raw.toString()) as { event: string; data: Record<string, unknown> }
				if (m.event === event) {
					clearTimeout(timer)
					ws.off('message', listener)
					resolve(m)
				}
			}
			ws.on('message', listener)
		})
	}
	async function connect(agent: ReturnType<typeof request.agent>, roomId?: string) {
		const ticket = await agent
			.post('/api/v1/realtime-tickets')
			.send(roomId ? { roomId } : {})
			.expect(201)
		const ws = open()
		const ready = message(ws, 'session.ready')
		await new Promise<void>((resolve) => ws.once('open', resolve))
		ws.send(JSON.stringify({ event: 'session.auth', data: { ticket: ticket.body.ticket } }))
		await ready
		return { ws, ticket: ticket.body.ticket as string }
	}
	it('requires auth and consumes each ticket once', async () => {
		const a = await boot()
		const ws = open()
		const err = message(ws, 'session.error')
		await new Promise<void>((resolve) => ws.once('open', resolve))
		ws.send(JSON.stringify({ event: 'lobbies.subscribe', data: {} }))
		expect((await err).data.code).toBe('SESSION_REQUIRED')
		ws.terminate()
		const valid = await connect(a.agent)
		const second = open()
		const denied = message(second, 'session.error')
		await new Promise<void>((resolve) => second.once('open', resolve))
		second.send(JSON.stringify({ event: 'session.auth', data: { ticket: valid.ticket } }))
		expect((await denied).data.code).toBe('INVALID_TICKET')
	})
	it('personalizes snapshots, counts multiple sockets, transfers host and persists across restart', async () => {
		const a = await boot(),
			b = await boot()
		const r = await a.agent
			.post('/api/v1/rooms')
			.set('Idempotency-Key', randomUUID())
			.send({ nickname: 'Хост', settings: { name: 'WS матч', capacity: 2, filmCount: 2 } })
			.expect(201)
		const id = r.body.roomId as string
		await b.agent.post(`/api/v1/rooms/${id}/join`).set('Idempotency-Key', randomUUID()).send({ nickname: 'Гость' }).expect(200)
		const a1 = await connect(a.agent, id),
			a2 = await connect(a.agent, id),
			b1 = await connect(b.agent, id)
		for (const { ws } of [a1, a2, b1]) {
			const snap = message(ws, 'room.snapshot')
			ws.send(JSON.stringify({ event: 'room.subscribe', data: { roomId: id } }))
			await snap
		}
		await a.agent.post(`/api/v1/rooms/${id}/start`).set('Idempotency-Key', randomUUID()).send({}).expect(200)
		await app.get(PreparationService).tick()
		const state = await a.agent.get(`/api/v1/rooms/${id}`).expect(200)
		await a.agent
			.post(`/api/v1/rooms/${id}/guesses`)
			.set('Idempotency-Key', randomUUID())
			.send({ roundId: state.body.roundId, movieId: 'tmdb-1', expectedFrameIndex: 0 })
			.expect(200)
		const pending = message(b1.ws, 'room.snapshot')
		await app.get(RealtimeService).flush()
		const snapshot = (await pending).data
		expect((snapshot.currentFrame as { index: number }).index).toBe(0)
		expect(snapshot.attemptedMovieIds).toEqual([])
		expect(JSON.stringify(snapshot)).not.toContain('f1.jpg')
		a1.ws.terminate()
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect((await b.agent.get(`/api/v1/rooms/${id}`)).body.players.find((p: { id: string }) => p.id === a.id).connected).toBe(
			true
		)
		a2.ws.terminate()
		await new Promise((resolve) => setTimeout(resolve, 30))
		const fakeNow = Date.now() + 31000
		vi.spyOn(app.get(Clock), 'now').mockReturnValue(fakeNow)
		await app.get(SchedulerService).tick()
		expect((await b.agent.get(`/api/v1/rooms/${id}`)).body.hostId).toBe(b.id)
		b1.ws.terminate()
		await new Promise((resolve) => setTimeout(resolve, 30))
		await app.close()
		app = await createApp({ scheduler: false })
		await app.get(SchedulerService).reconcileRestart()
		await app.listen(0, '127.0.0.1')
		const resumed = await request(app.getHttpServer()).get(`/api/v1/rooms/${id}`).set('Cookie', b.cookie).expect(200)
		expect(resumed.body.players.find((p: { id: string }) => p.id === a.id).score).toBe(950)
		expect(resumed.body.status).toBe('playing')
	})
})
