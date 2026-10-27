import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { OcrEngine } from './ocr-engine'
import { mkdir } from 'node:fs/promises'
import { Database } from '../database/database'
import { hash } from '../common/security'
@Injectable()
export class OcrService implements OnModuleDestroy {
	private engine = new OcrEngine()
	private busy = false
	constructor(@Inject(Database) private db: Database) {}
	async recognize(url: string): Promise<string> {
		const key = hash(`ocr-v1:${url}`)
		const cached = (
			await this.db.query<{ text: string }>('SELECT text FROM ocr_cache WHERE key=$1 AND expires_at>$2', [key, Date.now()])
		).rows[0]
		if (cached) return cached.text
		if (this.busy) throw new Error('OCR busy')
		this.busy = true
		try {
			await mkdir('.cache/tesseract', { recursive: true })
			const text = await this.engine.recognize(url)
			await this.db.query(
				'INSERT INTO ocr_cache(key,text,expires_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET text=$2,expires_at=$3',
				[key, text.slice(0, 10000), Date.now() + 7 * 86400000]
			)
			return text
		} catch {
			throw new Error('OCR unavailable')
		} finally {
			this.busy = false
		}
	}
	async onModuleDestroy() {
		await this.engine.close()
	}
}
