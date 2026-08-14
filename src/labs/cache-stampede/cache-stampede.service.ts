import { randomUUID } from 'node:crypto';

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../common/config/configuration';
import { CacheRecordRepository } from './cache-record.repository';
import { CacheStampedeRepository } from './cache-stampede.repository';
import {
  CACHE_STRATEGIES,
  type CacheEntry,
  type CacheReadResponse,
  type CacheState,
  type CacheStrategy,
  type OriginLoadMetric,
  type Product,
} from './domain/cache-stampede.types';

export const calculateJitteredTtl = (
  baseTtlMs: number,
  jitterMs: number,
  randomValue = Math.random(),
): number => {
  const minimumTtl = Math.max(1, baseTtlMs - jitterMs);
  const maximumTtl = baseTtlMs + jitterMs;
  return minimumTtl + Math.floor(randomValue * (maximumTtl - minimumTtl + 1));
};

@Injectable()
export class CacheStampedeService {
  private readonly config: AppConfig['cacheStampede'];
  private readonly instanceId: string;
  private readonly logger = new Logger(CacheStampedeService.name);

  constructor(
    configService: ConfigService,
    private readonly cache: CacheRecordRepository,
    private readonly origin: CacheStampedeRepository,
  ) {
    this.config = configService.getOrThrow<AppConfig['cacheStampede']>('app.cacheStampede');
    this.instanceId = configService.getOrThrow<string>('app.instanceId');
  }

  async getBaseline(productId: string): Promise<CacheReadResponse> {
    this.ensureInfrastructure();
    const cached = await this.cache.get('BASELINE', productId);
    if (cached) {
      return this.toResponse('BASELINE', 'CACHE', cached, false);
    }

    // 비교 기준은 miss를 병합하지 않아 동시에 들어온 요청이 각각 원본을 조회한다.
    const entry = await this.loadAndCache('BASELINE', productId, this.config.baseTtlMs);
    return this.toResponse('BASELINE', 'ORIGIN', entry, false);
  }

  async getWithTtlJitter(productId: string): Promise<CacheReadResponse> {
    this.ensureInfrastructure();
    const cached = await this.cache.get('TTL_JITTER', productId);
    if (cached) {
      return this.toResponse('TTL_JITTER', 'CACHE', cached, false);
    }

    // 각 키에 다른 TTL을 부여해 많은 키가 같은 시각에 원본으로 몰리는 현상을 분산한다.
    const ttlMs = calculateJitteredTtl(this.config.baseTtlMs, this.config.jitterMs);
    const entry = await this.loadAndCache('TTL_JITTER', productId, ttlMs);
    return this.toResponse('TTL_JITTER', 'ORIGIN', entry, false);
  }

  async getWithRefreshAhead(productId: string): Promise<CacheReadResponse> {
    this.ensureInfrastructure();
    const cached = await this.cache.get('REFRESH_AHEAD', productId);
    if (!cached) {
      return this.loadWithSingleFlight('REFRESH_AHEAD', productId, this.config.baseTtlMs);
    }

    const refreshThreshold = Math.min(
      this.config.refreshAheadMs,
      Math.max(1, this.config.baseTtlMs - 1),
    );
    const shouldRefresh = cached.freshUntil - Date.now() <= refreshThreshold;
    if (shouldRefresh) {
      // 인기 키의 hit는 기다리지 않고 한 인스턴스만 만료 전에 갱신하도록 예약한다.
      void this.refreshInBackground('REFRESH_AHEAD', productId, 'REFRESH_AHEAD');
    }
    return this.toResponse('REFRESH_AHEAD', 'CACHE', cached, shouldRefresh);
  }

  async prewarm(productId: string): Promise<CacheReadResponse> {
    this.ensureInfrastructure();
    // 트래픽을 받기 전에 지정한 인기 키를 분산 lock 아래 원본 값으로 채운다.
    return this.forceRefreshWithLock('REFRESH_AHEAD', productId);
  }

