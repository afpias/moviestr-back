import '../src/common/environment'
export function testDatabaseUrl() {
	const url = process.env.TEST_DATABASE_URL ?? 'postgresql://moviestr:moviestr_local@localhost:55432/moviestr_test'
	if (!new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must use a database ending in _test')
	return url
}
