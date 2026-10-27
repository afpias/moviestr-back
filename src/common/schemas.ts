import { z } from 'zod'
import { difficulties, genres } from './model'
import { AppError } from './errors'
export const difficultySchema = z.enum(difficulties),
	genreSchema = z.enum(genres)
export const settingsSchema = z
	.object({
		name: z.string().trim().min(2).max(60),
		capacity: z.number().int().min(2).max(4).default(4),
		filmCount: z.number().int().min(1).max(50).default(20),
		difficulty: difficultySchema.default('easy'),
		genre: genreSchema.default('all'),
		visibility: z.enum(['public', 'private']).default('public'),
		mode: z.literal('points').default('points')
	})
	.strict()
export const nicknameSchema = z.string().trim().min(2).max(24)
export const passwordSchema = z.string().max(128).default('')
export const movieIdSchema = z.string().regex(/^tmdb-[1-9]\d{0,9}$/)
export const guessSchema = z.object({ movieId: movieIdSchema, expectedFrameIndex: z.number().int().min(0).max(4) }).strict()
export const roomGuessSchema = guessSchema.extend({ roundId: z.uuid() })
export const skipSchema = guessSchema.omit({ movieId: true })
export const roomSkipSchema = skipSchema.extend({ roundId: z.uuid() })
export const createGameSchema = z
	.object({
		collectionId: z.literal('tmdb-catalog').default('tmdb-catalog'),
		difficulty: difficultySchema.default('easy'),
		genre: genreSchema.default('all')
	})
	.strict()
export const createRoomSchema = z
	.object({ settings: settingsSchema, nickname: nicknameSchema, password: passwordSchema })
	.strict()
export const joinSchema = z.object({ nickname: nicknameSchema, password: passwordSchema }).strict()
export const ticketSchema = z.object({ roomId: z.string().min(1).max(32).optional() }).strict()
export const emptySchema = z.object({}).strict()
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input)
	if (!result.success) throw new AppError(400, 'VALIDATION_ERROR', 'Некорректные параметры запроса')
	return result.data
}
