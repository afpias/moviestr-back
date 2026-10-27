import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common'
import { Database } from '../database/database'
import { RoomsService } from '../rooms/rooms.service'
import { PreparationService } from './preparation.service'
import { RealtimeService } from '../realtime/realtime.service'
import { Clock } from '../common/clock'
@Injectable()
export class SchedulerService implements OnModuleDestroy {
	private timer?: ReturnType<typeof setInterval>
	private running = false
	private cleanupAt = 0
	constructor(
		@Inject(Database) private db: Database,
		@Inject(RoomsService) private rooms: RoomsService,
		@Inject(PreparationService) private prepare: PreparationService,
		@Inject(RealtimeService) private realtime: RealtimeService,
		@Inject(Clock) private clock: Clock
	) {}
	async start() {
		await this.reconcileRestart()
		this.timer = setInterval(() => {
			void this.tick().catch(() => undefined)
		}, 1000)
		this.timer.unref()
	}
	async reconcileRestart() {
		await this.rooms.reconcile(true)
		await this.db.query(
			"UPDATE preparation_operations SET state='pending',lease_until=NULL,lease_token=NULL WHERE state='working'"
		)
	}
	async tick() {
		if (this.running) return
		this.running = true
		try {
			await this.realtime.reconcilePresence()
			await this.rooms.expireMemberships()
			await this.rooms.reconcile()
			await this.realtime.flush()
			if (this.clock.now() >= this.cleanupAt) {
				await this.cleanup()
				this.cleanupAt = this.clock.now() + 60000
			}
			void this.prepare.tick().catch(() => undefined)
		} finally {
			this.running = false
		}
	}
	private async cleanup() {
		const now = this.clock.now(),
			old = now - 7 * 86400000
		await this.db.transaction(async (c) => {
			const rooms = (
				await c.query<{ id: string }>("SELECT id FROM rooms WHERE status IN ('finished','closed') AND updated_at<$1 FOR UPDATE", [
					old
				])
			).rows
			const games = (await c.query<{ id: string }>('SELECT id FROM solo_games WHERE updated_at<$1 FOR UPDATE', [old])).rows
			const targets = [...rooms, ...games].map((r) => r.id)
			if (targets.length) {
				await c.query('DELETE FROM command_deduplication WHERE aggregate_id=ANY($1::text[])', [targets])
				await c.query('DELETE FROM preparation_operations WHERE target_id=ANY($1::text[])', [targets])
				await c.query('DELETE FROM rooms WHERE id=ANY($1::text[])', [rooms.map((r) => r.id)])
				await c.query('DELETE FROM solo_games WHERE id=ANY($1::uuid[])', [games.map((r) => r.id)])
			}
			await c.query('DELETE FROM realtime_tickets WHERE expires_at<=$1', [now])
			await c.query('DELETE FROM provider_cache WHERE expires_at<=$1', [now])
			await c.query('DELETE FROM ocr_cache WHERE expires_at<=$1', [now])
			await c.query('DELETE FROM event_outbox WHERE delivered AND created_at<$1', [old])
			await c.query(
				'DELETE FROM prepared_movies WHERE NOT EXISTS(SELECT 1 FROM solo_games WHERE movie_id=prepared_movies.id) AND NOT EXISTS(SELECT 1 FROM room_rounds WHERE movie_id=prepared_movies.id)'
			)
			await c.query(
				'DELETE FROM guest_sessions WHERE expires_at<=$1 AND NOT EXISTS(SELECT 1 FROM room_players WHERE player_id=guest_sessions.id AND active)',
				[now]
			)
		})
	}
	onModuleDestroy() {
		clearInterval(this.timer)
	}
}
