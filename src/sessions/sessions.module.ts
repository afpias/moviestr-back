import { Module } from '@nestjs/common'
import { SessionsController, SessionsService } from './sessions'
@Module({ controllers: [SessionsController], providers: [SessionsService], exports: [SessionsService] })
export class SessionsModule {}
