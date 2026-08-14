import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';

import type { AppConfig } from '../../../../common/config/configuration';
import { CacheStampedeGatewayModule } from './cache-stampede-gateway.module';

async function bootstrap(): Promise<void> {
  const application = await NestFactory.create<NestExpressApplication>(CacheStampedeGatewayModule, {
    bufferLogs: true,
  });
  application.useLogger(application.get(PinoLogger));
  application.set('trust proxy', 1);
  application.use(helmet());
  application.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      whitelist: true,
    }),
  );
  application.enableShutdownHooks();

  const configService = application.get(ConfigService);
  const appConfig = configService.getOrThrow<AppConfig>('app');
  await application.listen(appConfig.port, '0.0.0.0');

  new Logger('CacheStampedeBootstrap').log({
    event: 'CACHE_STAMPEDE_GATEWAY_STARTED',
    instanceId: appConfig.instanceId,
    port: appConfig.port,
  });
}

void bootstrap();
