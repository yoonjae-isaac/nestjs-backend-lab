import { ConfigService } from '@nestjs/config';

import type { RedisService } from '../../../common/redis/redis.service';
import { DbAtomicService } from '../db-atomic/db-atomic.service';
import {
  REDIS_DECREASE_SCRIPT,
  REDIS_RELEASE_INIT_LOCK_SCRIPT,
} from '../domain/inventory.constants';
import type {
  AtomicDecreaseRecord,
  ConsumerPersistenceRecord,
  InventoryEvent,
} from '../domain/inventory.types';
import { InventoryMetricsService } from '../metrics/inventory-metrics.service';
import { NaiveInventoryService } from '../naive/naive-inventory.service';
import type { InventoryPostgresRepository } from '../postgres/inventory-postgres.repository';
import { InventoryEventConsumer } from '../redis-kafka/inventory-event.consumer';
import { RedisInventoryRepository } from '../redis-kafka/redis-inventory.repository';

class FakePostgresRepository {
  databaseReadCount = 0;
  private readonly processedEvents = new Set<string>();
  stock = 1;

  findStock(): Promise<number> {
    this.databaseReadCount += 1;
    return Promise.resolve(this.stock);
  }

  writeStockWithoutLock(_skuId: string, stock: number): Promise<void> {
    this.stock = stock;
    return Promise.resolve();
  }

  decreaseAtomically(_skuId: string, quantity: number): Promise<AtomicDecreaseRecord> {
    if (this.stock < quantity) {
      return Promise.resolve({
        queryDurationMs: 1,
        remainingStock: null,
        transactionDurationMs: 1,
      });
    }

    this.stock -= quantity;
    return Promise.resolve({
      queryDurationMs: 1,
      remainingStock: this.stock,
      transactionDurationMs: 1,
    });
  }

  persistInventoryEvent(event: InventoryEvent): Promise<ConsumerPersistenceRecord> {
    if (this.processedEvents.has(event.eventId)) {
      return Promise.resolve({ duplicate: true, remainingStock: null, transactionDurationMs: 1 });
    }

    this.processedEvents.add(event.eventId);
    this.stock -= event.quantity;
    return Promise.resolve({
      duplicate: false,
      remainingStock: this.stock,
      transactionDurationMs: 1,
    });
  }

  getPoolSnapshot(): null {
    return null;
  }
}

class FakeRedisService {
  private readonly values = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, value: string): Promise<'OK'> {
    this.values.set(key, value);
    return Promise.resolve('OK');
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
  }

  isConfigured(): boolean {
    return true;
  }

  setIfAbsent(key: string, value: string): Promise<boolean> {
    if (this.values.has(key)) {
      return Promise.resolve(false);
    }
    this.values.set(key, value);
    return Promise.resolve(true);
  }

  eval(script: string, keys: readonly string[], arguments_: readonly string[]): Promise<number> {
    const key = keys[0];
    const argument = arguments_[0];
    if (key === undefined || argument === undefined) {
      throw new Error('Invalid fake Redis command');
    }

    if (script === REDIS_RELEASE_INIT_LOCK_SCRIPT) {
      if (this.values.get(key) === argument) {
        this.values.delete(key);
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    }
    if (script !== REDIS_DECREASE_SCRIPT) {
      throw new Error('Unknown Lua script');
    }

    const serializedStock = this.values.get(key);
    if (serializedStock === undefined) {
      return Promise.resolve(-1);
    }
    const stock = Number.parseInt(serializedStock, 10);
    const quantity = Number.parseInt(argument, 10);
    if (stock < quantity) {
      return Promise.resolve(-2);
    }
    const remainingStock = stock - quantity;
    this.values.set(key, remainingStock.toString());
    return Promise.resolve(remainingStock);
  }
}

const createConfigService = (): ConfigService =>
  new ConfigService({
    app: {
      instanceId: 'test-instance',
      inventoryConcurrency: {
        consumerDelayMs: 0,
        initLockRetryMs: 1,
        initLockTtlMs: 3_000,
        initLockWaitMs: 1_000,
        naiveDelayMs: 5,
        postgresLockTimeoutMs: 3_000,
        postgresStatementTimeoutMs: 5_000,
      },
    },
  });

