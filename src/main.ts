import { createApp } from './bootstrap'
import { Database } from './database/database'
async function main() {
	const app = await createApp()
	await app.get(Database).migrate()
	await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0')
}
main().catch(() => {
	process.stderr.write('Ошибка запуска Moviestr: проверьте конфигурацию и доступность PostgreSQL\n')
	process.exitCode = 1
})
