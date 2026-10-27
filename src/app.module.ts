import { Module } from '@nestjs/common'
import { DatabaseModule } from './database/database.module'
import { SessionsModule } from './sessions/sessions.module'
import { CatalogModule } from './catalog/catalog.module'
import { SoloModule } from './solo/solo.module'
import { RoomsModule } from './rooms/rooms.module'
import { RealtimeModule } from './realtime/realtime.module'
import { SchedulingModule } from './scheduling/scheduling.module'
import { HealthController } from './common/health.controller'
import { ContractsController } from './contracts/contracts.controller'
@Module({
	imports: [DatabaseModule, SessionsModule, CatalogModule, SoloModule, RoomsModule, RealtimeModule, SchedulingModule],
	controllers: [HealthController, ContractsController]
})
export class AppModule {}
