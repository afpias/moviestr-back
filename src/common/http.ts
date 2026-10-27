import type { Response } from 'express'
import type { Outcome } from '../database/commands'
export function reply(res: Response, result: Outcome) {
	res.status(result.status)
	return result.body
}
