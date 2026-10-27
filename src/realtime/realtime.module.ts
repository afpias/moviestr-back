import { Module } from '@nestjs/common'
import { SessionsModule } from '../sessions/sessions.module'
import { RoomsModule } from '../rooms/rooms.module'
import { RealtimeService } from './realtime.service'
@Module({ imports: [SessionsModule, RoomsModule], providers: [RealtimeService], exports: [RealtimeService] })
export class RealtimeModule {}
