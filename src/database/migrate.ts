import '../common/environment'
import { Database } from './database'
const db = new Database()
db.migrate()
	.then(() => process.stdout.write('Миграции применены\n'))
	.catch(() => {
		process.stderr.write('Ошибка миграции PostgreSQL\n')
		process.exitCode = 1
	})
	.finally(() => db.onModuleDestroy())
