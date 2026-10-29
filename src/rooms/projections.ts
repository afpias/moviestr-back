import type { Room } from '../common/model'
export function lobbySummary(r: Room) {
	return {
		id: r.id,
		settings: { ...r.settings },
		playerCount: r.players.filter((p) => !p.left).length,
		hasPassword: r.passwordHash !== null
	}
}
export function roomSnapshot(r: Room, id: string, now: number) {
	const me = r.players.find((p) => p.id === id && !p.left)
	const max = Math.max(...r.players.map((p) => p.score))
	return {
		view: 'member' as const,
		id: r.id,
		settings: { ...r.settings },
		hostId: r.hostId,
		status: r.status,
		roundId: r.roundId,
		roundNumber: r.roundNumber,
		deadline: r.deadline,
		version: r.version,
		serverTime: now,
		players: r.players
			.filter((p) => r.status !== 'waiting' || !p.left)
			.map((p) => ({
				id: p.id,
				nickname: p.nickname,
				score: p.score,
				status: p.status,
				lastAnswer: p.lastAnswer,
				connected: p.connected,
				left: p.left
			})),
		currentFrame: r.status === 'playing' && me && me.status === 'playing' ? (r.movie?.frames[me.frameIndex] ?? null) : null,
		attemptedMovieIds: me ? [...me.attemptedMovieIds] : [],
		winnerIds: r.status === 'finished' ? r.players.filter((p) => p.score === max).map((p) => p.id) : [],
		error: r.error,
		result: r.status === 'finished' || r.status === 'round-result' ? (r.movie?.result ?? null) : null,
		roundResult:
			r.status === 'round-result' && me
				? {
						roundId: r.roundId,
						roundNumber: r.roundNumber,
						outcome: me.status === 'won' ? ('won' as const) : ('lost' as const),
						readyPlayerIds: [...r.roundReadyPlayerIds],
						requiredPlayerIds: [...r.roundRequiredPlayerIds],
						isReady: r.roundReadyPlayerIds.includes(id),
						canContinue: r.roundRequiredPlayerIds.includes(id) && !r.roundReadyPlayerIds.includes(id),
						isLastRound: r.roundNumber >= r.settings.filmCount
					}
				: null
	}
}
