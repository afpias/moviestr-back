import 'reflect-metadata'
import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest'
import { createApp } from '../src/bootstrap'
import { Database } from '../src/database/database'
import { CatalogService } from '../src/catalog/catalog.service'
import { OcrService } from '../src/catalog/ocr.service'
import { testDatabaseUrl } from './database'
let app: Awaited<ReturnType<typeof createApp>>
beforeAll(async () => {
	process.env.DATABASE_URL = testDatabaseUrl()
	app = await createApp({ scheduler: false })
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
	await app.close()
})
const candidate = {
	id: 603,
	title: 'Матрица',
	original_title: 'The Matrix',
	release_date: '1999-01-01',
	poster_path: '/poster.jpg',
	backdrop_path: '/backdrop.jpg',
	vote_count: 100,
	popularity: 10
}
it('selects impossible inside genre at page401 and validates movie bundles on the server', async () => {
	await app.get(Database).query('DELETE FROM provider_cache')
	const catalog = app.get(CatalogService)
	const spy = vi.spyOn(catalog.provider, 'get').mockImplementation(async (path, params) =>
		path === '/discover/movie'
			? { page: params.page, total_pages: 500, total_results: 10000, results: [candidate] }
			: {
					...candidate,
					images: {
						backdrops: Array.from({ length: 5 }, (_, i) => ({
							file_path: `/a${i}.jpg`,
							width: 1280,
							height: 720,
							iso_639_1: null,
							vote_count: i,
							vote_average: 5
						}))
					},
					alternative_titles: { titles: [{ title: 'Matrix' }] }
				}
	)
	vi.spyOn(Math, 'random').mockReturnValue(0)
	vi.spyOn(app.get(OcrService), 'recognize').mockResolvedValue('')
	const selected = await catalog.prepare('impossible', 'science-fiction')
	expect(selected.id).toBe('tmdb-603')
	expect(selected.frames).toHaveLength(5)
	expect(
		spy.mock.calls.some(
			([path, p]) =>
				path === '/discover/movie' &&
				p.page === 401 &&
				p.with_genres === 878 &&
				p.include_adult === false &&
				p.include_video === false
		)
	).toBe(true)
})
it('exhausts a unique-movie pool safely without repeating or changing difficulty', async () => {
	await app.get(Database).query('DELETE FROM provider_cache')
	const catalog = app.get(CatalogService)
	const spy = vi
		.spyOn(catalog.provider, 'get')
		.mockResolvedValue({ page: 1, total_pages: 1, total_results: 1, results: [candidate] })
	await expect(catalog.prepare('impossible', 'all', ['tmdb-603'])).rejects.toMatchObject({ code: 'CATALOG_EXHAUSTED' })
	expect(spy).toHaveBeenCalledTimes(1)
})
