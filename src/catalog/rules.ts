import type { Difficulty, Frame, Suggestion } from '../common/model'
const ranges = { easy: [0, 0.1], medium: [0.1, 0.3], hard: [0.3, 0.55], expert: [0.55, 0.8], impossible: [0.8, 1] } as const
export function difficultySlice(d: Difficulty, count: number): [number, number] {
	return [Math.floor(ranges[d][0] * count), Math.floor(ranges[d][1] * count)]
}
export function rankMovies<T extends { vote_count: number; popularity: number }>(movies: T[]): T[] {
	function norm(values: number[]) {
		const logs = values.map((v) => Math.log1p(Math.max(0, v)))
		const min = Math.min(...logs),
			range = Math.max(...logs) - min
		return logs.map((v) => (range ? (v - min) / range : 0))
	}
	const votes = norm(movies.map((m) => m.vote_count)),
		pop = norm(movies.map((m) => m.popularity))
	return movies
		.map((m, i) => ({ m, score: votes[i]! * 0.7 + pop[i]! * 0.3 }))
		.sort((a, b) => b.score - a.score || b.m.vote_count - a.m.vote_count)
		.map((v) => v.m)
}
export interface SearchMovie {
	id: number
	title: string
	original_title: string
	release_date: string
}
export function mergeSearch(ru: SearchMovie[], en: SearchMovie[]): Suggestion[] {
	const ruMap = new Map(ru.map((m) => [m.id, m])),
		enMap = new Map(en.map((m) => [m.id, m]))
	const result = new Map<number, Suggestion>()
	for (const m of [...ru, ...en]) {
		const year = Number(m.release_date.slice(0, 4))
		if (year > 1800 && !result.has(m.id))
			result.set(m.id, {
				id: `tmdb-${m.id}`,
				title: ruMap.get(m.id)?.title ?? m.title,
				englishTitle: enMap.get(m.id)?.title ?? m.original_title,
				releaseYear: year
			})
		if (result.size === 10) break
	}
	return [...result.values()]
}
export interface Image {
	file_path: string
	width: number
	height: number
	iso_639_1: string | null
	vote_count: number
	vote_average: number
}
export function normalizeTitle(s: string) {
	return s
		.toLocaleLowerCase('ru-RU')
		.replaceAll('ё', 'е')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
}
export async function selectFrames(
	images: Image[],
	titles: string[],
	recognize: (url: string) => Promise<string>
): Promise<Frame[]> {
	const seen = new Set<string>()
	const candidates = images
		.filter(
			(i) => i.width >= 1280 && i.width > i.height && i.iso_639_1 === null && !seen.has(i.file_path) && !!seen.add(i.file_path)
		)
		.sort((a, b) => b.vote_count - a.vote_count || b.width - a.width)
		.slice(0, 18)
		.sort(
			(a, b) => Math.log1p(a.vote_count) * 0.7 + a.vote_average * 0.3 - (Math.log1p(b.vote_count) * 0.7 + b.vote_average * 0.3)
		)
	const safe: Image[] = []
	const deadline = Date.now() + 450
	for (const i of candidates) {
		let text = ''
		if (Date.now() < deadline) {
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				text = await Promise.race([
					recognize(`https://image.tmdb.org/t/p/w1280${i.file_path}`),
					new Promise<string>((resolve) => {
						timer = setTimeout(() => resolve(''), Math.max(1, deadline - Date.now()))
					})
				])
			} catch {
				/* approved fallback */
			} finally {
				clearTimeout(timer)
			}
		}
		const normalized = ` ${normalizeTitle(text)} `
		if (!titles.some((t) => normalizeTitle(t).length > 0 && normalized.includes(` ${normalizeTitle(t)} `))) safe.push(i)
	}
	if (safe.length < 5) return []
	return Array.from({ length: 5 }, (_, index) => ({
		index,
		url: `https://image.tmdb.org/t/p/w1280${safe[Math.round((index * (safe.length - 1)) / 4)]!.file_path}`,
		alt: `Кадр ${index + 1} из загаданного фильма`
	}))
}
