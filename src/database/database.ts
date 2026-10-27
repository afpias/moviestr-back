import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
@Injectable()
export class Database implements OnModuleDestroy {
	private readonly logger = new Logger(Database.name)
	readonly pool = new Pool({
		connectionString: process.env.DATABASE_URL,
		max: 10,
		connectionTimeoutMillis: 5000,
		statement_timeout: 10000
	})
	constructor() {
		this.pool.on('error', () => this.logger.warn('PostgreSQL idle connection lost; pool will reconnect'))
	}
	query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
		return this.pool.query<T>(text, values)
	}
	async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const client = await this.pool.connect()
			try {
				await client.query('BEGIN')
				const result = await work(client)
				await client.query('COMMIT')
				return result
			} catch (error) {
				await client.query('ROLLBACK')
				const code = error && typeof error === 'object' && 'code' in error ? error.code : null
				if (attempt < 2 && (code === '40P01' || code === '40001')) continue
				throw error
			} finally {
				client.release()
			}
		}
	}
	async migrate() {
		await this.transaction(async (client) => {
			await client.query('SELECT pg_advisory_xact_lock(81027001)')
			await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY)')
			const dir = join(process.cwd(), 'src/database/migrations')
			for (const name of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
				if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) continue
				await client.query(await readFile(join(dir, name), 'utf8'))
				await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name])
			}
		})
	}
	async onModuleDestroy() {
		await this.pool.end()
	}
}
