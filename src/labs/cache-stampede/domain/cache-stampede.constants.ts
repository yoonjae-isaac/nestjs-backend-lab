import type { CacheStrategy } from './cache-stampede.types';

const CACHE_PREFIX = 'lab:cache-stampede';

export const cacheValueKey = (strategy: CacheStrategy, productId: string): string =>
  `${CACHE_PREFIX}:${strategy.toLowerCase()}:value:${productId}`;

export const cacheLockKey = (strategy: CacheStrategy, productId: string): string =>
  `${CACHE_PREFIX}:${strategy.toLowerCase()}:lock:${productId}`;

export const RELEASE_CACHE_LOCK_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;
