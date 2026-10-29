import { expect, it } from 'vitest'
import { newRoom, join, start, publish, guess, skip, ready, tick, leave, GRACE_MS } from '../src/rooms/rules'
import { roomSnapshot } from '../src/rooms/projections'
import { movie } from './fixtures'
function game(filmCount = 2, count = 2) {
	const r = newRoom(
		'results',
		'a',
		{ name: 'Results', capacity: count, filmCount, difficulty: 'easy', genre: 'all', visibility: 'private', mode: 'points' },
		'Host',
		null,
		1000
	)
	for (const id of ['b', 'c'].slice(0, count - 1)) join(r, id, id + ' player', 1000)
	for (const p of r.players) p.connected = true
	start(r, 'a', 1000)
	publish(r, structuredClone(movie), 1000)
	return r
}
function done(r: ReturnType<typeof game>) {
	for (const p of r.players) guess(r, p.id, r.roundId, movie.id, 0, 1002)
}
it('holds the completed film and reveals the answer instead of immediately preparing the next film', () => {
	const r = game(),
		roundId = r.roundId
	guess(r, 'a', roundId, movie.id, 0, 1001)
	expect(roomSnapshot(r, 'a', 1001).result).toBeNull()
	expect(roomSnapshot(r, 'a', 1001).roundResult).toBeNull()
	guess(r, 'b', roundId, movie.id, 0, 1002)
	expect(r.status).toBe('round-result')
	expect(r.roundNumber).toBe(1)
	expect(r.roundId).toBe(roundId)
	expect(roomSnapshot(r, 'a', 1002).result).toEqual(movie.result)
	expect(roomSnapshot(r, 'a', 1002).currentFrame).toBeNull()
	ready(r, 'a', roundId, 1003)
	ready(r, 'a', roundId, 1004)
	expect(r.roundReadyPlayerIds).toEqual(['a'])
	expect(r.status).toBe('round-result')
	ready(r, 'b', roundId, 1005)
	expect(r.status).toBe('loading')
	expect(r.roundNumber).toBe(2)
	expect(r.roundId).not.toBe(roundId)
	expect(r.roundRequiredPlayerIds).toEqual([])
	expect(roomSnapshot(r, 'a', 1005).result).toBeNull()
})
it('holds the last film result before publishing the final rating', () => {
	const r = game(1)
	done(r)
	expect(r.status).toBe('round-result')
	expect(roomSnapshot(r, 'a', 1002).winnerIds).toEqual([])
	expect(roomSnapshot(r, 'a', 1002).roundResult).toMatchObject({
		outcome: 'won',
		isLastRound: true,
		isReady: false,
		canContinue: true
	})
	ready(r, 'a', r.roundId, 1003)
	expect(roomSnapshot(r, 'a', 1003).roundResult).toMatchObject({ isReady: true, canContinue: false })
	ready(r, 'b', r.roundId, 1004)
	expect(r.status).toBe('finished')
	expect(roomSnapshot(r, 'a', 1004).winnerIds).toEqual(['a', 'b'])
})
it('does not use an automatic result timeout or accept guesses/skips/foreign/stale readiness', () => {
	const r = game()
	expect(() => ready(r, 'a', r.roundId, 1001)).toThrow('ROUND_NOT_IN_RESULT')
	done(r)
	tick(r, 9999999)
	expect(r.status).toBe('round-result')
	const before = structuredClone(r)
	for (const action of [
		() => guess(r, 'a', r.roundId, movie.id, 0, 1003),
		() => skip(r, 'a', r.roundId, 0, 1003),
		() => ready(r, 'x', r.roundId, 1003),
		() => ready(r, 'a', 'old', 1003)
	])
		expect(action).toThrow()
	expect(r).toEqual(before)
})
it('reveals personal win/loss only after all finish and charges deadline exactly once', () => {
	const r = game()
	guess(r, 'a', r.roundId, movie.id, 0, 1001)
	expect(roomSnapshot(r, 'a', 1001).result).toBeNull()
	tick(r, 91000)
	expect(r.status).toBe('round-result')
	expect(r.players.map((p) => p.score)).toEqual([1100, 950])
	expect(roomSnapshot(r, 'a', 91000).roundResult?.outcome).toBe('won')
	expect(roomSnapshot(r, 'b', 91000).roundResult?.outcome).toBe('lost')
	tick(r, 991000)
	expect(r.players.map((p) => p.score)).toEqual([1100, 950])
	expect(r.status).toBe('round-result')
})
it('keeps offline guests in grace, then waives them and continues only when remaining players are ready', () => {
	const r = game()
	done(r)
	r.players[1]!.connected = false
	r.players[1]!.lastSeen = 1002
	ready(r, 'a', r.roundId, 1003)
	tick(r, 1002 + GRACE_MS - 1)
	expect(r.status).toBe('round-result')
	expect(r.roundRequiredPlayerIds).toEqual(['a', 'b'])
	tick(r, 1002 + GRACE_MS)
	expect(r.status).toBe('loading')
	expect(r.roundNumber).toBe(2)
})
it('never re-adds a waived late reconnect to the same barrier', () => {
	const r = game(2, 3)
	done(r)
	r.players[1]!.connected = false
	r.players[1]!.lastSeen = 1002
	tick(r, 1002 + GRACE_MS)
	expect(r.roundRequiredPlayerIds).toEqual(['a', 'c'])
	r.players[1]!.connected = true
	tick(r, 32003)
	expect(r.roundRequiredPlayerIds).toEqual(['a', 'c'])
	expect(() => ready(r, 'b', r.roundId, 32003)).toThrow('READY_NOT_REQUIRED')
	ready(r, 'a', r.roundId, 32004)
	ready(r, 'c', r.roundId, 32004)
	expect(r.status).toBe('loading')
})
it('explicit result leave does not block readiness or change the completed score', () => {
	const r = game(1)
	done(r)
	ready(r, 'b', r.roundId, 1003)
	const score = r.players[0]!.score
	leave(r, 'a', 1004)
	expect(r.status).toBe('finished')
	expect(r.players[0]!.score).toBe(score)
	expect(r.roundRequiredPlayerIds).toEqual(['b'])
})
it('closes an abandoned result instead of advancing an empty barrier', () => {
	const r = game()
	done(r)
	for (const p of r.players) {
		p.connected = false
		p.lastSeen = 1002
	}
	tick(r, 1002 + GRACE_MS)
	expect(r.status).toBe('closed')
	expect(r.roundNumber).toBe(1)
})
