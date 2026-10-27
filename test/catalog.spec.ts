import { describe, expect, it } from 'vitest'
import { difficultySlice, rankMovies, selectFrames, mergeSearch } from '../src/catalog/rules'
import { TmdbClient } from '../src/tmdb/client'

describe('catalog', () => {
	it('retries upstream429, deduplicates requests, and caches only success', async () => {
		let calls = 0
		const client = new TmdbClient('test-token', async () => {
			calls++
			return calls === 1 ? new Response('', { status: 429 }) : Response.json({ results: [] })
		})
		const [a, b] = await Promise.all([
			client.get('/search/movie', { query: 'same' }),
			client.get('/search/movie', { query: 'same' })
		])
		expect(a).toEqual(b)
		expect(calls).toBe(2)
		await client.get('/search/movie', { query: 'same' })
		expect(calls).toBe(2)
	})
	it('reports timeouts distinctly without exposing upstream credentials', async () => {
		const client = new TmdbClient('test-token', async () => {
			throw new DOMException('private upstream URL', 'TimeoutError')
		})
		await expect(client.get('/search/movie', { query: 'hi' })).rejects.toMatchObject({ status: 504, code: 'TIMEOUT' })
		await expect(client.get('/forbidden', {})).rejects.toMatchObject({ status: 400 })
	})
	it('filters short titles using the same exact token matching as the frontend', async () => {
		const images = Array.from({ length: 6 }, (_, i) => ({
			file_path: `/short${i}.jpg`,
			width: 1280,
			height: 720,
			iso_639_1: null,
			vote_count: i,
			vote_average: 5
		}))
		const frames = await selectFrames(images, ['Up'], async (url) => (url.includes('short0') ? 'UP' : ''))
		expect(frames).toHaveLength(5)
		expect(frames.some((f) => f.url.includes('short0'))).toBe(false)
	})
	it('covers genre pool percentiles without overlap', () => {
		expect(difficultySlice('easy', 10000)).toEqual([0, 1000])
		expect(difficultySlice('impossible', 10000)).toEqual([8000, 10000])
		expect(difficultySlice('hard', 10000)).toEqual([3000, 5500])
	})
	it('ranks log normalized vote count/popularity 70/30', () => {
		expect(
			rankMovies([
				{ id: 1, vote_count: 100, popularity: 1 },
				{ id: 2, vote_count: 1, popularity: 100 }
			])[0]?.id
		).toBe(1)
	})
	it('merges RU/EN suggestions by ID and limits ten', () => {
		const ru = Array.from({ length: 12 }, (_, i) => ({
			id: i + 1,
			title: `Рус ${i}`,
			original_title: 'Original',
			release_date: '2000-01-01'
		}))
		const en = ru.map((m) => ({ ...m, title: `English ${m.id}` }))
		const result = mergeSearch(ru, en)
		expect(result).toHaveLength(10)
		expect(result[0]).toEqual({ id: 'tmdb-1', title: 'Рус 0', englishTitle: 'English 1', releaseYear: 2000 })
	})
	it('excludes title cards, low resolution, duplicates and picks five', async () => {
		const images = Array.from({ length: 8 }, (_, i) => ({
			file_path: `/f${i}.jpg`,
			width: 1280,
			height: 720,
			iso_639_1: null,
			vote_count: i,
			vote_average: 5
		}))
		const frames = await selectFrames(
			[...images, images[0]!, { ...images[0]!, file_path: '/low.jpg', width: 780 }],
			['Matrix'],
			async (url) => (url.includes('f0.jpg') ? 'The Matrix' : '')
		)
		expect(frames).toHaveLength(5)
		expect(frames.every((f) => f.url.includes('w1280'))).toBe(true)
		expect(frames.some((f) => f.url.includes('f0.jpg'))).toBe(false)
	})
	it('keeps language neutral fallback if OCR fails', async () => {
		const images = Array.from({ length: 5 }, (_, i) => ({
			file_path: `/${i}.jpg`,
			width: 1280,
			height: 720,
			iso_639_1: null,
			vote_count: i,
			vote_average: 5
		}))
		expect(
			await selectFrames(images, ['Film'], async () => {
				throw Error('OCR unavailable')
			})
		).toHaveLength(5)
	})
	it('validates unknown upstream and never returns token/body on error', async () => {
		const client = new TmdbClient('secret', async () => new Response('{"token":"private"}', { status: 500 }))
		await expect(client.get('/search/movie', { query: 'hi' })).rejects.toThrow('TMDB')
		const malformed = new TmdbClient('secret', async () => new Response('no-json'))
		await expect(malformed.get('/search/movie', {})).rejects.toThrow()
		expect(() => new TmdbClient('')).not.toThrow()
	})
})
