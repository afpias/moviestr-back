import { Controller, Post, Body, Req, Res, Injectable, Inject } from '@nestjs/common'
import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { Database } from '../database/database'
import { hash, opaque } from '../common/security'
import { AppError, requireCondition as check } from '../common/errors'
import { emptySchema, parse, ticketSchema } from '../common/schemas'
export interface Guest {
	id: string
	expiresAt: number
}
export type GuestRequest = Request & { guest?: Guest }
export function guest(req: GuestRequest): Guest {
	if (!req.guest) throw new AppError(401, 'SESSION_REQUIRED')
	return req.guest
}
@Injectable()
export class SessionsService {
	constructor(@Inject(Database) private db: Database) {}
	async resolve(token: unknown, touch = false): Promise<Guest | undefined> {
		if (typeof token !== 'string' || token.length > 128) return
		const row = (
			await this.db.query<{ id: string; expires_at: string }>(
				'SELECT id,expires_at FROM guest_sessions WHERE token_hash=$1 AND expires_at>$2',
				[hash(token), Date.now()]
			)
		).rows[0]
		if (!row) return
		const expiresAt = touch ? Date.now() + 30 * 86400000 : Number(row.expires_at)
		if (touch)
			await this.db.query('UPDATE guest_sessions SET expires_at=$2,last_activity=$3 WHERE id=$1', [row.id, expiresAt, Date.now()])
		return { id: row.id, expiresAt }
	}
	async bootstrap(req: GuestRequest, res: Response) {
		const token = typeof req.cookies?.moviestr_guest === 'string' ? req.cookies.moviestr_guest : opaque()
		let session = await this.resolve(token)
		const expiresAt = Date.now() + 30 * 86400000
		if (!session) {
			session = { id: randomUUID(), expiresAt }
			const fresh = opaque()
			await this.db.query('INSERT INTO guest_sessions(id,token_hash,expires_at,last_activity) VALUES($1,$2,$3,$4)', [
				session.id,
				hash(fresh),
				expiresAt,
				Date.now()
			])
			res.cookie('moviestr_guest', fresh, {
				httpOnly: true,
				sameSite: 'lax',
				secure: process.env.NODE_ENV === 'production',
				path: '/api/v1',
				maxAge: 30 * 86400000
			})
		} else {
			await this.db.query('UPDATE guest_sessions SET expires_at=$2,last_activity=$3 WHERE id=$1', [
				session.id,
				expiresAt,
				Date.now()
			])
			res.cookie('moviestr_guest', token, {
				httpOnly: true,
				sameSite: 'lax',
				secure: process.env.NODE_ENV === 'production',
				path: '/api/v1',
				maxAge: 30 * 86400000
			})
		}
		return { participantId: session.id, expiresAt }
	}
	async ticket(owner: string, roomId?: string) {
		if (roomId)
			check(
				(await this.db.query('SELECT 1 FROM room_players WHERE room_id=$1 AND player_id=$2 AND active', [roomId, owner]))
					.rowCount,
				403,
				'FORBIDDEN'
			)
		const ticket = opaque(),
			expiresAt = Date.now() + 30000
		await this.db.query('INSERT INTO realtime_tickets(token_hash,owner,room_id,expires_at) VALUES($1,$2,$3,$4)', [
			hash(ticket),
			owner,
			roomId ?? null,
			expiresAt
		])
		return { ticket, expiresAt }
	}
	async consume(token: string) {
		return this.db.transaction(async (c) => {
			const row = (
				await c.query<{ owner: string; room_id: string | null }>(
					'DELETE FROM realtime_tickets WHERE token_hash=$1 AND expires_at>$2 RETURNING owner,room_id',
					[hash(token), Date.now()]
				)
			).rows[0]
			check(row, 401, 'INVALID_TICKET')
			check(
				(await c.query('SELECT 1 FROM guest_sessions WHERE id=$1 AND expires_at>$2', [row.owner, Date.now()])).rowCount,
				401,
				'SESSION_EXPIRED'
			)
			return row
		})
	}
}
@Controller('api/v1')
export class SessionsController {
	constructor(@Inject(SessionsService) private sessions: SessionsService) {}
	@Post('guest-sessions') async create(
		@Body() body: unknown,
		@Req() req: GuestRequest,
		@Res({ passthrough: true }) res: Response
	) {
		parse(emptySchema, body)
		return this.sessions.bootstrap(req, res)
	}
	@Post('realtime-tickets') async ticket(@Body() body: unknown, @Req() req: GuestRequest) {
		const owner = guest(req)
		const input = parse(ticketSchema, body)
		return this.sessions.ticket(owner.id, input.roomId)
	}
}