  async getWithStaleWhileRevalidate(productId: string): Promise<CacheReadResponse> {
    this.ensureInfrastructure();
    const cached = await this.cache.get('STALE_WHILE_REVALIDATE', productId);
    if (!cached) {
      return this.loadWithSingleFlight(
        'STALE_WHILE_REVALIDATE',
        productId,
        this.config.baseTtlMs + this.config.staleMs,
        this.config.baseTtlMs,
      );
    }

    if (cached.freshUntil > Date.now()) {
      return this.toResponse('STALE_WHILE_REVALIDATE', 'CACHE', cached, false);
    }

    // stale 구간에는 오래된 값을 즉시 돌려주고 한 요청만 뒤에서 갱신한다.
    void this.refreshInBackground('STALE_WHILE_REVALIDATE', productId, 'STALE_WHILE_REVALIDATE');
    return this.toResponse('STALE_WHILE_REVALIDATE', 'STALE', cached, true);
  }

  async getWithSingleFlight(productId: string): Promise<CacheReadResponse> {
    this.ensureInfrastructure();
    return this.loadWithSingleFlight('SINGLE_FLIGHT', productId, this.config.baseTtlMs);
  }

  async updateProduct(productId: string, name: string, priceCents: number): Promise<Product> {
    this.ensureInfrastructure();
    return this.origin.updateProduct(productId, name, priceCents);
  }

  async reset(productCount = 10): Promise<{ productCount: number; strategies: number }> {
    this.ensureInfrastructure();
    const productIds = await this.origin.resetProducts(productCount);
    // DB reset 뒤 알려진 상품의 value/lock key를 모두 지워 다음 요청을 완전한 cold miss로 만든다.
    await this.cache.clear(productIds);
    return { productCount, strategies: CACHE_STRATEGIES.length };
  }

  async getMetrics(productId?: string): Promise<OriginLoadMetric[]> {
    this.ensureInfrastructure();
    return this.origin.getMetrics(productId);
  }

  async getState(productId: string): Promise<CacheState[]> {
    this.ensureInfrastructure();
    return Promise.all(
      CACHE_STRATEGIES.map(async (strategy) => {
        const [entry, ttlMs] = await Promise.all([
          this.cache.get(strategy, productId),
          this.cache.getTtlMs(strategy, productId),
        ]);
        return {
          cachedAt: entry ? new Date(entry.cachedAt).toISOString() : null,
          freshForMs: entry ? Math.max(0, entry.freshUntil - Date.now()) : null,
          hardTtlMs: Math.max(0, ttlMs),
          productVersion: entry?.product.version ?? null,
          strategy,
        };
      }),
    );
  }

  private async loadWithSingleFlight(
    strategy: CacheStrategy,
    productId: string,
    hardTtlMs: number,
    freshTtlMs = hardTtlMs,
  ): Promise<CacheReadResponse> {
    const cached = await this.cache.get(strategy, productId);
    if (cached) {
      return this.toResponse(strategy, 'CACHE', cached, false);
    }

    const ownerToken = randomUUID();
    const lockAcquired = await this.cache.acquireLock(
      strategy,
      productId,
      ownerToken,
      this.config.lockTtlMs,
    );
    if (!lockAcquired) {
      // lock 대기자는 원본으로 우회하지 않고 소유자가 채운 값을 제한 시간 동안 기다린다.
      const waitedEntry = await this.waitForCache(strategy, productId);
      return this.toResponse(strategy, 'CACHE', waitedEntry, false);
    }

    try {
      // lock 획득 전 다른 소유자가 값을 채웠을 수 있으므로 원본 조회 전에 다시 확인한다.
      const doubleChecked = await this.cache.get(strategy, productId);
      if (doubleChecked) {
        return this.toResponse(strategy, 'CACHE', doubleChecked, false);
      }
      const entry = await this.loadAndCache(strategy, productId, hardTtlMs, freshTtlMs);
      return this.toResponse(strategy, 'ORIGIN', entry, false);
    } finally {
      await this.cache.releaseLock(strategy, productId, ownerToken);
    }
  }

