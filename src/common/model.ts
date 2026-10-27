export const difficulties = ['easy', 'medium', 'hard', 'expert', 'impossible'] as const
export const genres = ['all', 'action', 'comedy', 'drama', 'thriller', 'horror', 'science-fiction', 'animation'] as const
export type Difficulty = (typeof difficulties)[number]
export type Genre = (typeof genres)[number]
export interface Frame {
	index: number
	url: string
	alt: string
}
export interface Result {
	title: string
	originalTitle: string
	posterUrl: string
	releaseYear: number
}
export interface PreparedMovie {
	id: string
	aliases: string[]
	frames: Frame[]
	result: Result
}
export interface Settings {
	name: string
	capacity: number
	filmCount: number
	difficulty: Difficulty
	genre: Genre
	visibility: 'public' | 'private'
	mode: 'points'
}
export interface Player {
	id: string
	nickname: string
	score: number
	status: 'playing' | 'won' | 'lost'
	frameIndex: number
	attemptedMovieIds: string[]
	lastAnswer: 'correct' | 'incorrect' | null
	connected: boolean
	lastSeen: number
	left: boolean
	order: number
}
export type RoomStatus = 'waiting' | 'loading' | 'playing' | 'finished' | 'error' | 'closed'
export interface Room {
	id: string
	settings: Settings
	passwordHash: string | null
	hostId: string
	players: Player[]
	status: RoomStatus
	roundId: string
	roundNumber: number
	deadline: number | null
	movie: PreparedMovie | null
	usedMovieIds: string[]
	generation: number
	leaseUntil: number | null
	error: string | null
	version: number
	updatedAt: number
}
export interface Solo {
	id: string
	owner: string
	difficulty: Difficulty
	genre: Genre
	status: 'loading' | 'error' | 'playing' | 'won' | 'lost'
	movie: PreparedMovie | null
	frameIndex: number
	attemptedMovieIds: string[]
	version: number
	updatedAt: number
	operationId: string
	generation: number
	error?: string | null
}
export interface Suggestion {
	id: string
	title: string
	englishTitle: string
	releaseYear: number
}
