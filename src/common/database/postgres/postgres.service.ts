import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

import type { AppConfig, InfrastructureStatus } from '../../config/configuration';

@Injectable()
export class PostgresService implements OnModuleInit, OnModuleDestroy {
  private readonly config: AppConfig['postgres'];
  private readonly logger = new Logger(PostgresService.name);
  private readonly pool?: Pool;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<AppConfig['postgres']>('app.postgres');
    this.pool = this.config.enabled
      ? new Pool({ connectionString: this.config.url, max: this.config.poolMax })
      : undefined;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const status = await this.status();
    this.logger[status === 'up' ? 'log' : 'warn']({ event: 'POSTGRES_CONNECTION', status });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  async query<Row extends QueryResultRow>(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    if (!this.pool) {
      throw new Error('PostgreSQL is not configured for this run');
    }

    return this.pool.query<Row>(statement, [...values]);
  }

  isConfigured(): boolean {
    return this.pool !== undefined;
  }

  getPoolSnapshot(): { idle: number; total: number; waiting: number } | null {
    if (!this.pool) {
      return null;
    }

    return {
      idle: this.pool.idleCount,
      total: this.pool.totalCount,
      waiting: this.pool.waitingCount,
    };
  }

  async withTransaction<Value>(work: (client: PoolClient) => Promise<Value>): Promise<Value> {
    if (!this.pool) {
      throw new Error('PostgreSQL is not configured for this run');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async status(): Promise<InfrastructureStatus> {
    if (!this.pool) {
      return 'not-configured';
    }

    try {
      await this.pool.query('SELECT 1');
      return 'up';
    } catch (error: unknown) {
      this.logger.warn({ error, event: 'POSTGRES_PING_FAILED' });
      return 'down';
    }
  }
}
