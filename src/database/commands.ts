import { Inject, Injectable } from '@nestjs/common'
import type { PoolClient } from 'pg'
import { Database } from './database'
import { hash } from '../common/security'
import { requireCondition as check } from '../common/errors'
export interface Outcome {
	status: number
	body: unknown
}
function stable(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
	return `{${Object.keys(value)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
		.join(',')}}`
}
@Injectable()
export class CommandStore {
	constructor(@Inject(Database) private db: Database) {}
	async run(
		owner: string,
		scope: string,
		key: unknown,
		input: unknown,
		aggregateId: string | null,
		work: (c: PoolClient) => Promise<Outcome>,
		authorize?: (c: PoolClient) => Promise<void>
	): Promise<Outcome> {
		check(typeof key === 'string' && key.length >= 8 && key.length <= 128, 400, 'IDEMPOTENCY_KEY_REQUIRED')
		const requestHash = hash(stable(input))
		return this.db.transaction(async (c) => {
			await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${owner}:${scope}:${key}`])
			check(
				(await c.query('SELECT 1 FROM guest_sessions WHERE id=$1 AND expires_at>$2', [owner, Date.now()])).rowCount,
				401,
				'SESSION_EXPIRED'
			)
			await authorize?.(c)
			const row = (
				await c.query<{ request_hash: string; outcome: Outcome }>(
					'SELECT request_hash,outcome FROM command_deduplication WHERE owner=$1 AND scope=$2 AND key=$3',
					[owner, scope, key]
				)
			).rows[0]
			if (row) {
				check(row.request_hash === requestHash, 409, 'IDEMPOTENCY_CONFLICT')
				return row.outcome
			}
			const outcome = await work(c)
			const body = outcome.body
			const createdId =
				body && typeof body === 'object' ? ('gameId' in body ? body.gameId : 'roomId' in body ? body.roomId : null) : null
			await c.query(
				'INSERT INTO command_deduplication(owner,scope,key,request_hash,outcome,aggregate_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
				[
					owner,
					scope,
					key,
					requestHash,
					JSON.stringify(outcome),
					aggregateId ?? (typeof createdId === 'string' ? createdId : null),
					Date.now()
				]
			)
			return outcome
		})
	}
}
