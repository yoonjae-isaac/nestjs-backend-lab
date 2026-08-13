import { randomUUID } from 'node:crypto';

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule, type Params } from 'nestjs-pino';

import { ConfigModule } from '../config/config.module';
import type { AppConfig } from '../config/configuration';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Params => {
        const appConfig = configService.getOrThrow<AppConfig>('app');

        return {
          pinoHttp: {
            autoLogging: {
              ignore: (request) => request.url === '/health',
            },
            customProps: () => ({ instanceId: appConfig.instanceId }),
            genReqId: (request, response) => {
              const requestId = request.headers['x-request-id']?.toString() ?? randomUUID();
              response.setHeader('x-request-id', requestId);
              return requestId;
            },
            level: appConfig.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            transport:
              appConfig.env === 'production'
                ? undefined
                : {
                    target: 'pino-pretty',
                    options: { colorize: true, singleLine: true },
                  },
          },
        };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
