import { Worker } from 'node:worker_threads'
import type { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
type OcrWorker = Pick<EventEmitter, 'on' | 'once' | 'off'> & { postMessage(value: unknown): void; terminate(): Promise<number> }
function workerFactory(): OcrWorker {
	const compiled = join(__dirname, 'ocr.worker.js')
	if (existsSync(compiled)) return new Worker(compiled)
	return new Worker("require('ts-node/register/transpile-only');require(require('node:worker_threads').workerData.source)", {
		eval: true,
		workerData: { source: join(__dirname, 'ocr.worker.ts') }
	})
}
export class OcrEngine {
	private worker: OcrWorker | null = null
	constructor(
		private factory: () => OcrWorker = workerFactory,
		private timeoutMs = 10000
	) {}
	async recognize(url: string): Promise<string> {
		const fresh = !this.worker
		const worker = this.worker ?? this.factory()
		this.worker = worker
		if (fresh) worker.on('error', () => undefined)
		let timer: ReturnType<typeof setTimeout> | undefined
		let onMessage: (data: unknown) => void = () => undefined,
			onError: (error: Error) => void = () => undefined,
			onExit: () => void = () => undefined
		try {
			return await new Promise<string>((resolve, reject) => {
				onMessage = (data: unknown) => {
					if (data && typeof data === 'object' && 'text' in data && typeof data.text === 'string')
						resolve(data.text.slice(0, 10000))
					else reject(new Error('OCR failed'))
				}
				onError = () => reject(new Error('OCR worker failed'))
				onExit = () => reject(new Error('OCR worker exited'))
				worker.once('message', onMessage)
				worker.once('error', onError)
				worker.once('exit', onExit)
				timer = setTimeout(() => reject(new Error('OCR timeout')), this.timeoutMs)
				worker.postMessage({ url })
			})
		} catch {
			if (this.worker === worker) this.worker = null
			await worker.terminate().catch(() => undefined)
			throw new Error('OCR unavailable')
		} finally {
			clearTimeout(timer)
			worker.off('message', onMessage)
			worker.off('error', onError)
			worker.off('exit', onExit)
		}
	}
	async close() {
		const worker = this.worker
		this.worker = null
		await worker?.terminate()
	}
}
