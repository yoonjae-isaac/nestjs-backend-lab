import { Module } from '@nestjs/common';

import { ConfigModule } from '../../../../common/config/config.module';
import { HealthModule } from '../../../../common/health/health.module';
import { LoggerModule } from '../../../../common/logger/logger.module';
import { CacheStampedeModule } from '../../cache-stampede.module';

@Module({
  imports: [ConfigModule, LoggerModule, HealthModule, CacheStampedeModule],
})
export class CacheStampedeGatewayModule {}
