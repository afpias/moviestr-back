import { Controller, Get } from '@nestjs/common'
import { openapi, websocketSchema } from './contracts'
@Controller('api')
export class ContractsController {
	@Get('openapi.json') openapi() {
		return openapi
	}
	@Get('websocket.schema.json') websocket() {
		return websocketSchema
	}
}
