import { describe, expect, it } from 'vitest'
import { newRoom, join, start, publish, guess, skip, tick, leave, ready } from '../src/rooms/rules'
import { roomSnapshot } from '../src/rooms/projections'
import { soloAction, soloSnapshot } from '../src/solo/rules'
import type { PreparedMovie, Room, Solo } from '../src/common/model'

export const movie: PreparedMovie = {
	id: 'tmdb-603',
	aliases: ['Матрица', 'The Matrix'],
	result: {
		title: 'Матрица',
		originalTitle: 'The Matrix',
		posterUrl: 'https://image.tmdb.org/t/p/w780/poster.jpg',
		releaseYear: 1999
	},
	frames: Array.from({ length: 5 }, (_, index) => ({
		index,
		alt: `Кадр ${index + 1} из загаданного фильма`,
		url: `https://image.tmdb.org/t/p/w1280/f${index}.jpg`
	}))
}
const settings = {
	name: 'Комната',
	capacity: 2,
	filmCount: 2,
	difficulty: 'easy' as const,
	genre: 'all' as const,
	visibility: 'public' as const,
	mode: 'points' as const
}
function playing(): Room {
	const r = newRoom('room', 'a', settings, 'Аня', null, 100)
	join(r, 'b', 'Боря', 100)
	r.players.forEach((p) => {
		p.connected = true
	})
	start(r, 'a', 100)
	publish(r, movie, 100)
	return r
}
describe('authoritative multiplayer', () => {
	it('allows negative scores through a complete50-film match without repeated movies', () => {
		const r = playing()
		r.settings.filmCount = 50
		for (let round = 0; round < 50; round++) {
			if (round > 0) publish(r, { ...movie, id: `tmdb-${603 + round}` }, 100 + round)
			for (const id of ['a', 'b'])
				for (let frame = 0; frame < 5; frame++) guess(r, id, r.roundId, `tmdb-${9000 + frame}`, frame, 100 + round)
			for (const id of ['a', 'b']) ready(r, id, r.roundId, 100 + round)
		}
		expect(r.status).toBe('finished')
		expect(r.players.map((p) => p.score)).toEqual([-11500, -11500])
		expect(new Set(r.usedMovieIds).size).toBe(50)
	})
	it('does not count a waiting player evicted by grace as a match participant', () => {
		const r = newRoom('r', 'a', { ...settings, capacity: 3, filmCount: 1 }, 'Аня', null, 100)
		join(r, 'b', 'Боря', 100)
		join(r, 'c', 'Вера', 100)
		r.players[1]!.connected = true
		r.players[2]!.connected = true
		tick(r, 30101)
		start(r, 'b', 30102)
		publish(r, movie, 30102)
		tick(r, 120102)
		ready(r, 'b', r.roundId, 120103)
		ready(r, 'c', r.roundId, 120103)
		expect(roomSnapshot(r, 'b', 120103).players).toHaveLength(2)
		expect(roomSnapshot(r, 'b', 120103).winnerIds.sort()).toEqual(['b', 'c'])
	})
	it('shares movie but keeps frames and attempts personal; wrong then correct = 1050', () => {
		const r = playing()
		guess(r, 'a', r.roundId, 'tmdb-1', 0, 101)
		guess(r, 'a', r.roundId, movie.id, 1, 102)
		expect(r.players[0]?.score).toBe(1050)
		const b = roomSnapshot(r, 'b', 103)
		expect(b.currentFrame?.index).toBe(0)
		expect(b.attemptedMovieIds).toEqual([])
		expect(JSON.stringify(b)).not.toContain('Матрица')
		expect(JSON.stringify(b)).not.toContain('f1.jpg')
		expect(b.result).toBeNull()
	})
	it('deduplicates wrong IDs and rejects stale frame/round', () => {
		const r = playing()
		guess(r, 'a', r.roundId, 'tmdb-1', 0, 101)
		guess(r, 'a', r.roundId, 'tmdb-1', 1, 102)
		expect(r.players[0]?.score).toBe(950)
		expect(() => skip(r, 'a', r.roundId, 0, 103)).toThrow()
		expect(() => guess(r, 'a', 'old', 'tmdb-2', 1, 103)).toThrow()
	})
	it('charges five wrong guesses exactly five times, no extra surrender penalty', () => {
		const r = playing()
		for (let i = 0; i < 5; i++) guess(r, 'a', r.roundId, `tmdb-${i + 1}`, i, 101 + i)
		expect(r.players[0]?.score).toBe(750)
		expect(r.players[0]?.status).toBe('lost')
		tick(r, 90100)
		expect(r.players[0]?.score).toBe(750)
		expect(r.players[1]?.score).toBe(950)
		expect(r.status).toBe('round-result')
		ready(r, 'a', r.roundId, 90101)
		ready(r, 'b', r.roundId, 90101)
		expect(r.status).toBe('loading')
		expect(r.roundNumber).toBe(2)
	})
	it('free skips and surrender once; final tie has all winners', () => {
		const r = playing()
		r.settings.filmCount = 1
		for (const id of ['a', 'b']) for (let i = 0; i < 5; i++) skip(r, id, r.roundId, i, 101)
		for (const id of ['a', 'b']) ready(r, id, r.roundId, 102)
		expect(r.status).toBe('finished')
		const snap = roomSnapshot(r, 'a', 102)
		expect(snap.winnerIds).toEqual(['a', 'b'])
		expect(snap.result?.title).toBe('Матрица')
	})
	it('rejects guess at deadline and persists timeout in caller aggregate', () => {
		const r = playing()
		const error = (() => {
			try {
				guess(r, 'a', r.roundId, movie.id, 0, 90100)
			} catch (e) {
				return e
			}
		})()
		expect(error).toBeDefined()
		expect(r.players[0]?.score).toBe(950)
		expect(r.roundNumber).toBe(1)
		expect(r.status).toBe('round-result')
	})
	it('prevents reused movies and transfers host after grace', () => {
		const r = playing()
		r.players[0]!.connected = false
		r.players[0]!.lastSeen = 100
		tick(r, 30101)
		expect(r.hostId).toBe('b')
		tick(r, 90100)
		ready(r, 'b', r.roundId, 90101)
		expect(() => publish(r, movie, 90101)).toThrow()
		expect(r.roundNumber).toBe(2)
	})
	it('evicts waiting membership after grace and permits new join', () => {
		const r = newRoom('r', 'a', settings, 'Аня', null, 100)
		join(r, 'b', 'Боря', 100)
		r.players[1]!.connected = true
		tick(r, 30101)
		expect(r.players[0]?.left).toBe(true)
		join(r, 'c', 'АНЯ', 30102)
		expect(r.players.filter((p) => !p.left)).toHaveLength(2)
	})
	it('explicit leave surrenders and keeps score in final table', () => {
		const r = playing()
		leave(r, 'a', 102)
		expect(r.players[0]?.left).toBe(true)
		expect(r.players[0]?.score).toBe(950)
		expect(r.hostId).toBe('b')
	})
})
describe('solo', () => {
	function game(): Solo {
		return {
			id: 'game',
			owner: 'a',
			difficulty: 'easy',
			genre: 'all',
			status: 'playing',
			movie,
			frameIndex: 0,
			attemptedMovieIds: [],
			version: 1,
			updatedAt: 100,
			operationId: 'op',
			generation: 1
		}
	}
	it('matches by movie ID and restores attempted IDs, never title', () => {
		const g = game()
		soloAction(g, 'tmdb-1', 0)
		const s = soloSnapshot(g, 101)
		expect(s.attemptedMovieIds).toEqual(['tmdb-1'])
		expect(JSON.stringify(s)).not.toContain('Матрица')
		soloAction(g, movie.id, 1)
		expect(g.status).toBe('won')
		expect(soloSnapshot(g, 102)).toHaveProperty('result.title', 'Матрица')
	})
	it('last frame surrender and duplicate wrong guesses', () => {
		const g = game()
		soloAction(g, 'tmdb-1', 0)
		soloAction(g, 'tmdb-1', 1)
		expect(g.frameIndex).toBe(1)
		for (let i = 1; i < 5; i++) soloAction(g, null, i)
		expect(g.status).toBe('lost')
	})
})
