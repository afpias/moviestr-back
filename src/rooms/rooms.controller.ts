import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common'
import type { Response } from 'express'
import { RoomsService } from './rooms.service'
import { guest, type GuestRequest } from '../sessions/sessions'
import { createRoomSchema, joinSchema, roomGuessSchema, roomSkipSchema, emptySchema, parse } from '../common/schemas'
import { reply } from '../common/http'
@Controller('api/v1/rooms')
export class RoomsController {
	constructor(@Inject(RoomsService) private rooms: RoomsService) {}
	@Get() list() {
		return this.rooms.list()
	}
	@Get(':id') get(@Req() req: GuestRequest, @Param('id') id: string) {
		return this.rooms.get(guest(req).id, id)
	}
	@Post() async create(
		@Req() req: GuestRequest,
		@Headers('idempotency-key') key: unknown,
		@Body() body: unknown,
		@Res({ passthrough: true }) res: Response
	) {
		const owner = guest(req)
		return reply(res, await this.rooms.create(owner.id, key, parse(createRoomSchema, body)))
	}
	@Post(':id/join') async join(
		@Req() req: GuestRequest,
		@Param('id') id: string,
		@Headers('idempotency-key') key: unknown,
		@Body() body: unknown,
		@Res({ passthrough: true }) res: Response
	) {
		const owner = guest(req)
		return reply(res, await this.rooms.join(owner.id, id, key, parse(joinSchema, body)))
	}
	@Post(':id/:action') async action(
		@Req() req: GuestRequest,
		@Param('id') id: string,
		@Param('action') action: string,
		@Headers('idempotency-key') key: unknown,
		@Body() body: unknown,
		@Res({ passthrough: true }) res: Response
	) {
		const owner = guest(req)
		if (action === 'guesses') return reply(res, await this.rooms.action(owner.id, id, key, action, parse(roomGuessSchema, body)))
		if (action === 'skip') return reply(res, await this.rooms.action(owner.id, id, key, action, parse(roomSkipSchema, body)))
		if (action === 'start' || action === 'leave' || action === 'retry-preparation') {
			parse(emptySchema, body)
			return reply(res, await this.rooms.action(owner.id, id, key, action, {}))
		}
		res.status(404)
		return { code: 'NOT_FOUND', message: 'Неизвестная команда' }
	}
}
