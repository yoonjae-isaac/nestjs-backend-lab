import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mysql, { type Pool, type QueryResult } from 'mysql2/promise';

import type { AppConfig, InfrastructureStatus } from '../../config/configuration';

@Injectable()
export class MysqlService implements OnModuleInit, OnModuleDestroy {
  private readonly config: AppConfig['mysql'];
  private readonly logger = new Logger(MysqlService.name);
  private readonly pool?: Pool;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<AppConfig['mysql']>('app.mysql');
    this.pool = this.config.enabled
      ? mysql.createPool({ uri: this.config.url, connectionLimit: this.config.poolMax })
      : undefined;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const status = await this.status();
    this.logger[status === 'up' ? 'log' : 'warn']({ event: 'MYSQL_CONNECTION', status });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  async query<Rows extends QueryResult>(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<Rows> {
    if (!this.pool) {
      throw new Error('MySQL is not configured for this run');
    }

    const [rows] = await this.pool.query<Rows>(statement, [...values]);
    return rows;
  }

  async status(): Promise<InfrastructureStatus> {
    if (!this.pool) {
      return 'not-configured';
    }

    try {
      await this.pool.query('SELECT 1');
      return 'up';
    } catch (error: unknown) {
      this.logger.warn({ error, event: 'MYSQL_PING_FAILED' });
      return 'down';
    }
  }
}
