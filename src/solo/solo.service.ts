import { Inject, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Repositories } from '../database/repositories'
import { CommandStore } from '../database/commands'
import { Clock } from '../common/clock'
import type { Difficulty, Genre, Solo } from '../common/model'
import { soloAction, soloSnapshot } from './rules'
import { requireCondition as check } from '../common/errors'
@Injectable()
export class SoloService {
	constructor(
		@Inject(Repositories) private repo: Repositories,
		@Inject(CommandStore) private commands: CommandStore,
		@Inject(Clock) private clock: Clock
	) {}
	create(owner: string, key: unknown, input: { difficulty: Difficulty; genre: Genre; collectionId: string }) {
		return this.commands.run(owner, 'POST /games', key, input, null, async (c) => {
			const now = this.clock.now(),
				id = randomUUID(),
				operationId = randomUUID()
			const game: Solo = {
				id,
				owner,
				difficulty: input.difficulty,
				genre: input.genre,
				status: 'loading',
				movie: null,
				frameIndex: 0,
				attemptedMovieIds: [],
				version: 1,
				updatedAt: now,
				operationId,
				generation: 1
			}
			await this.repo.saveSolo(c, game)
			await c.query(
				'INSERT INTO preparation_operations(id,owner,target_id,kind,generation,state,created_at) VALUES($1,$2,$3,$4,1,$5,$6)',
				[operationId, owner, id, 'solo', 'pending', now]
			)
			return { status: 202, body: { gameId: id, operationId, status: 'loading', version: 1, serverTime: now } }
		})
	}
	get(owner: string, id: string) {
		return this.repo.db.transaction(async (c) => soloSnapshot(await this.repo.solo(c, id, owner, false), this.clock.now()))
	}
	action(
		owner: string,
		id: string,
		key: unknown,
		input: { movieId?: string; expectedFrameIndex: number },
		kind: 'guesses' | 'skip'
	) {
		return this.commands.run(owner, `POST /games/${id}/${kind}`, key, input, id, async (c) => {
			const game = await this.repo.solo(c, id, owner)
			soloAction(game, input.movieId ?? null, input.expectedFrameIndex)
			game.version++
			game.updatedAt = this.clock.now()
			await this.repo.saveSolo(c, game)
			return {
				status: 200,
				body: {
					...soloSnapshot(game, this.clock.now()),
					...(kind === 'guesses' ? { correct: input.movieId === game.movie?.id } : {})
				}
			}
		})
	}
	retry(owner: string, id: string, key: unknown) {
		return this.commands.run(owner, `POST /games/${id}/retry-preparation`, key, {}, id, async (c) => {
			const g = await this.repo.solo(c, id, owner)
			check(g.status === 'error', 409, 'PREPARATION_NOT_FAILED')
			g.generation++
			g.version++
			g.status = 'loading'
			g.error = null
			g.updatedAt = this.clock.now()
			g.operationId = randomUUID()
			await this.repo.saveSolo(c, g)
			await c.query(
				'INSERT INTO preparation_operations(id,owner,target_id,kind,generation,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
				[g.operationId, owner, id, 'solo', g.generation, 'pending', g.updatedAt]
			)
			return {
				status: 202,
				body: { gameId: id, operationId: g.operationId, status: 'loading', version: g.version, serverTime: g.updatedAt }
			}
		})
	}
	async operation(owner: string, id: string) {
		const r = (
			await this.repo.db.query<{ id: string; target_id: string; state: string; error: string | null }>(
				'SELECT id,target_id,state,error FROM preparation_operations WHERE id=$1 AND owner=$2',
				[id, owner]
			)
		).rows[0]
		check(r, 404, 'OPERATION_NOT_FOUND')
		return { operationId: r.id, gameId: r.target_id, status: r.state === 'working' ? 'pending' : r.state, error: r.error }
	}
}
