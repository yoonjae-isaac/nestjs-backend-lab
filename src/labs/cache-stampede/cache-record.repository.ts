import { Injectable } from '@nestjs/common';

import { RedisService } from '../../common/redis/redis.service';
import {
  cacheLockKey,
  cacheValueKey,
  RELEASE_CACHE_LOCK_SCRIPT,
} from './domain/cache-stampede.constants';
import type { CacheEntry, CacheStrategy } from './domain/cache-stampede.types';

@Injectable()
export class CacheRecordRepository {
  constructor(private readonly redis: RedisService) {}

  isConfigured(): boolean {
    return this.redis.isConfigured();
  }

  async get(strategy: CacheStrategy, productId: string): Promise<CacheEntry | null> {
    const key = cacheValueKey(strategy, productId);
    const serializedEntry = await this.redis.get(key);
    if (!serializedEntry) {
      return null;
    }

    try {
      return JSON.parse(serializedEntry) as CacheEntry;
    } catch {
      // 손상된 값은 miss로 처리하고 다음 요청이 정상 레코드로 교체하게 한다.
      await this.redis.del(key);
      return null;
    }
  }

  async put(
    strategy: CacheStrategy,
    productId: string,
    entry: CacheEntry,
    ttlMs: number,
  ): Promise<void> {
    await this.redis.setWithTtl(cacheValueKey(strategy, productId), JSON.stringify(entry), ttlMs);
  }

  async getTtlMs(strategy: CacheStrategy, productId: string): Promise<number> {
    return this.redis.ttlMs(cacheValueKey(strategy, productId));
  }

  async acquireLock(
    strategy: CacheStrategy,
    productId: string,
    ownerToken: string,
    ttlMs: number,
  ): Promise<boolean> {
    return this.redis.setIfAbsent(cacheLockKey(strategy, productId), ownerToken, ttlMs);
  }

  async releaseLock(strategy: CacheStrategy, productId: string, ownerToken: string): Promise<void> {
    // lock 소유자 token이 일치할 때만 삭제해 다른 요청의 새 lock을 지우지 않는다.
    await this.redis.eval(
      RELEASE_CACHE_LOCK_SCRIPT,
      [cacheLockKey(strategy, productId)],
      [ownerToken],
    );
  }

  async clear(productIds: readonly string[]): Promise<void> {
    await Promise.all(
      productIds.flatMap((productId) =>
        (
          [
            'BASELINE',
            'TTL_JITTER',
            'REFRESH_AHEAD',
            'STALE_WHILE_REVALIDATE',
            'SINGLE_FLIGHT',
          ] as const
        ).flatMap((strategy) => [
          this.redis.del(cacheValueKey(strategy, productId)),
          this.redis.del(cacheLockKey(strategy, productId)),
        ]),
      ),
    );
  }
}
