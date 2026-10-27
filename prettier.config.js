const { prettier } = require('@afpia/prettier')
module.exports = Object.fromEntries(Object.entries(prettier({})).filter(([, value]) => value !== undefined))
