import { randomUUID } from 'node:crypto'
import { AppError, requireCondition as check } from '../common/errors'
import type { Room, Settings, Player, PreparedMovie } from '../common/model'
export const ROUND_MS = 90000,
	GRACE_MS = 30000
function player(r: Room, id: string): Player {
	const p = r.players.find((p) => p.id === id && !p.left)
	check(p, 403, 'FORBIDDEN')
	return p
}
export function host(r: Room, id: string) {
	player(r, id)
	check(r.hostId === id, 403, 'FORBIDDEN')
}
export function newRoom(
	id: string,
	owner: string,
	settings: Settings,
	nickname: string,
	passwordHash: string | null,
	now: number
): Room {
	const r: Room = {
		id,
		settings: { ...settings },
		passwordHash,
		hostId: owner,
		players: [],
		status: 'waiting',
		roundId: randomUUID(),
		roundNumber: 0,
		deadline: null,
		movie: null,
		usedMovieIds: [],
		generation: 0,
		leaseUntil: null,
		error: null,
		version: 1,
		updatedAt: now
	}
	join(r, owner, nickname, now)
	return r
}
export function join(r: Room, id: string, nickname: string, now: number) {
	const existing = r.players.find((p) => p.id === id && !p.left)
	if (existing) {
		check(r.status !== 'closed', 409, 'ROOM_CLOSED')
		return
	}
	check(r.status === 'waiting', 409, 'ROOM_STARTED')
	check(r.players.filter((p) => !p.left).length < r.settings.capacity, 409, 'ROOM_FULL')
	check(
		!r.players.some((p) => !p.left && p.nickname.toLocaleLowerCase('ru-RU') === nickname.toLocaleLowerCase('ru-RU')),
		409,
		'NICKNAME_TAKEN'
	)
	r.players = r.players.filter((p) => p.id !== id)
	r.players.push({
		id,
		nickname,
		score: 1000,
		status: 'playing',
		frameIndex: 0,
		attemptedMovieIds: [],
		lastAnswer: null,
		connected: false,
		lastSeen: now,
		left: false,
		order: Math.max(0, ...r.players.map((p) => p.order)) + 1
	})
}
function preparing(r: Room) {
	r.status = 'loading'
	r.deadline = null
	r.movie = null
	r.roundId = randomUUID()
	r.generation++
	r.leaseUntil = null
	r.error = null
	for (const p of r.players) {
		p.status = p.left ? 'lost' : 'playing'
		p.frameIndex = 0
		p.attemptedMovieIds = []
		p.lastAnswer = null
	}
}
export function start(r: Room, id: string, _now: number) {
	host(r, id)
	check(r.status === 'waiting', 409, 'ROOM_STARTED')
	check(r.players.filter((p) => !p.left && p.connected).length >= 2, 409, 'NOT_ENOUGH_PLAYERS')
	r.players = r.players.filter((p) => !p.left)
	r.players.forEach((p) => {
		p.score = 1000
	})
	r.roundNumber = 1
	preparing(r)
}
export function publish(r: Room, movie: PreparedMovie, now: number) {
	check(r.status === 'loading', 409, 'STALE_PREPARATION')
	check(movie.frames.length === 5 && !r.usedMovieIds.includes(movie.id), 409, 'MOVIE_REPEATED')
	r.movie = movie
	r.usedMovieIds.push(movie.id)
	r.status = 'playing'
	r.deadline = now + ROUND_MS
	r.leaseUntil = null
	r.error = null
}
function advance(r: Room) {
	if (r.status !== 'playing' || r.players.some((p) => !p.left && p.status === 'playing')) return
	if (r.roundNumber >= r.settings.filmCount) {
		r.status = 'finished'
		r.deadline = null
	} else {
		r.roundNumber++
		preparing(r)
	}
}
export function tick(r: Room, now: number) {
	if (r.status === 'closed' || r.status === 'finished') return
	const current = r.players.filter((p) => !p.left && p.connected)
	const grace = r.players.some((p) => !p.left && now - p.lastSeen < GRACE_MS)
	if (r.status === 'waiting') for (const p of r.players) if (!p.connected && now - p.lastSeen >= GRACE_MS) p.left = true
	if (current.length === 0 && !grace) {
		r.status = 'closed'
		r.deadline = null
		r.generation++
		return
	}
	const old = r.players.find((p) => p.id === r.hostId && !p.left)
	if ((!old || (!old.connected && now - old.lastSeen >= GRACE_MS)) && current[0]) r.hostId = current[0].id
	if (r.status === 'playing' && r.deadline !== null && now >= r.deadline) {
		for (const p of r.players)
			if (!p.left && p.status === 'playing') {
				p.score -= 50
				p.status = 'lost'
				p.lastAnswer = 'incorrect'
			}
		advance(r)
	}
}
function active(r: Room, id: string, roundId: string, frame: number, now: number): Player {
	const p = player(r, id)
	if (r.status === 'playing' && r.deadline !== null && now >= r.deadline) {
		tick(r, now)
		throw new AppError(409, 'DEADLINE_EXCEEDED')
	}
	check(r.status === 'playing' && r.roundId === roundId, 409, 'STALE_ROUND')
	check(p.status === 'playing', 409, 'ROUND_FINISHED')
	check(p.frameIndex === frame, 409, 'FRAME_CONFLICT')
	return p
}
export function guess(r: Room, id: string, roundId: string, movieId: string, frame: number, now: number) {
	const p = active(r, id, roundId, frame, now)
	if (p.attemptedMovieIds.includes(movieId)) return
	check(r.movie, 503, 'MOVIE_NOT_READY')
	if (movieId === r.movie.id) {
		p.score += 100
		p.status = 'won'
		p.lastAnswer = 'correct'
	} else {
		p.attemptedMovieIds.push(movieId)
		p.score -= 50
		p.lastAnswer = 'incorrect'
		if (p.frameIndex === 4) p.status = 'lost'
		else p.frameIndex++
	}
	advance(r)
}
export function skip(r: Room, id: string, roundId: string, frame: number, now: number) {
	const p = active(r, id, roundId, frame, now)
	if (frame === 4) {
		p.status = 'lost'
		p.score -= 50
		p.lastAnswer = 'incorrect'
	} else p.frameIndex++
	advance(r)
}
export function leave(r: Room, id: string, now: number) {
	const p = player(r, id)
	p.left = true
	p.connected = false
	p.lastSeen = now - GRACE_MS
	if (r.status === 'playing' && p.status === 'playing') {
		p.status = 'lost'
		p.score -= 50
		p.lastAnswer = 'incorrect'
	}
	if (id === r.hostId) {
		const next = r.players.find((p) => !p.left && p.connected)
		if (next) r.hostId = next.id
	}
	advance(r)
	tick(r, now)
}
