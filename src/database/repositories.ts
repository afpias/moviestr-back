import { Inject, Injectable } from '@nestjs/common'
import type { PoolClient } from 'pg'
import { Database } from './database'
import { requireCondition as check } from '../common/errors'
import type { PreparedMovie, Room, Player, Solo } from '../common/model'
type RoomData = Omit<Room, 'players' | 'movie' | 'usedMovieIds'>
type PlayerBase = Pick<Player, 'id' | 'nickname' | 'score' | 'connected' | 'lastSeen' | 'left' | 'order'>
type Progress = Pick<Player, 'frameIndex' | 'attemptedMovieIds' | 'status' | 'lastAnswer'>
@Injectable()
export class Repositories {
	constructor(@Inject(Database) readonly db: Database) {}
	async room(c: PoolClient, id: string, lock = true): Promise<Room> {
		const row = (
			await c.query<{ data: RoomData }>('SELECT data FROM rooms WHERE id=$1' + (lock ? ' FOR UPDATE' : ' FOR SHARE'), [id])
		).rows[0]
		check(row, 404, 'ROOM_NOT_FOUND')
		const round = (
			await c.query<{ data: PreparedMovie | null }>(
				'SELECT m.data FROM room_rounds rr LEFT JOIN prepared_movies m ON m.id=rr.movie_id WHERE rr.room_id=$1 AND rr.round_id=$2',
				[id, row.data.roundId]
			)
		).rows[0]
		const players = (
			await c.query<{ data: PlayerBase; progress: Progress | null }>(
				"SELECT p.data,pr.data AS progress FROM room_players p LEFT JOIN player_round_progress pr ON pr.room_id=p.room_id AND pr.player_id=p.player_id AND pr.round_id=$2 WHERE p.room_id=$1 ORDER BY (p.data->>'order')::integer",
				[id, row.data.roundId]
			)
		).rows.map((r) => ({
			...r.data,
			frameIndex: 0,
			attemptedMovieIds: [],
			status: 'playing' as const,
			lastAnswer: null,
			...r.progress
		}))
		const used = (await c.query<{ movie_id: string }>('SELECT movie_id FROM room_used_movies WHERE room_id=$1', [id])).rows.map(
			(r) => r.movie_id
		)
		return { ...row.data, players, movie: round?.data ?? null, usedMovieIds: used }
	}
	async saveRoom(c: PoolClient, r: Room, emit = true) {
		const { players, movie, usedMovieIds, ...data } = r
		await c.query(
			'INSERT INTO rooms(id,data,status,version,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET data=$2,status=$3,version=$4,updated_at=$5',
			[r.id, JSON.stringify(data), r.status, r.version, r.updatedAt]
		)
		if (movie) await this.movie(c, r.roundId, movie)
		await c.query(
			'INSERT INTO room_rounds(room_id,round_id,round_number,movie_id,deadline,generation) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(room_id,round_number) DO UPDATE SET round_id=$2,movie_id=$4,deadline=$5,generation=$6',
			[r.id, r.roundId, r.roundNumber, movie ? r.roundId : null, r.deadline, r.generation]
		)
		await c.query('UPDATE room_players SET active=false WHERE room_id=$1', [r.id])
		await c.query('DELETE FROM room_players WHERE room_id=$1 AND NOT(player_id=ANY($2::uuid[]))', [
			r.id,
			players.map((p) => p.id)
		])
		for (const p of players) {
			const base: PlayerBase = {
				id: p.id,
				nickname: p.nickname,
				score: p.score,
				connected: p.connected,
				lastSeen: p.lastSeen,
				left: p.left,
				order: p.order
			}
			const progress: Progress = {
				frameIndex: p.frameIndex,
				status: p.status,
				attemptedMovieIds: p.attemptedMovieIds,
				lastAnswer: p.lastAnswer
			}
			await c.query(
				'INSERT INTO room_players(room_id,player_id,nickname_normalized,active,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(room_id,player_id) DO UPDATE SET nickname_normalized=$3,active=$4,data=$5',
				[r.id, p.id, p.nickname.toLocaleLowerCase('ru-RU'), !p.left, JSON.stringify(base)]
			)
			await c.query(
				'INSERT INTO player_round_progress(room_id,player_id,round_id,frame_index,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(room_id,player_id,round_id) DO UPDATE SET frame_index=$4,data=$5',
				[r.id, p.id, r.roundId, p.frameIndex, JSON.stringify(progress)]
			)
		}
		for (const id of usedMovieIds)
			await c.query('INSERT INTO room_used_movies(room_id,movie_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [r.id, id])
		if (emit) await this.event(c, r.id, r.version)
	}
	async solo(c: PoolClient, id: string, owner: string, lock = true): Promise<Solo> {
		const row = (
			await c.query<{ data: Omit<Solo, 'movie'>; movie: PreparedMovie | null }>(
				'SELECT g.data,m.data AS movie FROM solo_games g LEFT JOIN prepared_movies m ON m.id=g.movie_id WHERE g.id=$1 AND g.owner=$2' +
					(lock ? ' FOR UPDATE OF g' : ' FOR SHARE OF g'),
				[id, owner]
			)
		).rows[0]
		check(row, 404, 'GAME_NOT_FOUND')
		return { ...row.data, movie: row.movie }
	}
	async saveSolo(c: PoolClient, g: Solo) {
		const { movie, ...data } = g
		if (movie) await this.movie(c, g.id, movie)
		await c.query(
			'INSERT INTO solo_games(id,owner,data,movie_id,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET data=$3,movie_id=$4,updated_at=$5',
			[g.id, g.owner, JSON.stringify(data), movie ? g.id : null, g.updatedAt]
		)
	}
	private async movie(c: PoolClient, id: string, movie: PreparedMovie) {
		await c.query('INSERT INTO prepared_movies(id,tmdb_id,data,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [
			id,
			movie.id,
			JSON.stringify(movie),
			Date.now()
		])
	}
	async event(c: PoolClient, id: string, version: number) {
		await c.query('INSERT INTO event_outbox(aggregate_id,version,created_at) VALUES($1,$2,$3)', [id, version, Date.now()])
	}
}
