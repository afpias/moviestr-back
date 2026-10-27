import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { openapi, serverEventSchema, gameResponseSchema } from '../src/contracts/contracts'
import { soloSnapshot } from '../src/solo/rules'
import { movie } from './fixtures'
describe('published contracts', () => {
	it('validates every WS documentation example against client/server schemas', async () => {
		const { clientEventSchema } = await import('../src/contracts/contracts')
		const docs = await readFile('docs/api/websocket.md', 'utf8')
		const examples = [...docs.matchAll(/```json\s*([\s\S]*?)```/g)]
		expect(examples.length).toBeGreaterThan(5)
		for (const example of examples) {
			const data = JSON.parse(example[1]!) as unknown
			expect(clientEventSchema.safeParse(data).success || serverEventSchema.safeParse(data).success).toBe(true)
		}
	})
	it('exports deterministic OpenAPI with protected operations and idempotency', async () => {
		const stored = JSON.parse(await readFile('docs/api/openapi.json', 'utf8')) as unknown
		expect(stored).toEqual(openapi)
		expect(openapi.openapi).toBe('3.1.0')
		expect(openapi.paths['/api/v1/games']?.post?.responses).toHaveProperty('202')
		for (const [path, methods] of Object.entries(openapi.paths)) {
			if (path.includes('games') || path.includes('rooms'))
				for (const [method, operation] of Object.entries(methods)) {
					if (method === 'post') expect(operation.parameters?.some((p) => p.name === 'Idempotency-Key' && p.required)).toBe(true)
				}
		}
	})
	it('accepts only explicitly projected server events', () => {
		const base = {
			gameId: '00000000-0000-4000-8000-000000000001',
			owner: 'a',
			id: '00000000-0000-4000-8000-000000000001',
			difficulty: 'easy' as const,
			genre: 'all' as const,
			status: 'playing' as const,
			movie,
			frameIndex: 0,
			attemptedMovieIds: [],
			version: 1,
			updatedAt: 1,
			operationId: '00000000-0000-4000-8000-000000000002',
			generation: 1
		}
		const projected = soloSnapshot(base, 1)
		expect(gameResponseSchema.safeParse(projected).success).toBe(true)
		expect(gameResponseSchema.safeParse({ ...projected, answer: 'Матрица' }).success).toBe(false)
		expect(serverEventSchema.safeParse({ event: 'session.ready', data: { participantId: base.id, serverTime: 1 } }).success).toBe(
			true
		)
		expect(
			serverEventSchema.safeParse({ event: 'session.ready', data: { participantId: base.id, serverTime: 1, token: 'secret' } })
				.success
		).toBe(false)
	})
})
