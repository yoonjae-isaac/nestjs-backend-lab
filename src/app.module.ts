import { Module } from '@nestjs/common';

import { ConfigModule } from './common/config/config.module';
import { HealthModule } from './common/health/health.module';
import { LoggerModule } from './common/logger/logger.module';
import { InventoryConcurrencyModule } from './labs/inventory-concurrency/inventory-concurrency.module';

@Module({
  imports: [ConfigModule, LoggerModule, HealthModule, InventoryConcurrencyModule],
})
export class AppModule {}
