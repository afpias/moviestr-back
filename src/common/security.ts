import { createHash, randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { AppError } from './errors'
const scrypt = promisify(derive)
export const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export const opaque = () => randomBytes(32).toString('base64url')
export async function passwordHash(password: string) {
	if (!password) return null
	const salt = randomBytes(16).toString('hex')
	const key = (await scrypt(password, salt, 64)) as Buffer
	return `${salt}:${key.toString('hex')}`
}
export async function passwordMatches(password: string, stored: string | null) {
	if (!stored) return true
	const [salt, hex] = stored.split(':')
	if (!salt || !hex) return false
	const key = (await scrypt(password, salt, 64)) as Buffer
	const expected = Buffer.from(hex, 'hex')
	return expected.length === key.length && timingSafeEqual(key, expected)
}
export const origins = () =>
	new Set(
		(process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://localhost:3000')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	)
export function checkOrigin(origin: string | undefined) {
	if (origin && !origins().has(origin)) throw new AppError(403, 'ORIGIN_FORBIDDEN')
}
export class RateLimiter {
	private entries = new Map<string, { until: number; count: number }>()
	take(key: string, limit = 120, period = 60000) {
		const now = Date.now()
		if (this.entries.size > 10000) {
			for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k)
			if (this.entries.size > 10000) throw new AppError(429, 'RATE_LIMITED')
		}
		let entry = this.entries.get(key)
		if (!entry || entry.until <= now) {
			entry = { until: now + period, count: 0 }
			this.entries.set(key, entry)
		}
		if (++entry.count > limit) throw new AppError(429, 'RATE_LIMITED')
	}
}