  private async forceRefreshWithLock(
    strategy: CacheStrategy,
    productId: string,
  ): Promise<CacheReadResponse> {
    const ownerToken = randomUUID();
    const lockAcquired = await this.cache.acquireLock(
      strategy,
      productId,
      ownerToken,
      this.config.lockTtlMs,
    );
    if (!lockAcquired) {
      const waitedEntry = await this.waitForCache(strategy, productId);
      return this.toResponse(strategy, 'CACHE', waitedEntry, false);
    }

    try {
      const entry = await this.loadAndCache(strategy, productId, this.config.baseTtlMs);
      return this.toResponse(strategy, 'ORIGIN', entry, false);
    } finally {
      await this.cache.releaseLock(strategy, productId, ownerToken);
    }
  }

  private async refreshInBackground(
    strategy: CacheStrategy,
    productId: string,
    mode: 'REFRESH_AHEAD' | 'STALE_WHILE_REVALIDATE',
  ): Promise<void> {
    const ownerToken = randomUUID();
    let lockAcquired = false;
    try {
      lockAcquired = await this.cache.acquireLock(
        strategy,
        productId,
        ownerToken,
        this.config.lockTtlMs,
      );
      if (!lockAcquired) {
        return;
      }

      // lock 안에서 상태를 다시 확인해 여러 인스턴스가 같은 값을 연속 갱신하지 않게 한다.
      const latest = await this.cache.get(strategy, productId);
      if (latest && !this.needsRefresh(latest, mode)) {
        return;
      }

      const hardTtlMs =
        mode === 'STALE_WHILE_REVALIDATE'
          ? this.config.baseTtlMs + this.config.staleMs
          : this.config.baseTtlMs;
      await this.loadAndCache(strategy, productId, hardTtlMs, this.config.baseTtlMs);
    } catch (error: unknown) {
      // 백그라운드 실패는 현재 응답을 뒤집지 않고 로그로 남겨 다음 hit가 다시 시도하게 한다.
      this.logger.error({ error, event: 'CACHE_BACKGROUND_REFRESH_FAILED', productId, strategy });
    } finally {
      if (lockAcquired) {
        await this.cache.releaseLock(strategy, productId, ownerToken).catch(() => undefined);
      }
    }
  }

  private needsRefresh(
    entry: CacheEntry,
    mode: 'REFRESH_AHEAD' | 'STALE_WHILE_REVALIDATE',
  ): boolean {
    if (mode === 'STALE_WHILE_REVALIDATE') {
      return entry.freshUntil <= Date.now();
    }
    const threshold = Math.min(this.config.refreshAheadMs, Math.max(1, this.config.baseTtlMs - 1));
    return entry.freshUntil - Date.now() <= threshold;
  }

  private async loadAndCache(
    strategy: CacheStrategy,
    productId: string,
    hardTtlMs: number,
    freshTtlMs = hardTtlMs,
  ): Promise<CacheEntry> {
    const product = await this.origin.loadOrigin(strategy, productId);
    const now = Date.now();
    const entry: CacheEntry = {
      cachedAt: now,
      freshUntil: now + freshTtlMs,
      hardExpiresAt: now + hardTtlMs,
      product,
    };
    await this.cache.put(strategy, productId, entry, hardTtlMs);
    return entry;
  }

  private async waitForCache(strategy: CacheStrategy, productId: string): Promise<CacheEntry> {
    const deadline = Date.now() + this.config.lockWaitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.config.lockRetryMs));
      const cached = await this.cache.get(strategy, productId);
      if (cached) {
        return cached;
      }
    }
    throw new ServiceUnavailableException(
      `Timed out waiting for ${strategy} cache fill for ${productId}`,
    );
  }

  private toResponse(
    strategy: CacheStrategy,
    source: CacheReadResponse['source'],
    entry: CacheEntry,
    refreshScheduled: boolean,
  ): CacheReadResponse {
    return {
      cacheTtlMs: Math.max(0, entry.hardExpiresAt - Date.now()),
      instanceId: this.instanceId,
      product: entry.product,
      refreshScheduled,
      source,
      strategy,
    };
  }

  private ensureInfrastructure(): void {
    if (!this.cache.isConfigured() || !this.origin.isConfigured()) {
      throw new ServiceUnavailableException(
        'Cache Stampede Lab requires PostgreSQL and Redis to be enabled',
      );
    }
  }
}
