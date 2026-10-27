import type { z } from 'zod'
import type { gameResponseSchema, roomSnapshotSchema, serverEventSchema, clientEventSchema } from './contracts'
export type GameResponse = z.infer<typeof gameResponseSchema>
export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>
export type ServerEvent = z.infer<typeof serverEventSchema>
export type ClientEvent = z.infer<typeof clientEventSchema>
