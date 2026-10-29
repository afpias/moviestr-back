import 'reflect-metadata'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { createApp } from '../src/bootstrap'
import { Database } from '../src/database/database'
import { CatalogService } from '../src/catalog/catalog.service'
import { PreparationService } from '../src/scheduling/preparation.service'
import { RoomsService } from '../src/rooms/rooms.service'
import { SchedulerService } from '../src/scheduling/scheduler.service'
import { RealtimeService } from '../src/realtime/realtime.service'
import { Clock } from '../src/common/clock'
import { roomSnapshotSchema, serverEventSchema } from '../src/contracts/contracts'
import { testDatabaseUrl } from './database'
import { movie } from './fixtures'
type Guest = { id: string; cookie: string }
let app: Awaited<ReturnType<typeof createApp>>, db: Database, now: number
const sockets: WebSocket[] = []
beforeEach(async () => {
	process.env.DATABASE_URL = testDatabaseUrl()
	app = await createApp({ scheduler: false })
	db = app.get(Database)
	await db.query('TRUNCATE guest_sessions,rooms,prepared_movies,event_outbox CASCADE')
	await app.listen(0, '127.0.0.1')
	now = Date.now()
	vi.spyOn(app.get(Clock), 'now').mockImplementation(() => now)
	let serial = 603
	vi.spyOn(app.get(CatalogService), 'prepare').mockImplementation(async () => ({
		...structuredClone(movie),
		id: `tmdb-${serial++}`
	}))
})
afterEach(async () => {
	sockets.splice(0).forEach((s) => s.terminate())
	await app.close()
	vi.restoreAllMocks()
})
async function boot(): Promise<Guest> {
	const r = await request(app.getHttpServer()).post('/api/v1/guest-sessions').send({}).expect(201)
	return { id: r.body.participantId as string, cookie: String(r.headers['set-cookie']).split(';')[0]! }
}
function post(p: Guest, path: string, body: Record<string, unknown>, key = randomUUID()) {
	return request(app.getHttpServer()).post(path).set('Cookie', p.cookie).set('Idempotency-Key', key).send(body)
}
function get(p: Guest, path: string) {
	return request(app.getHttpServer()).get(path).set('Cookie', p.cookie)
}
async function room(count = 2, filmCount = 2) {
	const people: Guest[] = []
	for (let i = 0; i < count; i++) people.push(await boot())
	const a = people[0]!
	const r = await post(a, '/api/v1/rooms', {
		nickname: 'Host',
		settings: { name: 'Round result', capacity: count, filmCount }
	}).expect(201)
	const path = `/api/v1/rooms/${r.body.roomId as string}`
	for (let i = 1; i < count; i++) await post(people[i]!, path + '/join', { nickname: 'Guest ' + i }).expect(200)
	for (const p of people) await app.get(RoomsService).presence(r.body.roomId as string, p.id, true)
	await post(a, path + '/start', {}).expect(200)
	await app.get(PreparationService).tick()
	const state = (await get(a, path)).body
	return { people, a, b: people[1]!, path, id: r.body.roomId as string, roundId: state.roundId as string }
}
async function finish(r: Awaited<ReturnType<typeof room>>) {
	for (const p of r.people)
		await post(p, r.path + '/guesses', { roundId: r.roundId, movieId: movie.id, expectedFrameIndex: 0 }).expect(200)
}
async function connect(p: Guest, id: string) {
	const ticket = await post(p, '/api/v1/realtime-tickets', { roomId: id }).expect(201)
	const ws = new WebSocket(`ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/ws`, {
		origin: 'http://localhost:5173'
	})
	sockets.push(ws)
	const events: ReturnType<typeof serverEventSchema.parse>[] = []
	ws.on('message', (raw: Buffer) => events.push(serverEventSchema.parse(JSON.parse(raw.toString()))))
	const wait = async (predicate: (event: ReturnType<typeof serverEventSchema.parse>) => boolean) => {
		const end = Date.now() + 5000
		while (Date.now() < end) {
			const e = events.filter(predicate).at(-1)
			if (e) return e
			await new Promise((r) => setTimeout(r, 10))
		}
		throw Error('WS result timeout')
	}
	await new Promise<void>((resolve, reject) => {
		ws.once('open', resolve)
		ws.once('error', reject)
	})
	ws.send(JSON.stringify({ event: 'session.auth', data: { ticket: ticket.body.ticket } }))
	await wait((e) => e.event === 'session.ready')
	ws.send(JSON.stringify({ event: 'room.subscribe', data: { roomId: id } }))
	await wait((e) => e.event === 'room.snapshot')
	return { ws, wait }
}
it('persists reveal/ready across a new application and replays idempotently without extra versions or preparations', async () => {
	const r = await room(),
		outsider = await boot()
	await post(r.a, r.path + '/ready', { roundId: r.roundId }).expect(409)
	await post(r.a, r.path + '/guesses', { roundId: r.roundId, movieId: movie.id, expectedFrameIndex: 0 }).expect(200)
	expect((await get(r.a, r.path)).body.result).toBeNull()
	await post(r.b, r.path + '/guesses', { roundId: r.roundId, movieId: movie.id, expectedFrameIndex: 0 }).expect(200)
	const revealed = (await get(r.a, r.path)).body
	expect(roomSnapshotSchema.safeParse(revealed).success).toBe(true)
	expect(revealed.status).toBe('round-result')
	expect(revealed.roundResult.outcome).toBe('won')
	expect(revealed.result).toEqual(movie.result)
	expect(revealed.currentFrame).toBeNull()
	const preview = (await get(outsider, r.path)).body
	expect(preview.view).toBe('preview')
	expect(preview).not.toHaveProperty('result')
	expect(preview).not.toHaveProperty('roundResult')
	await post(outsider, r.path + '/ready', { roundId: r.roundId }).expect(403)
	await post(r.a, r.path + '/ready', { roundId: r.roundId, playerId: r.b.id }).expect(400)
	const key = randomUUID(),
		first = await post(r.a, r.path + '/ready', { roundId: r.roundId }, key).expect(200)
	const duplicate = await post(r.a, r.path + '/ready', { roundId: r.roundId }).expect(200)
	expect(duplicate.body.version).toBe(first.body.version)
	expect(duplicate.body.roundResult.readyPlayerIds).toEqual([r.a.id])
	await app.close()
	app = await createApp({ scheduler: false })
	db = app.get(Database)
	await app.get(SchedulerService).reconcileRestart()
	await app.listen(0, '127.0.0.1')
	const restored = (await get(r.a, r.path)).body
	expect(restored.status).toBe('round-result')
	expect(restored.roundId).toBe(r.roundId)
	expect(restored.result).toEqual(movie.result)
	expect(restored.roundResult.readyPlayerIds).toEqual([r.a.id])
	expect(restored.roundResult.requiredPlayerIds).toEqual([r.a.id, r.b.id])
	await post(r.b, r.path + '/ready', { roundId: r.roundId }).expect(200)
	const next = (await get(r.a, r.path)).body
	expect(next.status).toBe('loading')
	expect(next.roundNumber).toBe(2)
	expect(next.roundId).not.toBe(r.roundId)
	expect(next.result).toBeNull()
	expect((await post(r.a, r.path + '/ready', { roundId: r.roundId }, key).expect(200)).body).toEqual(first.body)
	await post(r.a, r.path + '/ready', { roundId: r.roundId }).expect(409)
	expect(
		(await db.query('SELECT count(*)::int AS n FROM preparation_operations WHERE target_id=$1 AND generation=2', [r.id])).rows[0]
			?.n
	).toBe(1)
})
it('serializes simultaneous acknowledgements and duplicate last-ready without double advancing or charging score', async () => {
	const r = await room()
	await finish(r)
	const key = randomUUID()
	const all = await Promise.all([
		post(r.a, r.path + '/ready', { roundId: r.roundId }),
		post(r.b, r.path + '/ready', { roundId: r.roundId }, key),
		post(r.b, r.path + '/ready', { roundId: r.roundId }, key)
	])
	expect(all.map((v) => v.status)).toEqual([200, 200, 200])
	expect(all[1]!.body).toEqual(all[2]!.body)
	const next = (await get(r.a, r.path)).body
	expect(next.status).toBe('loading')
	expect(next.roundNumber).toBe(2)
	expect(next.players.map((p: { score: number }) => p.score)).toEqual([1100, 1100])
	expect(
		(await db.query('SELECT count(*)::int AS n FROM preparation_operations WHERE target_id=$1 AND generation=2', [r.id])).rows[0]
			?.n
	).toBe(1)
})
it('keeps the last-film result until all ready and freezes guesses/skips without changing scores or version', async () => {
	const r = await room(2, 1)
	await finish(r)
	const before = (await get(r.a, r.path)).body
	await post(r.a, r.path + '/guesses', { roundId: r.roundId, movieId: 'tmdb-1', expectedFrameIndex: 0 }).expect(409)
	await post(r.a, r.path + '/skip', { roundId: r.roundId, expectedFrameIndex: 0 }).expect(409)
	expect((await get(r.a, r.path)).body.version).toBe(before.version)
	await post(r.a, r.path + '/ready', { roundId: r.roundId }).expect(200)
	expect((await get(r.a, r.path)).body.status).toBe('round-result')
	await post(r.b, r.path + '/ready', { roundId: r.roundId }).expect(200)
	const final = (await get(r.a, r.path)).body
	expect(final.status).toBe('finished')
	expect(final.winnerIds.sort()).toEqual([r.a.id, r.b.id].sort())
	expect(final.roundResult).toBeNull()
	await post(r.a, r.path + '/ready', { roundId: r.roundId }).expect(409)
	expect((await db.query('SELECT count(*)::int AS n FROM preparation_operations WHERE target_id=$1', [r.id])).rows[0]?.n).toBe(1)
})
it('scheduler commits a deadline reveal once and concurrent readiness cannot repeat the transition', async () => {
	const r = await room()
	const initial = (await get(r.a, r.path)).body
	now = initial.deadline
	vi.spyOn(app.get(PreparationService), 'tick').mockResolvedValue(undefined)
	await app.get(SchedulerService).tick()
	const revealed = (await get(r.a, r.path)).body
	expect(revealed.status).toBe('round-result')
	expect(revealed.players.map((p: { score: number }) => p.score)).toEqual([950, 950])
	expect(revealed.roundResult.outcome).toBe('lost')
	await app.get(SchedulerService).tick()
	expect((await get(r.a, r.path)).body.version).toBe(revealed.version)
	await Promise.all([
		post(r.a, r.path + '/ready', { roundId: r.roundId }).expect(200),
		post(r.b, r.path + '/ready', { roundId: r.roundId }).expect(200),
		app.get(SchedulerService).tick()
	])
	expect((await get(r.a, r.path)).body.roundNumber).toBe(2)
	expect(
		(await db.query('SELECT count(*)::int AS n FROM preparation_operations WHERE target_id=$1 AND generation=2', [r.id])).rows[0]
			?.n
	).toBe(1)
})
it('publishes versioned barrier shrink and late reconnect cannot reinsert a waived guest', async () => {
	const r = await room(3)
	await finish(r)
	await app.get(RoomsService).presence(r.id, r.b.id, false)
	const before = (await get(r.a, r.path)).body
	now += 30000
	await app.get(RoomsService).reconcile()
	const waived = (await get(r.a, r.path)).body
	expect(waived.version).toBeGreaterThan(before.version)
	expect(waived.roundResult.requiredPlayerIds).toEqual([r.a.id, r.people[2]!.id])
	await app.get(RoomsService).presence(r.id, r.b.id, true)
	const late = (await get(r.b, r.path)).body
	expect(late.roundResult.requiredPlayerIds).toEqual(waived.roundResult.requiredPlayerIds)
	expect(late.roundResult.canContinue).toBe(false)
	await post(r.b, r.path + '/ready', { roundId: r.roundId }).expect(403)
	await post(r.a, r.path + '/ready', { roundId: r.roundId }).expect(200)
	await post(r.people[2]!, r.path + '/ready', { roundId: r.roundId }).expect(200)
	expect((await get(r.a, r.path)).body.status).toBe('loading')
})
it('reconciles expired eligibility before a reconnect even when scheduler has not yet ticked', async () => {
	const r = await room(3)
	await finish(r)
	await app.get(RoomsService).presence(r.id, r.b.id, false)
	now += 30000
	await app.get(RoomsService).presence(r.id, r.b.id, true)
	const state = (await get(r.b, r.path)).body
	expect(state.roundResult.requiredPlayerIds).toEqual([r.a.id, r.people[2]!.id])
	expect(state.roundResult.canContinue).toBe(false)
})
it('reads old rooms without new JSON fields and keeps ready snapshots protected after leave', async () => {
	const r = await room()
	await db.query("UPDATE rooms SET data=data-'roundReadyPlayerIds'-'roundRequiredPlayerIds' WHERE id=$1", [r.id])
	expect((await get(r.a, r.path)).body.status).toBe('playing')
	await finish(r)
	const key = randomUUID()
	await post(r.a, r.path + '/ready', { roundId: r.roundId }, key).expect(200)
	await post(r.a, r.path + '/leave', {}).expect(200)
	await post(r.a, r.path + '/ready', { roundId: r.roundId }, key).expect(403)
	const remaining = (await get(r.b, r.path)).body
	expect(remaining.roundResult.requiredPlayerIds).toEqual([r.b.id])
	await post(r.b, r.path + '/ready', { roundId: r.roundId }).expect(200)
})
it('delivers personal result/readiness over native WS and restores it with new tickets after reconnect', async () => {
	const r = await room()
	const a = await connect(r.a, r.id),
		b = await connect(r.b, r.id)
	await post(r.a, r.path + '/guesses', { roundId: r.roundId, movieId: movie.id, expectedFrameIndex: 0 }).expect(200)
	await app.get(RealtimeService).flush()
	const personal = await a.wait(
		(e) => e.event === 'room.snapshot' && e.data.players.find((p) => p.id === r.a.id)?.status === 'won'
	)
	expect(personal.event === 'room.snapshot' && personal.data.result).toBeNull()
	for (let i = 0; i < 5; i++) await post(r.b, r.path + '/skip', { roundId: r.roundId, expectedFrameIndex: i }).expect(200)
	await app.get(RealtimeService).flush()
	const revealed = await b.wait((e) => e.event === 'room.snapshot' && e.data.status === 'round-result')
	expect(revealed.event === 'room.snapshot' && revealed.data.roundResult?.outcome).toBe('lost')
	await post(r.a, r.path + '/ready', { roundId: r.roundId }).expect(200)
	await app.get(RealtimeService).flush()
	const acknowledged = await b.wait(
		(e) => e.event === 'room.snapshot' && e.data.roundResult?.readyPlayerIds.includes(r.a.id) === true
	)
	expect(acknowledged.event === 'room.snapshot' && acknowledged.data.roundResult?.canContinue).toBe(true)
	a.ws.terminate()
	const resumed = await connect(r.a, r.id)
	const snapshot = await resumed.wait((e) => e.event === 'room.snapshot' && e.data.status === 'round-result')
	expect(snapshot.event === 'room.snapshot' && snapshot.data.roundResult?.isReady).toBe(true)
})

