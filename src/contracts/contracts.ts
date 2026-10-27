import { z } from 'zod'
import {
	settingsSchema,
	createGameSchema,
	createRoomSchema,
	joinSchema,
	guessSchema,
	skipSchema,
	roomGuessSchema,
	roomSkipSchema,
	emptySchema,
	ticketSchema,
	difficultySchema,
	genreSchema,
	movieIdSchema
} from '../common/schemas'
const uuid = z.uuid(),
	time = z.number().int().nonnegative(),
	version = z.number().int().positive()
const frameSchema = z.object({ index: z.number().int().min(0).max(4), alt: z.string(), url: z.url() }).strict()
const resultSchema = z
	.object({ title: z.string(), originalTitle: z.string(), posterUrl: z.url(), releaseYear: z.number().int() })
	.strict()
const gameBase = z
	.object({
		gameId: uuid,
		difficulty: difficultySchema,
		genre: genreSchema,
		totalFrames: z.literal(5),
		version,
		serverTime: time,
		attemptedMovieIds: z.array(movieIdSchema)
	})
	.strict()
export const gameResponseSchema = z.discriminatedUnion('status', [
	gameBase.extend({ status: z.literal('playing'), currentFrame: frameSchema }),
	gameBase.extend({ status: z.literal('won'), result: resultSchema }),
	gameBase.extend({ status: z.literal('lost'), result: resultSchema }),
	gameBase.extend({ status: z.literal('loading'), operationId: uuid, error: z.string().nullable() }),
	gameBase.extend({ status: z.literal('error'), operationId: uuid, error: z.string().nullable() })
])
const pendingSchema = z
	.object({ gameId: uuid, operationId: uuid, status: z.literal('loading'), version, serverTime: time })
	.strict()
const guessResponseSchema = z.discriminatedUnion('status', [
	gameBase.extend({ status: z.literal('playing'), currentFrame: frameSchema, correct: z.literal(false) }),
	gameBase.extend({ status: z.literal('won'), result: resultSchema, correct: z.literal(true) }),
	gameBase.extend({ status: z.literal('lost'), result: resultSchema, correct: z.literal(false) })
])
const playerSchema = z
	.object({
		id: uuid,
		nickname: z.string(),
		score: z.number().int(),
		status: z.enum(['playing', 'won', 'lost']),
		lastAnswer: z.enum(['correct', 'incorrect']).nullable(),
		connected: z.boolean(),
		left: z.boolean()
	})
	.strict()
const roomStatus = z.enum(['waiting', 'loading', 'playing', 'finished', 'error', 'closed'])
const summarySchema = z
	.object({ id: z.string(), settings: settingsSchema, playerCount: z.number().int().nonnegative(), hasPassword: z.boolean() })
	.strict()
const previewSchema = summarySchema.extend({ view: z.literal('preview'), status: roomStatus })
export const roomSnapshotSchema = z
	.object({
		view: z.literal('member'),
		id: z.string(),
		settings: settingsSchema,
		hostId: uuid,
		players: z.array(playerSchema),
		status: roomStatus,
		roundId: uuid,
		roundNumber: z.number().int().min(0).max(50),
		deadline: time.nullable(),
		currentFrame: frameSchema.nullable(),
		attemptedMovieIds: z.array(movieIdSchema),
		winnerIds: z.array(uuid),
		error: z.string().nullable(),
		result: resultSchema.nullable(),
		version,
		serverTime: time
	})
	.strict()
const errorSchema = z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }).strict()
const collectionSchema = z
	.object({
		id: z.literal('tmdb-catalog'),
		title: z.string(),
		description: z.string(),
		movieCount: z.number().int().nonnegative()
	})
	.strict()
const suggestionSchema = z
	.object({ id: movieIdSchema, title: z.string(), englishTitle: z.string(), releaseYear: z.number().int() })
	.strict()
