import 'reflect-metadata'
import './common/environment'
import { NestFactory } from '@nestjs/core'
import type { Request, Response, NextFunction } from 'express'
import cookieParser from 'cookie-parser'
import { AppModule } from './app.module'
import { ErrorFilter, AppError } from './common/errors'
import { checkOrigin, origins, RateLimiter } from './common/security'
import { SessionsService, type GuestRequest } from './sessions/sessions'
import { Database } from './database/database'
import { RealtimeService } from './realtime/realtime.service'
import { SchedulerService } from './scheduling/scheduler.service'
export async function createApp(options: { scheduler?: boolean } = {}) {
	const app = await NestFactory.create(AppModule, { logger: false })
	app.enableShutdownHooks()
	app.use(cookieParser())
	app.enableCors({ origin: [...origins()], credentials: true })
	app.useGlobalFilters(new ErrorFilter())
	const sessions = app.get(SessionsService),
		limiter = new RateLimiter()
	app.use(async (req: GuestRequest, res: Response, next: NextFunction) => {
		try {
			if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) checkOrigin(req.get('origin'))
			const limit = req.path.includes('guest-sessions') ? 30 : req.path.endsWith('/join') ? 30 : 180
			limiter.take(
				`${req.ip}:${req.path.includes('/join') ? 'join' : req.path.includes('guest-sessions') ? 'guest' : 'api'}`,
				limit
			)
			req.guest = req.path.startsWith('/health/') ? undefined : await sessions.resolve(req.cookies?.moviestr_guest, true)
			if (req.guest)
				res.cookie('moviestr_guest', req.cookies.moviestr_guest, {
					httpOnly: true,
					sameSite: 'lax',
					secure: process.env.NODE_ENV === 'production',
					path: '/api/v1',
					maxAge: 30 * 86400000
				})
			next()
		} catch (e) {
			const error = e instanceof AppError ? e : new AppError(503, 'DATABASE_UNAVAILABLE')
			res.status(error.status).json({ code: error.code, message: error.message })
		}
	})
	app.use((req: Request, res: Response, next: NextFunction) => {
		res.setHeader('X-Content-Type-Options', 'nosniff')
		res.setHeader('Cache-Control', 'no-store')
		next()
	})
	await app.get(Database).migrate()
	await app.init()
	app.get(RealtimeService).attach(app.getHttpServer())
	if (options.scheduler !== false) await app.get(SchedulerService).start()
	return app
}