it('serializes grace expiry against the last required acknowledgement', async () => {
	const r = await room()
	await finish(r)
	await app.get(RoomsService).presence(r.id, r.b.id, false)
	now += 30000
	await Promise.all([post(r.a, r.path + '/ready', { roundId: r.roundId }).expect(200), app.get(RoomsService).reconcile()])
	const state = (await get(r.a, r.path)).body
	expect(state.status).toBe('loading')
	expect(state.roundNumber).toBe(2)
	expect(
		(await db.query('SELECT count(*)::int AS n FROM preparation_operations WHERE target_id=$1 AND generation=2', [r.id])).rows[0]
			?.n
	).toBe(1)
})
it('notifies native WS clients when grace shrinks the persisted required roster', async () => {
	const r = await room(3)
	const a = await connect(r.a, r.id),
		b = await connect(r.b, r.id)
	await finish(r)
	await app.get(RealtimeService).flush()
	const initial = (await get(r.a, r.path)).body
	b.ws.terminate()
	await new Promise((resolve) => setTimeout(resolve, 40))
	now += 30000
	await app.get(RoomsService).reconcile()
	await app.get(RealtimeService).flush()
	const update = await a.wait(
		(e) => e.event === 'room.snapshot' && e.data.version > initial.version && e.data.roundResult?.requiredPlayerIds.length === 2
	)
	expect(update.event === 'room.snapshot' && update.data.roundResult?.requiredPlayerIds).toEqual([r.a.id, r.people[2]!.id])
	const late = await connect(r.b, r.id)
	const restored = await late.wait((e) => e.event === 'room.snapshot' && e.data.status === 'round-result')
	expect(restored.event === 'room.snapshot' && restored.data.roundResult?.canContinue).toBe(false)
})
