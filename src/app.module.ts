import { Module } from '@nestjs/common';

import { ConfigModule } from './common/config/config.module';
import { HealthModule } from './common/health/health.module';
import { LoggerModule } from './common/logger/logger.module';
import { CacheStampedeModule } from './labs/cache-stampede/cache-stampede.module';
import { InventoryConcurrencyModule } from './labs/inventory-concurrency/inventory-concurrency.module';
import { SagaPatternModule } from './labs/saga-pattern/saga-pattern.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    HealthModule,
    CacheStampedeModule,
    InventoryConcurrencyModule,
    SagaPatternModule,
  ],
})
export class AppModule {}
