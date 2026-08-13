import { Module } from '@nestjs/common';

import { PostgresModule } from '../../common/database/postgres/postgres.module';
import { KafkaModule } from '../../common/kafka/kafka.module';
import { RedisModule } from '../../common/redis/redis.module';
import { DbAtomicService } from './db-atomic/db-atomic.service';
import { InventoryConcurrencyController } from './inventory-concurrency.controller';
import { InventoryConcurrencyService } from './inventory-concurrency.service';
import { InventoryMetricsService } from './metrics/inventory-metrics.service';
import { NaiveInventoryService } from './naive/naive-inventory.service';
import { InventoryPostgresRepository } from './postgres/inventory-postgres.repository';
import { InventoryEventConsumer } from './redis-kafka/inventory-event.consumer';
import { InventoryEventProducer } from './redis-kafka/inventory-event.producer';
import { RedisInventoryRepository } from './redis-kafka/redis-inventory.repository';
import { RedisInventoryService } from './redis-kafka/redis-inventory.service';

@Module({
  imports: [PostgresModule, RedisModule, KafkaModule],
  controllers: [InventoryConcurrencyController],
  providers: [
    InventoryPostgresRepository,
    InventoryMetricsService,
    InventoryConcurrencyService,
    NaiveInventoryService,
    DbAtomicService,
    RedisInventoryRepository,
    InventoryEventProducer,
    RedisInventoryService,
    InventoryEventConsumer,
  ],
})
export class InventoryConcurrencyModule {}
