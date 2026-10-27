import { Controller, Get, Inject, Injectable, Query } from '@nestjs/common'
import { z } from 'zod'
import { TmdbClient } from '../tmdb/client'
import { Database } from '../database/database'
import { OcrService } from './ocr.service'
import { difficultySlice, mergeSearch, rankMovies, selectFrames } from './rules'
import { AppError } from '../common/errors'
import type { Difficulty, Genre, PreparedMovie } from '../common/model'
import { hash } from '../common/security'
const id = z.number().int().positive()
const movieSchema = z.object({
	id,
	title: z.string(),
	original_title: z.string(),
	release_date: z.string(),
	vote_count: z.number().nonnegative().default(0),
	popularity: z.number().nonnegative().default(0),
	backdrop_path: z.string().nullable().optional(),
	poster_path: z.string().nullable().optional()
})
const pageSchema = z.object({
	page: z.number().int().min(1),
	total_pages: z.number().int().nonnegative(),
	total_results: z.number().int().nonnegative(),
	results: z.array(movieSchema)
})
const searchSchema = z.object({ results: z.array(movieSchema) })
const imageSchema = z.object({
	file_path: z.string().regex(/^\/[\w.-]+$/),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	iso_639_1: z.string().nullable(),
	vote_count: z.number().nonnegative(),
	vote_average: z.number().nonnegative()
})
const bundleSchema = movieSchema.extend({
	images: z.object({ backdrops: z.array(imageSchema) }),
	alternative_titles: z.object({ titles: z.array(z.object({ title: z.string() })) })
})
const genreIds: Record<Genre, number | undefined> = {
	all: undefined,
	action: 28,
	comedy: 35,
	drama: 18,
	thriller: 53,
	horror: 27,
	'science-fiction': 878,
	animation: 16
}
@Injectable()
export class CatalogService {
	readonly provider = new TmdbClient()
	constructor(
		@Inject(Database) private db: Database,
		@Inject(OcrService) private ocr: OcrService
	) {}
	private async request<T>(path: string, params: Record<string, string | number | boolean>, schema: z.ZodType<T>): Promise<T> {
		const key = hash(`tmdb-v1:${path}:${JSON.stringify(params)}`)
		const cached = (
			await this.db.query<{ data: unknown }>('SELECT data FROM provider_cache WHERE key=$1 AND expires_at>$2', [key, Date.now()])
		).rows[0]
		const raw = cached?.data ?? (await this.provider.get(path, params))
		const parsed = schema.safeParse(raw)
		if (!parsed.success) throw new AppError(502, 'UPSTREAM_ERROR', 'Некорректный ответ TMDB')
		if (!cached)
			await this.db.query(
				'INSERT INTO provider_cache(key,data,expires_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET data=$2,expires_at=$3',
				[key, JSON.stringify(raw), Date.now() + 300000]
			)
		return parsed.data
	}
	private page(genre: Genre, page: number) {
		return this.request(
			'/discover/movie',
			{
				sort_by: 'vote_count.desc',
				include_adult: false,
				include_video: false,
				page,
				language: 'ru-RU',
				...(genreIds[genre] ? { with_genres: genreIds[genre]! } : {})
			},
			pageSchema
		)
	}
	async collections() {
		const first = await this.page('all', 1)
		return [
			{
				id: 'tmdb-catalog',
				title: 'Каталог TMDB',
				description: 'Фильмы TMDB, ранжированные по известности',
				movieCount: Math.min(first.total_results, Math.min(first.total_pages, 500) * 20)
			}
		]
	}
	async search(query: string) {
		if (query.trim().length < 2) return []
		if (query.length > 120) throw new AppError(400, 'VALIDATION_ERROR')
		const [ru, en] = await Promise.all(
			['ru-RU', 'en-US'].map((language) =>
				this.request('/search/movie', { query: query.trim(), language, include_adult: false, page: 1 }, searchSchema)
			)
		)
		return mergeSearch(ru!.results, en!.results)
	}
	async prepare(difficulty: Difficulty, genre: Genre, excluded: string[] = []): Promise<PreparedMovie> {
		const budgetUntil = Date.now() + 45000
		const first = await this.page(genre, 1)
		const count = Math.min(first.total_results, Math.min(first.total_pages, 500) * 20)
		const [start, end] = difficultySlice(difficulty, count)
		if (end <= start) throw new AppError(502, 'CATALOG_EXHAUSTED')
		const visited = new Set<number>()
		let attempts = 0
		for (let step = 0; step < 8; step++) {
			if (Date.now() >= budgetUntil) break
			const rank = start + Math.floor(Math.random() * (end - start))
			let page = Math.floor(rank / 20) + 1
			while (visited.has(page) && visited.size < Math.ceil(end / 20) - Math.floor(start / 20))
				page = page >= Math.ceil(end / 20) ? Math.floor(start / 20) + 1 : page + 1
			if (visited.has(page)) break
			visited.add(page)
			const data = page === 1 ? first : await this.page(genre, page)
			const from = Math.max(0, start - (page - 1) * 20),
				to = Math.min(data.results.length, end - (page - 1) * 20)
			const candidates = rankMovies(data.results.slice(from, to)).filter((m) => !excluded.includes(`tmdb-${m.id}`))
			const offset = Math.floor(Math.random() * Math.max(1, candidates.length))
			for (const candidate of [...candidates.slice(offset), ...candidates.slice(0, offset)]) {
				if (Date.now() >= budgetUntil) break
				if (++attempts > 24) break
				const movie = await this.request(
					`/movie/${candidate.id}`,
					{ language: 'ru-RU', append_to_response: 'images,alternative_titles', include_image_language: 'null,en,ru' },
					bundleSchema
				)
				if (!movie.poster_path || !/^\/[\w.-]+$/.test(movie.poster_path)) continue
				const aliases = [
					...new Set(
						[movie.title, movie.original_title, ...movie.alternative_titles.titles.map((t) => t.title)]
							.map((t) => t.trim())
							.filter(Boolean)
					)
				]
				const frames = await selectFrames(movie.images.backdrops, aliases, (url) => this.ocr.recognize(url))
				const year = Number(movie.release_date.slice(0, 4))
				if (frames.length === 5 && year > 1800)
					return {
						id: `tmdb-${movie.id}`,
						aliases,
						frames,
						result: {
							title: movie.title,
							originalTitle: movie.original_title,
							posterUrl: `https://image.tmdb.org/t/p/w780${movie.poster_path}`,
							releaseYear: year
						}
					}
			}
			if (attempts > 24) break
		}
		throw new AppError(502, 'CATALOG_EXHAUSTED', 'Не найден новый фильм с пятью кадрами')
	}
}
@Controller('api/v1')
export class CatalogController {
	constructor(@Inject(CatalogService) private catalog: CatalogService) {}
	@Get('collections') collections() {
		return this.catalog.collections()
	}
	@Get('movies/search') search(@Query('q') query: unknown) {
		if (typeof query !== 'string') throw new AppError(400, 'VALIDATION_ERROR')
		return this.catalog.search(query)
	}
}
