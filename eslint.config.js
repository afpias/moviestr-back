const js = require('@eslint/js')
const ts = require('typescript-eslint')
module.exports = ts.config(js.configs.recommended, ...ts.configs.recommended, {
	rules: {
		'@typescript-eslint/no-explicit-any': 'error',
		'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
	}
})
