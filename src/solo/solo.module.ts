import { Module } from '@nestjs/common'
import { SoloController } from './solo.controller'
import { SoloService } from './solo.service'
@Module({ controllers: [SoloController], providers: [SoloService] })
export class SoloModule {}
