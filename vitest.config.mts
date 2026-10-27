import { defineConfig } from 'vitest/config'
// Keep Vite's configuration in an explicit ES module.
export default defineConfig({
	test: { include: ['test/**/*.spec.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 }
})
