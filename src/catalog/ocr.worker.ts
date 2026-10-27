import { parentPort } from 'node:worker_threads'
import { createWorker } from 'tesseract.js'
const ready = createWorker(['eng', 'rus'], undefined, { cachePath: '.cache/tesseract' })
// The parent owns the complete lifetime, including language initialization.
parentPort?.on('message', (input: unknown) => {
	void (async () => {
		try {
			if (!input || typeof input !== 'object' || !('url' in input) || typeof input.url !== 'string')
				throw new Error('Invalid OCR input')
			const worker = await ready
			const result = await worker.recognize(input.url)
			parentPort?.postMessage({ text: result.data.text })
		} catch {
			parentPort?.postMessage({ error: 'OCR_FAILED' })
		}
	})()
})
void ready.catch(() => undefined)
