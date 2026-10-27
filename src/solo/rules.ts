import { requireCondition as check } from '../common/errors'
import type { Solo } from '../common/model'
export function soloAction(g: Solo, movieId: string | null, frame: number) {
	check(g.status === 'playing', 409, 'GAME_FINISHED')
	check(g.frameIndex === frame, 409, 'FRAME_CONFLICT')
	if (movieId && g.attemptedMovieIds.includes(movieId)) return
	check(g.movie, 503, 'MOVIE_NOT_READY')
	if (movieId === g.movie.id) {
		g.status = 'won'
		return
	}
	if (movieId) g.attemptedMovieIds.push(movieId)
	if (frame === 4) g.status = 'lost'
	else g.frameIndex++
}
export function soloSnapshot(g: Solo, now: number) {
	const base = {
		gameId: g.id,
		difficulty: g.difficulty,
		genre: g.genre,
		status: g.status,
		totalFrames: 5 as const,
		version: g.version,
		serverTime: now,
		attemptedMovieIds: [...g.attemptedMovieIds]
	}
	if (g.status === 'playing') return { ...base, currentFrame: g.movie!.frames[g.frameIndex] }
	if (g.status === 'won' || g.status === 'lost') return { ...base, result: g.movie!.result }
	return { ...base, operationId: g.operationId, error: g.error ?? null }
}
