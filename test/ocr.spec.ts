import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { OcrEngine } from '../src/catalog/ocr-engine'
class FakeWorker extends EventEmitter {
	stopped = false
	reply = true
	postMessage() {
		if (this.reply) queueMicrotask(() => this.emit('message', { text: 'Матрица' }))
	}
	async terminate() {
		this.stopped = true
		return 0
	}
}
describe('bounded OCR engine', () => {
	it('reuses a worker without accumulating error listeners', async () => {
		const worker = new FakeWorker()
		const engine = new OcrEngine(() => worker, 100)
		for (let i = 0; i < 20; i++) await engine.recognize('https://image.tmdb.org/test.jpg')
		expect(worker.listenerCount('error')).toBeLessThanOrEqual(1)
		await engine.close()
	})
	it('terminates initialization/recognition if worker never replies and releases for next task', async () => {
		const first = new FakeWorker(),
			next = new FakeWorker()
		first.reply = false
		let calls = 0
		const engine = new OcrEngine(() => (++calls === 1 ? first : next), 20)
		await expect(engine.recognize('https://image.tmdb.org/test.jpg')).rejects.toThrow()
		expect(first.stopped).toBe(true)
		expect(await engine.recognize('https://image.tmdb.org/test.jpg')).toBe('Матрица')
		await engine.close()
		expect(next.stopped).toBe(true)
	})
})
