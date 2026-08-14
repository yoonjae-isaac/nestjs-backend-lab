import { ConfigService } from '@nestjs/config';

import type { CacheRecordRepository } from '../cache-record.repository';
import type { CacheStampedeRepository } from '../cache-stampede.repository';
import { CacheStampedeService, calculateJitteredTtl } from '../cache-stampede.service';
import type {
  CacheEntry,
  CacheStrategy,
  OriginLoadMetric,
  Product,
} from '../domain/cache-stampede.types';

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

class FakeCacheRepository {
  private readonly entries = new Map<string, { entry: CacheEntry; expiresAt: number }>();
  private readonly locks = new Map<string, { expiresAt: number; owner: string }>();

  isConfigured(): boolean {
    return true;
  }

  get(strategy: CacheStrategy, productId: string): Promise<CacheEntry | null> {
    const cached = this.entries.get(`${strategy}:${productId}`);
    if (!cached || cached.expiresAt <= Date.now()) {
      return Promise.resolve(null);
    }
    return Promise.resolve(cached.entry);
  }

  put(strategy: CacheStrategy, productId: string, entry: CacheEntry, ttlMs: number): Promise<void> {
    this.entries.set(`${strategy}:${productId}`, { entry, expiresAt: Date.now() + ttlMs });
    return Promise.resolve();
  }

  getTtlMs(strategy: CacheStrategy, productId: string): Promise<number> {
    const cached = this.entries.get(`${strategy}:${productId}`);
    return Promise.resolve(cached ? cached.expiresAt - Date.now() : -2);
  }

  acquireLock(
    strategy: CacheStrategy,
    productId: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    const key = `${strategy}:${productId}`;
    const current = this.locks.get(key);
    if (current && current.expiresAt > Date.now()) {
      return Promise.resolve(false);
    }
    this.locks.set(key, { expiresAt: Date.now() + ttlMs, owner });
    return Promise.resolve(true);
  }

  releaseLock(strategy: CacheStrategy, productId: string, owner: string): Promise<void> {
    const key = `${strategy}:${productId}`;
    if (this.locks.get(key)?.owner === owner) {
      this.locks.delete(key);
    }
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.entries.clear();
    this.locks.clear();
    return Promise.resolve();
  }
}

class FakeOriginRepository {
  private readonly counts = new Map<CacheStrategy, number>();
  private product: Product = {
    name: 'Product 1',
    priceCents: 10_000,
    productId: 'product-1',
    updatedAt: new Date(0).toISOString(),
    version: 1,
  };

  constructor(private readonly delayMs: number) {}

  isConfigured(): boolean {
    return true;
  }

  async loadOrigin(strategy: CacheStrategy): Promise<Product> {
    this.counts.set(strategy, (this.counts.get(strategy) ?? 0) + 1);
    await wait(this.delayMs);
    return { ...this.product };
  }

  updateProduct(_productId: string, name: string, priceCents: number): Promise<Product> {
    this.product = {
      ...this.product,
      name,
      priceCents,
      updatedAt: new Date().toISOString(),
      version: this.product.version + 1,
    };
    return Promise.resolve({ ...this.product });
  }

  resetProducts(): Promise<string[]> {
    this.counts.clear();
    return Promise.resolve(['product-1']);
  }

  getMetrics(): Promise<OriginLoadMetric[]> {
    return Promise.resolve(
      [...this.counts.entries()].map(([strategy, loadCount]) => ({
        lastLoadedAt: null,
        loadCount,
        productId: 'product-1',
        strategy,
      })),
    );
  }

  count(strategy: CacheStrategy): number {
    return this.counts.get(strategy) ?? 0;
  }
}

const createService = (): {
  origin: FakeOriginRepository;
  service: CacheStampedeService;
} => {
  const config = new ConfigService({
    app: {
      cacheStampede: {
        baseTtlMs: 80,
        jitterMs: 20,
        lockRetryMs: 2,
        lockTtlMs: 500,
        lockWaitMs: 500,
        originDelayMs: 15,
        refreshAheadMs: 30,
        staleMs: 120,
      },
      instanceId: 'test-instance',
    },
  });
  const cache = new FakeCacheRepository();
  const origin = new FakeOriginRepository(15);
  return {
    origin,
    service: new CacheStampedeService(
      config,
      cache as unknown as CacheRecordRepository,
      origin as unknown as CacheStampedeRepository,
    ),
  };
};

describe('CacheStampedeService', () => {
  it('keeps jittered TTL inside the configured range', () => {
    expect(calculateJitteredTtl(1_000, 200, 0)).toBe(800);
    expect(calculateJitteredTtl(1_000, 200, 0.999_999)).toBe(1_200);
  });

  it('lets every concurrent baseline miss load the origin', async () => {
    const { origin, service } = createService();

    await Promise.all(Array.from({ length: 20 }, () => service.getBaseline('product-1')));

    expect(origin.count('BASELINE')).toBe(20);
  });

  it('coalesces concurrent misses into one origin load with single flight', async () => {
    const { origin, service } = createService();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => service.getWithSingleFlight('product-1')),
    );

    expect(origin.count('SINGLE_FLIGHT')).toBe(1);
    expect(responses.filter((response) => response.source === 'ORIGIN')).toHaveLength(1);
  });

  it('serves stale values while one request revalidates in the background', async () => {
    const { origin, service } = createService();
    await service.getWithStaleWhileRevalidate('product-1');
    await service.updateProduct('product-1', 'Updated Product', 20_000);
    await wait(85);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => service.getWithStaleWhileRevalidate('product-1')),
    );
    expect(responses.every((response) => response.source === 'STALE')).toBe(true);
    expect(responses.every((response) => response.product.version === 1)).toBe(true);

    await wait(25);
    const refreshed = await service.getWithStaleWhileRevalidate('product-1');
    expect(refreshed.product.version).toBe(2);
    expect(origin.count('STALE_WHILE_REVALIDATE')).toBe(2);
  });

  it('refreshes an expiring popular key before its original TTL ends', async () => {
    const { origin, service } = createService();
    await service.prewarm('product-1');
    await service.updateProduct('product-1', 'Updated Product', 20_000);
    await wait(55);

    const response = await service.getWithRefreshAhead('product-1');
    expect(response.source).toBe('CACHE');
    expect(response.product.version).toBe(1);
    expect(response.refreshScheduled).toBe(true);

    await wait(25);
    const refreshed = await service.getWithRefreshAhead('product-1');
    expect(refreshed.product.version).toBe(2);
    expect(origin.count('REFRESH_AHEAD')).toBe(2);
  });
});
