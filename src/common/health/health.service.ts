import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig, InfrastructureStatus } from '../config/configuration';
import { MysqlService } from '../database/mysql/mysql.service';
import { PostgresService } from '../database/postgres/postgres.service';
import { KafkaService } from '../kafka/kafka.service';
import { RedisService } from '../redis/redis.service';

export interface HealthResponse {
  instanceId: string;
  status: 'ok';
}

export interface InfrastructureHealthResponse {
  kafka: InfrastructureStatus;
  mysql: InfrastructureStatus;
  postgres: InfrastructureStatus;
  redis: InfrastructureStatus;
}

@Injectable()
export class HealthService {
  private readonly instanceId: string;

  constructor(
    configService: ConfigService,
    private readonly postgres: PostgresService,
    private readonly mysql: MysqlService,
    private readonly redis: RedisService,
    private readonly kafka: KafkaService,
  ) {
    this.instanceId = configService.getOrThrow<AppConfig['instanceId']>('app.instanceId');
  }

  getHealth(): HealthResponse {
    return { status: 'ok', instanceId: this.instanceId };
  }

  async getInfrastructureHealth(): Promise<InfrastructureHealthResponse> {
    const [postgres, mysql, redis, kafka] = await Promise.all([
      this.postgres.status(),
      this.mysql.status(),
      this.redis.status(),
      this.kafka.status(),
    ]);

    return { postgres, mysql, redis, kafka };
  }
}
