import { Module } from '@nestjs/common'
import { RoomsModule } from '../rooms/rooms.module'
import { CatalogModule } from '../catalog/catalog.module'
import { RealtimeModule } from '../realtime/realtime.module'
import { PreparationService } from './preparation.service'
import { SchedulerService } from './scheduler.service'
@Module({
	imports: [RoomsModule, CatalogModule, RealtimeModule],
	providers: [PreparationService, SchedulerService],
	exports: [PreparationService, SchedulerService]
})
export class SchedulingModule {}
