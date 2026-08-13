import { Module } from '@nestjs/common';

import { MysqlModule } from '../database/mysql/mysql.module';
import { PostgresModule } from '../database/postgres/postgres.module';
import { KafkaModule } from '../kafka/kafka.module';
import { RedisModule } from '../redis/redis.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [PostgresModule, MysqlModule, RedisModule, KafkaModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
