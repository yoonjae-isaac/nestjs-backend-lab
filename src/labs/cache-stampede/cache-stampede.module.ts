import { Module } from '@nestjs/common';

import { PostgresModule } from '../../common/database/postgres/postgres.module';
import { RedisModule } from '../../common/redis/redis.module';
import { CacheRecordRepository } from './cache-record.repository';
import { CacheStampedeController } from './cache-stampede.controller';
import { CacheStampedeRepository } from './cache-stampede.repository';
import { CacheStampedeService } from './cache-stampede.service';

@Module({
  imports: [PostgresModule, RedisModule],
  controllers: [CacheStampedeController],
  providers: [CacheRecordRepository, CacheStampedeRepository, CacheStampedeService],
})
export class CacheStampedeModule {}
