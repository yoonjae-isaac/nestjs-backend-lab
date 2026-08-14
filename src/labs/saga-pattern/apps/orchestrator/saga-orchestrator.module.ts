import { Module } from '@nestjs/common';

import { ConfigModule } from '../../../../common/config/config.module';
import { LoggerModule } from '../../../../common/logger/logger.module';
import { SagaOrchestratorService } from '../../orchestration/orchestrator/saga-orchestrator.service';
import { SagaInfrastructureModule } from '../../saga-infrastructure.module';

@Module({
  imports: [ConfigModule, LoggerModule, SagaInfrastructureModule],
  providers: [SagaOrchestratorService],
})
export class SagaOrchestratorModule {}
