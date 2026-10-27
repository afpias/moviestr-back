import { Catch, type ArgumentsHost, type ExceptionFilter, HttpException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
export class AppError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message = code
	) {
		super(message)
	}
}
export function requireCondition(condition: unknown, status: number, code: string): asserts condition {
	if (!condition) throw new AppError(status, code)
}
@Catch()
export class ErrorFilter implements ExceptionFilter {
	catch(error: unknown, host: ArgumentsHost) {
		const res = host.switchToHttp().getResponse<Response>()
		const known = error instanceof AppError
		const status = known ? error.status : error instanceof HttpException ? error.getStatus() : 500
		res.status(status).json({
			code: known ? error.code : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR',
			message: known ? error.message : 'Запрос не удалось обработать',
			requestId: randomUUID()
		})
	}
}