export const serverEventSchema = z.discriminatedUnion('event', [
	z.object({ event: z.literal('session.ready'), data: z.object({ participantId: uuid, serverTime: time }).strict() }).strict(),
	z.object({ event: z.literal('session.error'), data: errorSchema }).strict(),
	z.object({ event: z.literal('room.snapshot'), data: roomSnapshotSchema }).strict(),
	z
		.object({
			event: z.literal('lobbies.snapshot'),
			data: z.object({ revision: z.number().int().nonnegative(), serverTime: time, rooms: z.array(summarySchema) }).strict()
		})
		.strict()
])
export const clientEventSchema = z.discriminatedUnion('event', [
	z
		.object({
			event: z.literal('session.auth'),
			data: z.object({ ticket: z.string().min(20).max(128) }).strict(),
			requestId: z.string().max(128).optional()
		})
		.strict(),
	...(['lobbies.subscribe', 'lobbies.unsubscribe', 'room.unsubscribe'] as const).map((event) =>
		z.object({ event: z.literal(event), data: emptySchema, requestId: z.string().max(128).optional() }).strict()
	),
	z
		.object({
			event: z.literal('room.subscribe'),
			data: z.object({ roomId: z.string().min(1).max(32) }).strict(),
			requestId: z.string().max(128).optional()
		})
		.strict()
])
export const schemas: Record<string, z.ZodType> = {
	Error: errorSchema,
	Guest: z.object({ participantId: uuid, expiresAt: time }).strict(),
	GameFrame: frameSchema,
	GameResult: resultSchema,
	GameResponse: gameResponseSchema,
	PendingGame: pendingSchema,
	GuessResponse: guessResponseSchema,
	RoomSnapshot: roomSnapshotSchema,
	LobbyPreview: previewSchema,
	LobbySummary: summarySchema,
	LobbySettings: settingsSchema,
	RoomPlayer: playerSchema,
	Collection: collectionSchema,
	MovieSuggestion: suggestionSchema,
	Operation: z
		.object({ operationId: uuid, gameId: uuid, status: z.enum(['pending', 'ready', 'error']), error: z.string().nullable() })
		.strict(),
	Ticket: z.object({ ticket: z.string(), expiresAt: time }).strict(),
	CreateGame: createGameSchema,
	CreateRoom: createRoomSchema,
	JoinRoom: joinSchema,
	Guess: guessSchema,
	Skip: skipSchema,
	RoomGuess: roomGuessSchema,
	RoomSkip: roomSkipSchema,
	Empty: emptySchema,
	TicketRequest: ticketSchema,
	CreateRoomResponse: z.object({ roomId: z.string(), snapshot: roomSnapshotSchema }).strict(),
	LeaveResponse: z.object({ left: z.literal(true) }).strict(),
	RoomView: z.discriminatedUnion('view', [previewSchema, roomSnapshotSchema]),
	Live: z.object({ status: z.literal('ok') }).strict(),
	Ready: z.object({ status: z.literal('ready'), tmdbConfigured: z.boolean() }).strict()
}
function jsonSchema(schema: z.ZodType) {
	const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })
	delete json.$schema
	return json
}
type Parameter = { name: string; in: string; required: boolean; schema: Record<string, unknown> }
interface ApiOperation {
	operationId: string
	summary: string
	security: Record<string, never[]>[]
	parameters: Parameter[]
	responses: Record<string, unknown>
	requestBody?: unknown
}
export const openapi: {
	openapi: string
	info: Record<string, string>
	servers: { url: string }[]
	paths: Record<string, Record<string, ApiOperation>>
	components: Record<string, unknown>
} = {
	openapi: '3.1.0',
	info: {
		title: 'Moviestr Backend',
		version: '0.1.0',
		description: 'HTTP-команды, guest cookie, native WebSocket /ws. Frontend подключается отдельным этапом.'
	},
	servers: [{ url: 'http://localhost:3000' }],
	paths: {},
	components: {
		securitySchemes: { guestCookie: { type: 'apiKey', in: 'cookie', name: 'moviestr_guest' } },
		schemas: Object.fromEntries(
			Object.entries(schemas).map(([name, schema]) => [
				name,
				{ ...jsonSchema(schema), ...(name === 'RoomView' ? { discriminator: { propertyName: 'view' } } : {}) }
			])
		)
	}
}
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const array = (name: string) => ({ type: 'array', items: ref(name) })
function route(
	method: string,
	path: string,
	name: string,
	response: unknown,
	options: { input?: string; status?: number; public?: boolean; summary?: string; query?: Parameter[] } = {}
) {
	const protectedRoute = !options.public
	const parameters: Parameter[] = [...(options.query ?? [])]
	for (const match of path.matchAll(/\{(\w+)\}/g))
		parameters.push({
			name: match[1]!,
			in: 'path',
			required: true,
			schema: { type: 'string', ...(match[1] === 'gameId' || match[1] === 'operationId' ? { format: 'uuid' } : {}) }
		})
	if (method === 'post' && !path.endsWith('guest-sessions') && !path.endsWith('realtime-tickets'))
		parameters.push({
			name: 'Idempotency-Key',
			in: 'header',
			required: true,
			schema: { type: 'string', minLength: 8, maxLength: 128 }
		})
	const responses: Record<string, unknown> = {
		[String(options.status ?? 200)]: { description: 'Успешный ответ', content: { 'application/json': { schema: response } } }
	}
	for (const status of [400, 401, 403, 404, 409, 413, 429, 500, 502, 503, 504])
		responses[status] = {
			description: 'Безопасная ошибка; code определяет причину',
			content: { 'application/json': { schema: ref('Error') } }
		}
	const operation: ApiOperation = {
		operationId: name,
		summary: options.summary ?? name,
		security: protectedRoute ? [{ guestCookie: [] }] : [],
		parameters,
		responses,
		...(options.input ? { requestBody: { required: true, content: { 'application/json': { schema: ref(options.input) } } } } : {})
	}
	;(openapi.paths[path] ??= {})[method] = operation
}
route('post', '/api/v1/guest-sessions', 'createGuest', ref('Guest'), { input: 'Empty', status: 201, public: true })
route('post', '/api/v1/realtime-tickets', 'createRealtimeTicket', ref('Ticket'), { input: 'TicketRequest', status: 201 })
route('get', '/api/v1/collections', 'listCollections', array('Collection'), { public: true })
route('get', '/api/v1/movies/search', 'searchMovies', array('MovieSuggestion'), {
	public: true,
	query: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', maxLength: 120 } }]
})
route('post', '/api/v1/games', 'createGame', ref('PendingGame'), {
	input: 'CreateGame',
	status: 202,
	summary: 'Создать соло; 202 и стабильные gameId/operationId, затем GET игры'
})
route('get', '/api/v1/games/{gameId}', 'getGame', ref('GameResponse'))
route('post', '/api/v1/games/{gameId}/guesses', 'guessSolo', ref('GuessResponse'), { input: 'Guess' })
route('post', '/api/v1/games/{gameId}/skip', 'skipSolo', ref('GameResponse'), { input: 'Skip' })
route('post', '/api/v1/games/{gameId}/retry-preparation', 'retrySolo', ref('PendingGame'), { input: 'Empty', status: 202 })
route('get', '/api/v1/operations/{operationId}', 'getOperation', ref('Operation'))
route('get', '/api/v1/rooms', 'listRooms', array('LobbySummary'), { public: true })
route('post', '/api/v1/rooms', 'createRoom', ref('CreateRoomResponse'), { input: 'CreateRoom', status: 201 })
route('get', '/api/v1/rooms/{roomId}', 'getRoom', ref('RoomView'))
route('post', '/api/v1/rooms/{roomId}/join', 'joinRoom', ref('RoomSnapshot'), { input: 'JoinRoom' })
route('post', '/api/v1/rooms/{roomId}/start', 'startRoom', ref('RoomSnapshot'), { input: 'Empty' })
route('post', '/api/v1/rooms/{roomId}/guesses', 'guessRoom', ref('RoomSnapshot'), { input: 'RoomGuess' })
route('post', '/api/v1/rooms/{roomId}/skip', 'skipRoom', ref('RoomSnapshot'), { input: 'RoomSkip' })
route('post', '/api/v1/rooms/{roomId}/leave', 'leaveRoom', ref('LeaveResponse'), { input: 'Empty' })
route('post', '/api/v1/rooms/{roomId}/retry-preparation', 'retryRoom', ref('RoomSnapshot'), { input: 'Empty' })
route('get', '/health/live', 'liveness', ref('Live'), { public: true })
route('get', '/health/ready', 'readiness', ref('Ready'), { public: true })
export const websocketSchema = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	title: 'Moviestr native WebSocket protocol',
	oneOf: [jsonSchema(clientEventSchema), jsonSchema(serverEventSchema)]
}
