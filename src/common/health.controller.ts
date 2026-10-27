import { Controller, Get, Inject } from '@nestjs/common'
import { Database } from '../database/database'
import { AppError } from './errors'
@Controller('health')
export class HealthController {
	constructor(@Inject(Database) private db: Database) {}
	@Get('live') live() {
		return { status: 'ok' }
	}
	@Get('ready') async ready() {
		try {
			await this.db.query('SELECT 1')
		} catch {
			throw new AppError(503, 'DATABASE_UNAVAILABLE')
		}
		if (!process.env.TMDB_READ_TOKEN && process.env.NODE_ENV !== 'test')
			throw new AppError(503, 'SERVICE_NOT_CONFIGURED', 'Сервер TMDB не настроен')
		return { status: 'ready', tmdbConfigured: !!process.env.TMDB_READ_TOKEN }
	}
}
