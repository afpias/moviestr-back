import { mkdir, writeFile } from 'node:fs/promises'
import { openapi, websocketSchema } from './contracts'
import { format, resolveConfig } from 'prettier'
async function main() {
	await mkdir('docs/api', { recursive: true })
	const config = await resolveConfig('package.json')
	await writeFile('docs/api/openapi.json', await format(JSON.stringify(openapi), { ...config, parser: 'json' }))
	await writeFile('docs/api/websocket.schema.json', await format(JSON.stringify(websocketSchema), { ...config, parser: 'json' }))
}
main().catch(() => {
	process.stderr.write('Ошибка экспорта контрактов\n')
	process.exitCode = 1
})
