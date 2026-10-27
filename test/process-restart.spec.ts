import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { Database } from '../src/database/database'
import { testDatabaseUrl } from './database'
import { movie } from './fixtures'
const children: ChildProcess[] = [],
	sockets: WebSocket[] = []
const childCode = `require('reflect-metadata');(async()=>{const {createApp}=require('./src/bootstrap');const app=await createApp({scheduler:process.env.SCHEDULE_ACTIVE==='true'});app.get(require('./src/catalog/catalog.service').CatalogService).prepare=async()=>JSON.parse(process.env.MOVIE_FIXTURE);await app.get(require('./src/scheduling/scheduler.service').SchedulerService).reconcileRestart();await app.listen(0,'127.0.0.1');process.on('message',async command=>{try{if(command==='prepare')await app.get(require('./src/scheduling/preparation.service').PreparationService).tick();if(command==='flush')await app.get(require('./src/realtime/realtime.service').RealtimeService).flush();if(command==='expire')app.get(require('./src/common/clock').Clock).now=()=>Date.now()+91000;process.send({done:command})}catch{process.send({error:'COMMAND_FAILED'})}});process.send({port:app.getHttpServer().address().port})})().catch(()=>process.exit(1));`
async function child(scheduler = false) {
	const databaseUrl = new URL(testDatabaseUrl()),
		tag = `moviestr-idle-${randomUUID()}`
	databaseUrl.searchParams.set('application_name', tag)
	const cp = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', childCode], {
		cwd: process.cwd(),
		env: {
			...process.env,
			DATABASE_URL: databaseUrl.href,
			SCHEDULE_ACTIVE: String(scheduler),
			NODE_ENV: 'test',
			TS_NODE_FILES: 'true',
			MOVIE_FIXTURE: JSON.stringify(movie)
		},
		stdio: ['ignore', 'ignore', 'ignore', 'ipc']
	})
	children.push(cp)
	const port = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => reject(Error('child start timeout')), 10000)
		cp.once('message', (message: unknown) => {
			clearTimeout(timer)
			if (message && typeof message === 'object' && 'port' in message && typeof message.port === 'number') resolve(message.port)
			else reject(Error('no port'))
		})
		cp.once('exit', () => {
			clearTimeout(timer)
			reject(Error('child exited'))
		})
	})
	return { cp, tag, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` }
}
async function command(cp: ChildProcess, name: string) {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(Error('child command timeout')), 10000)
		cp.once('message', (m: unknown) => {
			clearTimeout(timer)
			if (m && typeof m === 'object' && 'done' in m && m.done === name) resolve()
			else reject(Error('child command failed'))
		})
		cp.send(name)
	})
}
function event(ws: WebSocket, name: string) {
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const timer = setTimeout(() => reject(Error(`event ${name} timeout`)), 5000)
		const listener = (raw: Buffer) => {
			const m = JSON.parse(raw.toString()) as { event: string; data: Record<string, unknown> }
			if (m.event === name) {
				clearTimeout(timer)
				ws.off('message', listener)
				resolve(m.data)
			}
		}
		ws.on('message', listener)
	})
}
async function call(base: string, path: string, body?: unknown, cookie?: string) {
	const r = await fetch(base + path, {
		method: body === undefined ? 'GET' : 'POST',
		headers: {
			...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
			...(cookie ? { Cookie: cookie } : {})
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	})
	return {
		status: r.status,
		body: (await r.json()) as Record<string, unknown>,
		cookie: r.headers.get('set-cookie')?.split(';')[0]
	}
}
async function connect(server: Awaited<ReturnType<typeof child>>, cookie: string, roomId: string) {
	const t = await call(server.base, '/api/v1/realtime-tickets', { roomId }, cookie)
	const ws = new WebSocket(server.ws, { origin: 'http://localhost:5173' })
	sockets.push(ws)
	const ready = event(ws, 'session.ready')
	await new Promise<void>((resolve) => ws.once('open', resolve))
	ws.send(JSON.stringify({ event: 'session.auth', data: { ticket: t.body.ticket } }))
	await ready
	const snapshot = event(ws, 'room.snapshot')
	ws.send(JSON.stringify({ event: 'room.subscribe', data: { roomId } }))
	await snapshot
	return ws
}
describe('hard process restart', () => {
	let db: Database
	beforeAll(async () => {
		process.env.DATABASE_URL = testDatabaseUrl()
		db = new Database()
		await db.migrate()
		await db.query('TRUNCATE guest_sessions,rooms,prepared_movies,event_outbox CASCADE')
	})
	afterEach(async () => {
		sockets.splice(0).forEach((s) => s.terminate())
		await Promise.all(
			children.splice(0).map(
				(c) =>
					new Promise<void>((resolve) => {
						if (c.exitCode !== null || c.signalCode !== null) {
							resolve()
							return
						}
						c.once('exit', () => resolve())
						c.kill('SIGKILL')
					})
			)
		)
	})
	it('survives loss of its idle PostgreSQL connection and recovers readiness', async () => {
		const server = await child()
		const victims = (await db.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [server.tag]))
			.rows
		expect(victims.length).toBeGreaterThan(0)
		for (const row of victims) await db.query('SELECT pg_terminate_backend($1)', [row.pid])
		await new Promise((r) => setTimeout(r, 50))
		expect(server.cp.exitCode).toBeNull()
		expect((await call(server.base, '/health/ready')).status).toBe(200)
	})
	it('expires the round via server interval without browser requests', async () => {
		const server = await child(true)
		const a = await call(server.base, '/api/v1/guest-sessions', {}),
			b = await call(server.base, '/api/v1/guest-sessions', {})
		const created = await call(
			server.base,
			'/api/v1/rooms',
			{ nickname: 'Хост', settings: { name: 'Server timer', filmCount: 1 } },
			a.cookie
		)
		const id = created.body.roomId as string
		await call(server.base, `/api/v1/rooms/${id}/join`, { nickname: 'Гость' }, b.cookie)
		await connect(server, a.cookie!, id)
		await connect(server, b.cookie!, id)
		expect((await call(server.base, `/api/v1/rooms/${id}/start`, {}, a.cookie)).status).toBe(200)
		await command(server.cp, 'prepare')
		await command(server.cp, 'expire')
		await new Promise((r) => setTimeout(r, 1500))
		const finished = await call(server.base, `/api/v1/rooms/${id}`, undefined, a.cookie)
		expect(finished.body.status).toBe('finished')
		expect((finished.body.players as { score: number }[]).map((p) => p.score)).toEqual([950, 950])
	})
	afterAll(async () => {
		sockets.forEach((s) => s.terminate())
		children.forEach((c) => {
			if (c.exitCode === null) c.kill('SIGKILL')
		})
		await db.onModuleDestroy()
	})
	it('recovers committed score/frame/attempts and undelivered outbox after process death', async () => {
		let server = await child()
		const a = await call(server.base, '/api/v1/guest-sessions', {}),
			b = await call(server.base, '/api/v1/guest-sessions', {})
		const created = await call(
			server.base,
			'/api/v1/rooms',
			{ nickname: 'Аня', settings: { name: 'Crash', filmCount: 2 } },
			a.cookie
		)
		expect(created.status).toBe(201)
		const id = created.body.roomId as string
		await call(server.base, `/api/v1/rooms/${id}/join`, { nickname: 'Боря' }, b.cookie)
		await connect(server, a.cookie!, id)
		await connect(server, b.cookie!, id)
		expect((await call(server.base, `/api/v1/rooms/${id}/start`, {}, a.cookie)).status).toBe(200)
		await command(server.cp, 'prepare')
		const playing = await call(server.base, `/api/v1/rooms/${id}`, undefined, a.cookie)
		expect(
			(
				await call(
					server.base,
					`/api/v1/rooms/${id}/guesses`,
					{ roundId: playing.body.roundId, movieId: 'tmdb-1', expectedFrameIndex: 0 },
					a.cookie
				)
			).status
		).toBe(200)
		expect(
			(await db.query('SELECT count(*)::int AS n FROM event_outbox WHERE aggregate_id=$1 AND NOT delivered', [id])).rows[0]?.n
		).toBeGreaterThan(0)
		const dead = new Promise<void>((resolve) => server.cp.once('exit', () => resolve()))
		server.cp.kill('SIGKILL')
		await dead
		server = await child()
		const recovered = await call(server.base, `/api/v1/rooms/${id}`, undefined, a.cookie)
		expect(recovered.body.status).toBe('playing')
		expect((recovered.body.currentFrame as { index: number }).index).toBe(1)
		expect(recovered.body.attemptedMovieIds).toEqual(['tmdb-1'])
		expect((recovered.body.players as { id: string; score: number }[]).find((p) => p.id === a.body.participantId)?.score).toBe(
			950
		)
		await connect(server, a.cookie!, id)
		await command(server.cp, 'flush')
		expect(
			(await db.query('SELECT count(*)::int AS n FROM event_outbox WHERE aggregate_id=$1 AND NOT delivered', [id])).rows[0]?.n
		).toBe(0)
	})
})
