import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { AppConfig, InfrastructureStatus } from '../config/configuration';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client?: Redis;
  private readonly config: AppConfig['redis'];
  private readonly logger = new Logger(RedisService.name);

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<AppConfig['redis']>('app.redis');
    this.client = this.config.enabled
      ? new Redis(this.config.url, {
          enableOfflineQueue: false,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
        })
      : undefined;
  }

  async onModuleInit(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      await this.client.connect();
    } catch (error: unknown) {
      this.logger.warn({ error, event: 'REDIS_CONNECT_FAILED' });
    }

    const status = await this.status();
    this.logger[status === 'up' ? 'log' : 'warn']({ event: 'REDIS_CONNECTION', status });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client?.status === 'ready') {
      await this.client.quit();
    } else {
      this.client?.disconnect();
    }
  }

  async get(key: string): Promise<string | null> {
    return this.getClient().get(key);
  }

  async set(key: string, value: string): Promise<'OK'> {
    return this.getClient().set(key, value);
  }

  async setWithTtl(key: string, value: string, ttlMs: number): Promise<'OK'> {
    return this.getClient().set(key, value, 'PX', ttlMs);
  }

  async del(key: string): Promise<number> {
    return this.getClient().del(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.getClient().exists(key)) === 1;
  }

  async ttlMs(key: string): Promise<number> {
    return this.getClient().pttl(key);
  }

  isConfigured(): boolean {
    return this.client !== undefined;
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    return (await this.getClient().set(key, value, 'PX', ttlMs, 'NX')) === 'OK';
  }

  async eval(
    script: string,
    keys: readonly string[],
    arguments_: readonly string[],
  ): Promise<unknown> {
    return this.getClient().eval(script, keys.length, ...keys, ...arguments_);
  }

  async status(): Promise<InfrastructureStatus> {
    if (!this.client) {
      return 'not-configured';
    }

    try {
      if (this.client.status === 'wait' || this.client.status === 'end') {
        await this.client.connect();
      }
      return (await this.client.ping()) === 'PONG' ? 'up' : 'down';
    } catch (error: unknown) {
      this.logger.warn({ error, event: 'REDIS_PING_FAILED' });
      return 'down';
    }
  }

  private getClient(): Redis {
    if (!this.client) {
      throw new Error('Redis is not configured for this run');
    }

    return this.client;
  }
}
