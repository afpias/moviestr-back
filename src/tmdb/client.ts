import { AppError } from '../common/errors'
export class TmdbClient {
	private cache = new Map<string, { expires: number; promise: Promise<unknown> }>()
	constructor(
		private token = process.env.TMDB_READ_TOKEN ?? '',
		private fetcher: typeof fetch = fetch
	) {}
	async get(path: string, params: Record<string, string | number | boolean>): Promise<unknown> {
		if (!this.token) throw new AppError(503, 'SERVICE_NOT_CONFIGURED', 'Сервер TMDB не настроен')
		if (!/^\/(discover\/movie|search\/movie|movie\/\d+)$/.test(path)) throw new AppError(400, 'INVALID_UPSTREAM_PATH')
		const url = new URL(`https://api.themoviedb.org/3${path}`)
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
		const key = url.href
		const old = this.cache.get(key)
		if (old && old.expires > Date.now()) return old.promise
		const promise = this.request(url).catch((e) => {
			this.cache.delete(key)
			throw e
		})
		if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!)
		this.cache.set(key, { expires: Date.now() + 300000, promise })
		return promise
	}
	private async request(url: URL): Promise<unknown> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const r = await this.fetcher(url, {
					headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
					signal: AbortSignal.timeout(10000)
				})
				if ((r.status === 429 || r.status === 503) && attempt < 2) {
					await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
					continue
				}
				if (!r.ok) throw new AppError(502, 'UPSTREAM_ERROR', 'TMDB недоступен')
				return (await r.json()) as unknown
			} catch (e) {
				if (e instanceof AppError) throw e
				if (e instanceof Error && ['AbortError', 'TimeoutError'].includes(e.name))
					throw new AppError(504, 'TIMEOUT', 'Превышено время ожидания TMDB')
				throw new AppError(502, 'UPSTREAM_ERROR', 'Некорректный ответ TMDB или timeout')
			}
		}
		throw new AppError(502, 'UPSTREAM_ERROR', 'TMDB недоступен')
	}
}
