import { Logger, type Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../../common/config/configuration';

export const bootstrapSagaWorker = async (rootModule: Type<unknown>): Promise<void> => {
  const application = await NestFactory.createApplicationContext(rootModule, { bufferLogs: true });
  application.useLogger(application.get(PinoLogger));
  application.enableShutdownHooks();

  const configService = application.get(ConfigService);
  const appConfig = configService.getOrThrow<AppConfig>('app');
  new Logger('SagaWorkerBootstrap').log({
    event: 'SAGA_WORKER_STARTED',
    instanceId: appConfig.instanceId,
    serviceRole: appConfig.sagaPattern.serviceRole || 'ORCHESTRATOR',
  });
};
