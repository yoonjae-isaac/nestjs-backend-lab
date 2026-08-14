export const CACHE_STRATEGIES = [
  'BASELINE',
  'TTL_JITTER',
  'REFRESH_AHEAD',
  'STALE_WHILE_REVALIDATE',
  'SINGLE_FLIGHT',
] as const;

export type CacheStrategy = (typeof CACHE_STRATEGIES)[number];
export type CacheSource = 'CACHE' | 'ORIGIN' | 'STALE';

export interface Product {
  name: string;
  priceCents: number;
  productId: string;
  updatedAt: string;
  version: number;
}

export interface CacheEntry {
  cachedAt: number;
  freshUntil: number;
  hardExpiresAt: number;
  product: Product;
}

export interface CacheReadResponse {
  cacheTtlMs: number;
  instanceId: string;
  product: Product;
  refreshScheduled: boolean;
  source: CacheSource;
  strategy: CacheStrategy;
}

export interface OriginLoadMetric {
  lastLoadedAt: string | null;
  loadCount: number;
  productId: string;
  strategy: CacheStrategy;
}

export interface CacheState {
  cachedAt: string | null;
  freshForMs: number | null;
  hardTtlMs: number;
  productVersion: number | null;
  strategy: CacheStrategy;
}
