declare module 'ws' {
	import { EventEmitter } from 'node:events'
	import type { Server, IncomingMessage } from 'node:http'
	export class WebSocket extends EventEmitter {
		static OPEN: number
		readyState: number
		constructor(url: string, options?: { origin?: string })
		send(data: string): void
		close(code?: number, reason?: string): void
		terminate(): void
		ping(): void
	}
	export class WebSocketServer extends EventEmitter {
		clients: Set<WebSocket>
		constructor(options: {
			server: Server
			path: string
			maxPayload: number
			verifyClient: (
				info: { origin: string; req: IncomingMessage },
				done: (ok: boolean, code?: number, message?: string) => void
			) => void
		})
		close(callback?: () => void): void
	}
}
