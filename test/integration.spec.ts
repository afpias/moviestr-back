import { testDatabaseUrl } from './database'
import 'reflect-metadata'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { createApp } from '../src/bootstrap'
import { Database } from '../src/database/database'
import { CatalogService } from '../src/catalog/catalog.service'
import { PreparationService } from '../src/scheduling/preparation.service'
import { RoomsService } from '../src/rooms/rooms.service'
import { movie } from './fixtures'

describe('PostgreSQL HTTP integration', () => {
	let app: Awaited<ReturnType<typeof createApp>>
	let db: Database
	beforeAll(async () => {
		process.env.DATABASE_URL = testDatabaseUrl()
		app = await createApp({ scheduler: false })
		db = app.get(Database)
		await db.migrate()
		await db.query('TRUNCATE guest_sessions, rooms, prepared_movies, event_outbox CASCADE')
		await app.init()
		vi.spyOn(app.get(CatalogService), 'prepare').mockImplementation(async () => structuredClone(movie))
	})
	afterAll(async () => {
		await app?.close()
	})
	it('bootstraps opaque cookie, reuses guest, rejects bad origins', async () => {
		const a = request.agent(app.getHttpServer())
		const first = await a.post('/api/v1/guest-sessions').send({}).expect(201)
		expect(String(first.headers['set-cookie'])).toContain('HttpOnly')
		const second = await a.post('/api/v1/guest-sessions').send({}).expect(201)
		expect(second.body.participantId).toBe(first.body.participantId)
		await a.post('/api/v1/guest-sessions').set('Origin', 'https://evil.example').send({}).expect(403)
	})
	it('safe health and validation errors contain no secrets', async () => {
		await request(app.getHttpServer()).get('/health/ready').expect(200)
		const r = await request(app.getHttpServer()).post('/api/v1/realtime-tickets').send({ hostId: 'fake' }).expect(401)
		expect(r.body.code).toBe('SESSION_REQUIRED')
		expect(r.body).not.toHaveProperty('stack')
	})
	async function boot() {
		const agent = request.agent(app.getHttpServer())
		const r = await agent.post('/api/v1/guest-sessions').send({}).expect(201)
		return { agent, id: r.body.participantId as string }
	}
	it('persists solo, enforces ownership and deduplicates create/skip', async () => {
		const a = await boot(),
			b = await boot()
		const key = randomUUID()
		const input = { collectionId: 'tmdb-catalog', difficulty: 'easy', genre: 'all' }
		const first = await a.agent.post('/api/v1/games').set('Idempotency-Key', key).send(input).expect(202)
		const replay = await a.agent.post('/api/v1/games').set('Idempotency-Key', key).send(input).expect(202)
		expect(replay.body).toEqual(first.body)
		await a.agent
			.post('/api/v1/games')
			.set('Idempotency-Key', key)
			.send({ ...input, difficulty: 'hard' })
			.expect(409)
		await app.get(PreparationService).tick()
		const game = first.body.gameId
		await b.agent.get(`/api/v1/games/${game}`).expect(404)
		const active = await a.agent.get(`/api/v1/games/${game}`).expect(200)
		expect(active.body.status).toBe('playing')
		expect(JSON.stringify(active.body)).not.toContain('Матрица')
		const skipKey = randomUUID()
		const skips = await Promise.all(
			[1, 2].map(() => a.agent.post(`/api/v1/games/${game}/skip`).set('Idempotency-Key', skipKey).send({ expectedFrameIndex: 0 }))
		)
		expect(skips.every((s) => s.status === 200)).toBe(true)
		expect(skips[0]?.body).toEqual(skips[1]?.body)
		await a.agent
			.post(`/api/v1/games/${game}/skip`)
			.set('Idempotency-Key', randomUUID())
			.send({ expectedFrameIndex: 0 })
			.expect(409)
		const win = await a.agent
			.post(`/api/v1/games/${game}/guesses`)
			.set('Idempotency-Key', randomUUID())
			.send({ movieId: movie.id, expectedFrameIndex: 1 })
			.expect(200)
		expect(win.body.status).toBe('won')
		expect(win.body.correct).toBe(true)
	})
	it('last slot race, privacy, password, host rights and personal score', async () => {
		const a = await boot(),
			b = await boot(),
			c = await boot()
		const created = await a.agent
			.post('/api/v1/rooms')
			.set('Idempotency-Key', randomUUID())
			.send({
				nickname: 'Хост',
				password: 'pass',
				settings: { name: 'Закрытая', capacity: 2, filmCount: 1, visibility: 'private' }
			})
			.expect(201)
		const id = created.body.roomId
		const preview = await b.agent.get(`/api/v1/rooms/${id}`).expect(200)
		expect(preview.body.view).toBe('preview')
		expect(preview.body).not.toHaveProperty('players')
		const list = await b.agent.get('/api/v1/rooms').expect(200)
		expect(list.body.some((r: { id: string }) => r.id === id)).toBe(false)
		await b.agent
			.post(`/api/v1/rooms/${id}/join`)
			.set('Idempotency-Key', randomUUID())
			.send({ nickname: 'Гость', password: 'bad' })
			.expect(403)
		const races = await Promise.all(
			[b, c].map((p, i) =>
				p.agent
					.post(`/api/v1/rooms/${id}/join`)
					.set('Idempotency-Key', randomUUID())
					.send({ nickname: `Гость ${i}`, password: 'pass' })
			)
		)
		expect(races.map((r) => r.status).sort()).toEqual([200, 409])
		const winner = races[0]?.status === 200 ? b : c,
			loser = winner === b ? c : b
		await app.get(RoomsService).presence(id, a.id, true)
		await app.get(RoomsService).presence(id, winner.id, true)
		await winner.agent.post(`/api/v1/rooms/${id}/start`).set('Idempotency-Key', randomUUID()).send({}).expect(403)
		const starts = await Promise.all(
			[1, 2].map(() => a.agent.post(`/api/v1/rooms/${id}/start`).set('Idempotency-Key', randomUUID()).send({}))
		)
		expect(starts.map((r) => r.status).sort()).toEqual([200, 409])
		await app.get(PreparationService).tick()
		const playing = await a.agent.get(`/api/v1/rooms/${id}`).expect(200)
		const roundId = playing.body.roundId
		await loser.agent
			.post(`/api/v1/rooms/${id}/guesses`)
			.set('Idempotency-Key', randomUUID())
			.send({ roundId, movieId: movie.id, expectedFrameIndex: 0 })
			.expect(403)
		await a.agent
			.post(`/api/v1/rooms/${id}/guesses`)
			.set('Idempotency-Key', randomUUID())
			.send({ roundId, movieId: 'tmdb-1', expectedFrameIndex: 0 })
			.expect(200)
		const correct = await a.agent
			.post(`/api/v1/rooms/${id}/guesses`)
			.set('Idempotency-Key', randomUUID())
			.send({ roundId, movieId: movie.id, expectedFrameIndex: 1 })
			.expect(200)
		expect(correct.body.players.find((p: { id: string }) => p.id === a.id).score).toBe(1050)
		const personal = await winner.agent.get(`/api/v1/rooms/${id}`).expect(200)
		expect(personal.body.currentFrame.index).toBe(0)
		expect(personal.body.attemptedMovieIds).toEqual([])
		expect(JSON.stringify(personal.body)).not.toContain('Матрица')
	})
})
