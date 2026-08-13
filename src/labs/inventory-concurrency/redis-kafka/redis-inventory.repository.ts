import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../common/config/configuration';
import { RedisService } from '../../../common/redis/redis.service';
import {
  INVENTORY_LAB,
  inventoryInitLockKey,
  inventoryStockKey,
  REDIS_DECREASE_SCRIPT,
  REDIS_RELEASE_INIT_LOCK_SCRIPT,
} from '../domain/inventory.constants';
import { InventoryMetricsService } from '../metrics/inventory-metrics.service';
import { InventoryPostgresRepository } from '../postgres/inventory-postgres.repository';

const wait = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

@Injectable()
export class RedisInventoryRepository {
  private readonly config: AppConfig['inventoryConcurrency'];
  private readonly instanceId: string;
  private readonly logger = new Logger(RedisInventoryRepository.name);

  constructor(
    configService: ConfigService,
    private readonly redis: RedisService,
    private readonly postgresRepository: InventoryPostgresRepository,
    private readonly metrics: InventoryMetricsService,
  ) {
    this.config = configService.getOrThrow<AppConfig['inventoryConcurrency']>(
      'app.inventoryConcurrency',
    );
    this.instanceId = configService.getOrThrow<AppConfig['instanceId']>('app.instanceId');
  }

  isConfigured(): boolean {
    return this.redis.isConfigured();
  }

  async reset(skuId: string, stock: number): Promise<void> {
    // 남아 있는 초기화 락을 제거한 뒤 실험 시작 재고를 직접 저장한다.
    await this.redis.del(inventoryInitLockKey(skuId));
    await this.redis.set(inventoryStockKey(skuId), stock.toString());
  }

  async getStock(skuId: string): Promise<number | null> {
    const serializedStock = await this.redis.get(inventoryStockKey(skuId));
    return serializedStock === null ? null : this.parseStock(serializedStock);
  }

  async getOrInitializeStock(skuId: string, requestId: string): Promise<number> {
    // Redis에 재고가 있으면 DB 조회 없이 즉시 사용한다.
    const existingStock = await this.getStock(skuId);
    if (existingStock !== null) {
      return existingStock;
    }

    this.metrics.increment('redisStockMiss');
    this.logger.log(this.logFields('REDIS_STOCK_MISS', skuId, requestId));
    const waitStartedAt = performance.now();
    const waitDeadline = Date.now() + this.config.initLockWaitMs;

    while (Date.now() < waitDeadline) {
      // 캐시 미스가 몰려도 한 요청만 DB에서 재고를 읽도록 SKU별 초기화 락을 시도한다.
      const lockToken = randomUUID();
      const hasLock = await this.redis.setIfAbsent(
        inventoryInitLockKey(skuId),
        lockToken,
        this.config.initLockTtlMs,
      );
      if (hasLock) {
        this.metrics.increment('redisInitLockAcquired');
        this.logger.log(this.logFields('REDIS_INIT_LOCK_ACQUIRED', skuId, requestId));
        try {
          // 락을 기다리는 사이 다른 요청이 초기화했을 수 있으므로 다시 확인한다.
          const doubleCheckedStock = await this.getStock(skuId);
          if (doubleCheckedStock !== null) {
            return doubleCheckedStock;
          }

          // 락 소유자만 PostgreSQL의 재고를 Redis에 적재한다.
          const databaseStock = await this.postgresRepository.findStock(skuId);
          if (databaseStock === null) {
            throw new Error(`Inventory does not exist for SKU ${skuId}`);
          }
          await this.redis.set(inventoryStockKey(skuId), databaseStock.toString());
          this.metrics.increment('redisStockInitialized');
          this.logger.log(this.logFields('REDIS_STOCK_INITIALIZED', skuId, requestId));
          return databaseStock;
        } finally {
          // TTL이 지난 락을 다른 요청이 다시 얻었을 수 있어 토큰이 일치할 때만 해제한다.
          await this.redis.eval(
            REDIS_RELEASE_INIT_LOCK_SCRIPT,
            [inventoryInitLockKey(skuId)],
            [lockToken],
          );
        }
      }

      // 락 획득에 실패한 요청은 짧게 대기하며 초기화된 재고가 나타나는지 확인한다.
      await wait(this.config.initLockRetryMs);
      const initializedStock = await this.getStock(skuId);
      if (initializedStock !== null) {
        this.metrics.observeDuration(
          'redisInitLockWaitDuration',
          performance.now() - waitStartedAt,
        );
        return initializedStock;
      }
    }

    throw new Error(`Timed out initializing Redis inventory for SKU ${skuId}`);
  }

  async decrease(skuId: string, quantity: number): Promise<number | null> {
    const luaStartedAt = performance.now();
    // Lua 스크립트로 재고 부족 확인과 감소를 하나의 Redis 명령처럼 실행한다.
    const executionValue = await this.redis.eval(
      REDIS_DECREASE_SCRIPT,
      [inventoryStockKey(skuId)],
      [quantity.toString()],
    );
    this.metrics.observeDuration('redisLuaDuration', performance.now() - luaStartedAt);

    if (typeof executionValue !== 'number') {
      throw new Error('Redis inventory Lua script returned an invalid value');
    }
    if (executionValue === -1) {
      throw new Error(`Redis inventory was not initialized for SKU ${skuId}`);
    }
    // 스크립트의 -2는 재고 부족, 그 외 숫자는 감소 후 남은 재고다.
    return executionValue === -2 ? null : executionValue;
  }

  private parseStock(serializedStock: string): number {
    const stock = Number.parseInt(serializedStock, 10);
    if (!Number.isSafeInteger(stock) || stock < 0 || stock.toString() !== serializedStock) {
      throw new Error('Redis inventory contains an invalid stock value');
    }
    return stock;
  }

  private logFields(event: string, skuId: string, requestId: string): object {
    return {
      event,
      instanceId: this.instanceId,
      lab: INVENTORY_LAB,
      requestId,
      skuId,
      strategy: 'REDIS_KAFKA',
    };
  }
}
