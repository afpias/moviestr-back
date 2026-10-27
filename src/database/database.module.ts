import { Global, Module } from '@nestjs/common'
import { Database } from './database'
import { Repositories } from './repositories'
import { CommandStore } from './commands'
import { Clock } from '../common/clock'
@Global()
@Module({ providers: [Database, Repositories, CommandStore, Clock], exports: [Database, Repositories, CommandStore, Clock] })
export class DatabaseModule {}
