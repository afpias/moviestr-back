import 'reflect-metadata'
import { beforeAll, afterAll, it, expect, vi } from 'vitest'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { createApp } from '../src/bootstrap'
import { Database } from '../src/database/database'
import { CatalogService } from '../src/catalog/catalog.service'
import { RoomsService } from '../src/rooms/rooms.service'
import { PreparationService } from '../src/scheduling/preparation.service'
import { testDatabaseUrl } from './database'
import { movie } from './fixtures'
let app: Awaited<ReturnType<typeof createApp>>
beforeAll(async () => {
	process.env.DATABASE_URL = testDatabaseUrl()
	app = await createApp({ scheduler: false })
	await app.get(Database).query('TRUNCATE guest_sessions,rooms,prepared_movies,event_outbox CASCADE')
})
afterAll(async () => {
	await app.close()
})
it('finishes two distinct films for four independent guests with tie winners and personal progress', async () => {
	const people = []
	for (let i = 0; i < 4; i++) {
		const agent = request.agent(app.getHttpServer())
		const r = await agent.post('/api/v1/guest-sessions').send({}).expect(201)
		people.push({ agent, id: r.body.participantId as string })
	}
	let sequence = 603
	vi.spyOn(app.get(CatalogService), 'prepare').mockImplementation(async (_d, _g, excluded) => {
		const selected = { ...structuredClone(movie), id: `tmdb-${sequence++}` }
		expect(excluded).not.toContain(selected.id)
		return selected
	})
	const first = people[0]!
	const created = await first.agent
		.post('/api/v1/rooms')
		.set('Idempotency-Key', randomUUID())
		.send({ nickname: 'Игрок 0', settings: { name: 'Полный матч', capacity: 4, filmCount: 2 } })
		.expect(201)
	const id = created.body.roomId as string
	for (let i = 1; i < 4; i++)
		await people[i]!.agent.post(`/api/v1/rooms/${id}/join`)
			.set('Idempotency-Key', randomUUID())
			.send({ nickname: `Игрок ${i}` })
			.expect(200)
	for (const p of people) await app.get(RoomsService).presence(id, p.id, true)
	await first.agent.post(`/api/v1/rooms/${id}/start`).set('Idempotency-Key', randomUUID()).send({}).expect(200)
	for (let round = 0; round < 2; round++) {
		await app.get(PreparationService).tick()
		const state = (await first.agent.get(`/api/v1/rooms/${id}`)).body
		expect(state.roundNumber).toBe(round + 1)
		for (const p of people)
			await p.agent
				.post(`/api/v1/rooms/${id}/guesses`)
				.set('Idempotency-Key', randomUUID())
				.send({ roundId: state.roundId, movieId: `tmdb-${603 + round}`, expectedFrameIndex: 0 })
				.expect(200)
	}
	const finished = (await first.agent.get(`/api/v1/rooms/${id}`)).body
	expect(finished.status).toBe('finished')
	expect(finished.players.map((p: { score: number }) => p.score)).toEqual([1200, 1200, 1200, 1200])
	expect(finished.winnerIds).toHaveLength(4)
	expect(finished.result.title).toBe(movie.result.title)
	expect(
		(await app.get(Database).query('SELECT count(*)::int AS n FROM room_used_movies WHERE room_id=$1', [id])).rows[0]?.n
	).toBe(2)
})
