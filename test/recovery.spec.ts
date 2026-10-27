import { testDatabaseUrl } from './database'
import 'reflect-metadata'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { createApp } from '../src/bootstrap'
import { Database } from '../src/database/database'
import { CatalogService } from '../src/catalog/catalog.service'
import { PreparationService } from '../src/scheduling/preparation.service'
import { RoomsService } from '../src/rooms/rooms.service'
import { Repositories } from '../src/database/repositories'
import { Clock } from '../src/common/clock'
import { AppError } from '../src/common/errors'
import { movie } from './fixtures'
describe('PostgreSQL concurrency and recovery', () => {
	let app: Awaited<ReturnType<typeof createApp>>, db: Database, prepare: PreparationService
	beforeAll(async () => {
		process.env.DATABASE_URL = testDatabaseUrl()
		app = await createApp({ scheduler: false })
		db = app.get(Database)
		prepare = app.get(PreparationService)
		await db.query('TRUNCATE guest_sessions, rooms, prepared_movies, event_outbox CASCADE')
	})
	afterAll(async () => {
		await app.close()
	})
	async function boot() {
		const agent = request.agent(app.getHttpServer())
		const r = await agent.post('/api/v1/guest-sessions').send({}).expect(201)
		return { agent, id: r.body.participantId as string, cookie: String(r.headers['set-cookie']).split(';')[0]! }
	}
	async function game() {
		const a = await boot()
		const key = randomUUID()
		const r = await a.agent.post('/api/v1/games').set('Idempotency-Key', key).send({ difficulty: 'easy' }).expect(202)
		return { ...a, key, gameId: r.body.gameId as string, operationId: r.body.operationId as string }
	}
	it('expired session has no access and invalid requests cause no attempt', async () => {
		const a = await game()
		vi.spyOn(app.get(CatalogService), 'prepare').mockResolvedValue(structuredClone(movie))
		await prepare.tick()
		await a.agent
			.post(`/api/v1/games/${a.gameId}/guesses`)
			.set('Idempotency-Key', randomUUID())
			.send({ movieId: 'The Matrix', expectedFrameIndex: 0 })
			.expect(400)
		expect((await a.agent.get(`/api/v1/games/${a.gameId}`)).body.currentFrame.index).toBe(0)
		await db.query('UPDATE guest_sessions SET expires_at=$2 WHERE id=$1', [a.id, Date.now() - 1])
		await a.agent.get(`/api/v1/games/${a.gameId}`).expect(401)
	})
	it('keeps failed operation immutable and retries using new operation on same game', async () => {
		const a = await game()
		const spy = vi.spyOn(app.get(CatalogService), 'prepare').mockRejectedValue(new AppError(502, 'UPSTREAM_ERROR'))
		await prepare.tick()
		expect((await a.agent.get(`/api/v1/operations/${a.operationId}`)).body.status).toBe('error')
		const retries = await Promise.all(
			[1, 2].map(() => a.agent.post(`/api/v1/games/${a.gameId}/retry-preparation`).set('Idempotency-Key', randomUUID()).send({}))
		)
		expect(retries.map((r) => r.status).sort()).toEqual([202, 409])
		spy.mockResolvedValue(structuredClone(movie))
		await prepare.tick()
		expect((await a.agent.get(`/api/v1/operations/${a.operationId}`)).body.status).toBe('error')
		expect((await a.agent.get(`/api/v1/games/${a.gameId}`)).body.status).toBe('playing')
		const replay = await a.agent.post('/api/v1/games').set('Idempotency-Key', a.key).send({ difficulty: 'easy' }).expect(202)
		expect(replay.body.operationId).toBe(a.operationId)
	})
	it('fences late worker output after game generation changes', async () => {
		const a = await game()
		let release: (m: typeof movie) => void = () => undefined
		let started: () => void = () => undefined
		const begun = new Promise<void>((r) => {
			started = r
		})
		vi.spyOn(app.get(CatalogService), 'prepare').mockImplementation(() => {
			started()
			return new Promise((r) => {
				release = r
			})
		})
		const working = prepare.tick()
		await begun
		await db.query(
			"UPDATE solo_games SET data=jsonb_set(jsonb_set(data,'{generation}',to_jsonb(2)),'{status}','\"error\"') WHERE id=$1",
			[a.gameId]
		)
		release(structuredClone(movie))
		await working
		expect((await a.agent.get(`/api/v1/games/${a.gameId}`)).body.status).toBe('error')
		expect((await a.agent.get(`/api/v1/operations/${a.operationId}`)).body.error).toBe('STALE_PREPARATION')
	})
	it('serializes different-key skips on same frame', async () => {
		const a = await game()
		vi.spyOn(app.get(CatalogService), 'prepare').mockResolvedValue(structuredClone(movie))
		await prepare.tick()
		const results = await Promise.all(
			[1, 2].map(() =>
				a.agent.post(`/api/v1/games/${a.gameId}/skip`).set('Idempotency-Key', randomUUID()).send({ expectedFrameIndex: 0 })
			)
		)
		expect(results.map((r) => r.status).sort()).toEqual([200, 409])
		expect((await a.agent.get(`/api/v1/games/${a.gameId}`)).body.currentFrame.index).toBe(1)
	})
	it('checks deadline after lock and commits timeout despite rejected guess', async () => {
		const a = await boot(),
			b = await boot()
		const r = await a.agent
			.post('/api/v1/rooms')
			.set('Idempotency-Key', randomUUID())
			.send({ nickname: 'Аня', settings: { name: 'Deadline', filmCount: 1 } })
			.expect(201)
		const id = r.body.roomId as string
		await b.agent.post(`/api/v1/rooms/${id}/join`).set('Idempotency-Key', randomUUID()).send({ nickname: 'Боря' }).expect(200)
		const rooms = app.get(RoomsService)
		await rooms.presence(id, a.id, true)
		await rooms.presence(id, b.id, true)
		await a.agent.post(`/api/v1/rooms/${id}/start`).set('Idempotency-Key', randomUUID()).send({}).expect(200)
		vi.spyOn(app.get(CatalogService), 'prepare').mockResolvedValue(structuredClone(movie))
		await prepare.tick()
		const state = (await a.agent.get(`/api/v1/rooms/${id}`)).body
		const blocker = await db.pool.connect()
		await blocker.query('BEGIN')
		await blocker.query('SELECT 1 FROM rooms WHERE id=$1 FOR UPDATE', [id])
		let now = Date.now()
		vi.spyOn(app.get(Clock), 'now').mockImplementation(() => now)
		const pending = a.agent
			.post(`/api/v1/rooms/${id}/guesses`)
			.set('Idempotency-Key', randomUUID())
			.send({ roundId: state.roundId, movieId: movie.id, expectedFrameIndex: 0 })
			.then((res) => res)
		await new Promise((resolve) => setTimeout(resolve, 30))
		now = state.deadline
		await blocker.query('COMMIT')
		blocker.release()
		expect((await pending).status).toBe(409)
		const final = (await a.agent.get(`/api/v1/rooms/${id}`)).body
		expect(final.status).toBe('finished')
		expect(final.players.map((p: { score: number }) => p.score)).toEqual([950, 950])
		expect(
			(await db.query('SELECT count(*)::int AS n FROM event_outbox WHERE aggregate_id=$1 AND NOT delivered', [id])).rows[0]?.n
		).toBeGreaterThan(0)
		vi.restoreAllMocks()
	})
	it('stores dedup create outcomes with parent lifetime', async () => {
		const a = await game()
		const row = (
			await db.query<{ aggregate_id: string | null }>(
				'SELECT aggregate_id FROM command_deduplication WHERE owner=$1 AND key=$2',
				[a.id, a.key]
			)
		).rows[0]
		expect(row?.aggregate_id).toBe(a.gameId)
	})
	it('does not replay privileged snapshots after participant leaves', async () => {
		const a = await boot(),
			b = await boot()
		const r = await a.agent
			.post('/api/v1/rooms')
			.set('Idempotency-Key', randomUUID())
			.send({ nickname: 'Хост', settings: { name: 'Replay', filmCount: 1 } })
			.expect(201)
		const id = r.body.roomId
		await b.agent.post(`/api/v1/rooms/${id}/join`).set('Idempotency-Key', randomUUID()).send({ nickname: 'Гость' }).expect(200)
		await app.get(RoomsService).presence(id, a.id, true)
		await app.get(RoomsService).presence(id, b.id, true)
		const key = randomUUID()
		await a.agent.post(`/api/v1/rooms/${id}/start`).set('Idempotency-Key', key).send({}).expect(200)
		await a.agent.post(`/api/v1/rooms/${id}/leave`).set('Idempotency-Key', randomUUID()).send({}).expect(200)
		await a.agent.post(`/api/v1/rooms/${id}/start`).set('Idempotency-Key', key).send({}).expect(403)
	})
	it('read projections hold shared root lock to avoid mixed round state', async () => {
		const a = await game()
		vi.spyOn(app.get(CatalogService), 'prepare').mockResolvedValue(structuredClone(movie))
		await prepare.tick()
		const c = await db.pool.connect()
		await c.query('BEGIN')
		await app.get(Repositories).solo(c, a.gameId, a.id, false)
		const another = await db.pool.connect()
		await another.query('BEGIN')
		await another.query("SET LOCAL lock_timeout='30ms'")
		await expect(another.query('UPDATE solo_games SET updated_at=updated_at WHERE id=$1', [a.gameId])).rejects.toHaveProperty(
			'code',
			'55P03'
		)
		await another.query('ROLLBACK')
		another.release()
		await c.query('COMMIT')
		c.release()
	})
})
