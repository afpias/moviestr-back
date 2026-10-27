import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common'
import type { Response } from 'express'
import { z } from 'zod'
import { SoloService } from './solo.service'
import { guest, type GuestRequest } from '../sessions/sessions'
import { createGameSchema, emptySchema, guessSchema, skipSchema, parse } from '../common/schemas'
import { reply } from '../common/http'
@Controller('api/v1')
export class SoloController {
	constructor(@Inject(SoloService) private solo: SoloService) {}
	@Post('games') async create(
		@Req() req: GuestRequest,
		@Headers('idempotency-key') key: unknown,
		@Body() body: unknown,
		@Res({ passthrough: true }) res: Response
	) {
		const owner = guest(req)
		const outcome = await this.solo.create(owner.id, key, parse(createGameSchema, body))
		const value = outcome.body as { gameId: string }
		res.setHeader('Location', `/api/v1/games/${value.gameId}`)
		return reply(res, outcome)
	}
	@Get('games/:id') get(@Req() req: GuestRequest, @Param('id') id: string) {
		const owner = guest(req)
		return this.solo.get(owner.id, parse(z.uuid(), id))
	}
	@Post('games/:id/guesses') async guess(
		@Req() req: GuestRequest,
		@Param('id') id: string,
		@Headers('idempotency-key') key: unknown,
		@Body() body: unknown,
		@Res({ passthrough: true }) res: Response
	) {
		const owner = guest(req)
		return reply(res, await this.solo.action(owner.id, parse(z.uuid(), id), key, parse(guessSchema, body), 'guesses'))
	}
	@Post('games/:id/skip') async skip(
		@Req() req: GuestRequest,
		@Param('id') id: string,
		@Headers('idempotency-key') key: unknown,
		@Body() body: unknown,
		@Res({ passthrough: true }) res: Response
	) {
		const owner = guest(req)
		return reply(res, await this.solo.action(owner.id, parse(z.uuid(), id), key, parse(skipSchema, body), 'skip'))
	}
	@Post('games/:id/retry-preparation') async retry(
		@Req() req: GuestRequest,
		@Param('id') id: string,
		@Headers('idempotency-key') key: unknown,
		@Body() body: unknown,
		@Res({ passthrough: true }) res: Response
	) {
		const owner = guest(req)
		parse(emptySchema, body)
		return reply(res, await this.solo.retry(owner.id, parse(z.uuid(), id), key))
	}
	@Get('operations/:id') operation(@Req() req: GuestRequest, @Param('id') id: string) {
		return this.solo.operation(guest(req).id, parse(z.uuid(), id))
	}
}