const asPostgresRepository = (repository: FakePostgresRepository): InventoryPostgresRepository =>
  repository as unknown as InventoryPostgresRepository;

const createMetrics = (
  configService: ConfigService,
  repository: FakePostgresRepository,
): InventoryMetricsService =>
  new InventoryMetricsService(configService, asPostgresRepository(repository));

describe('inventory concurrency strategies', () => {
  it('reproduces a lost update with the intentionally naive strategy', async () => {
    const configService = createConfigService();
    const repository = new FakePostgresRepository();
    const service = new NaiveInventoryService(
      configService,
      asPostgresRepository(repository),
      createMetrics(configService, repository),
    );

    const responses = await Promise.all([
      service.order({ skuId: 'SKU-001', quantity: 1 }, 'request-1', 5),
      service.order({ skuId: 'SKU-001', quantity: 1 }, 'request-2', 5),
    ]);

    expect(responses.filter((response) => response.success)).toHaveLength(2);
    expect(repository.stock).toBe(0);
  });

  it('allows exactly one DB atomic decrease when stock is one', async () => {
    const configService = createConfigService();
    const repository = new FakePostgresRepository();
    const service = new DbAtomicService(
      configService,
      asPostgresRepository(repository),
      createMetrics(configService, repository),
    );

    const responses = await Promise.all([
      service.order({ skuId: 'SKU-001', quantity: 1 }, 'request-1'),
      service.order({ skuId: 'SKU-001', quantity: 1 }, 'request-2'),
    ]);

    expect(responses.filter((response) => response.success)).toHaveLength(1);
    expect(repository.stock).toBe(0);
  });

  it('allows exactly one Redis Lua decrease when stock is one', async () => {
    const configService = createConfigService();
    const postgresRepository = new FakePostgresRepository();
    const redis = new FakeRedisService();
    const repository = new RedisInventoryRepository(
      configService,
      redis as unknown as RedisService,
      asPostgresRepository(postgresRepository),
      createMetrics(configService, postgresRepository),
    );
    await repository.reset('SKU-001', 1);

    const remainingStocks = await Promise.all([
      repository.decrease('SKU-001', 1),
      repository.decrease('SKU-001', 1),
    ]);

    expect(remainingStocks.filter((stock) => stock === 0)).toHaveLength(1);
    expect(remainingStocks.filter((stock) => stock === null)).toHaveLength(1);
    expect(await repository.getStock('SKU-001')).toBe(0);
  });

  it('initializes a missing Redis stock with one database read', async () => {
    const configService = createConfigService();
    const postgresRepository = new FakePostgresRepository();
    postgresRepository.stock = 100;
    const repository = new RedisInventoryRepository(
      configService,
      new FakeRedisService() as unknown as RedisService,
      asPostgresRepository(postgresRepository),
      createMetrics(configService, postgresRepository),
    );

    const stocks = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        repository.getOrInitializeStock('SKU-001', `request-${index}`),
      ),
    );

    expect(stocks).toEqual(Array.from({ length: 10 }, () => 100));
    expect(postgresRepository.databaseReadCount).toBe(1);
  });

  it('persists the same Kafka event only once', async () => {
    const configService = createConfigService();
    const postgresRepository = new FakePostgresRepository();
    const metrics = createMetrics(configService, postgresRepository);
    const consumer = new InventoryEventConsumer(
      configService,
      {} as never,
      asPostgresRepository(postgresRepository),
      metrics,
    );
    const event: InventoryEvent = {
      eventId: '8b9db738-9b9d-4ebd-a356-78023695d99e',
      eventType: 'INVENTORY_DECREASED',
      instanceId: 'test-instance',
      occurredAt: new Date(0).toISOString(),
      quantity: 1,
      remainingStock: 0,
      requestId: 'request-1',
      skuId: 'SKU-001',
      strategy: 'REDIS_KAFKA',
    };

    await consumer.handleEvent(event);
    await consumer.handleEvent(event);

    expect(postgresRepository.stock).toBe(0);
    expect(metrics.getSnapshot().counters).toMatchObject({
      kafkaConsumerProcessed: 1,
      kafkaDuplicateEvent: 1,
    });
  });
});
