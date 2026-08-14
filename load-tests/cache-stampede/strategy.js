import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const baseUrl = __ENV.BASE_URL ?? 'http://localhost:8090';
const strategy = __ENV.STRATEGY ?? 'baseline';
const productId = __ENV.PRODUCT_ID ?? 'product-1';
const baseTtlMs = Number.parseInt(__ENV.BASE_TTL_MS ?? '1200', 10);
const refreshAheadMs = Number.parseInt(__ENV.REFRESH_AHEAD_MS ?? '500', 10);
const routes = {
  baseline: 'baseline',
  'refresh-ahead': 'refresh-ahead',
  'single-flight': 'single-flight',
  'stale-while-revalidate': 'stale-while-revalidate',
  'ttl-jitter': 'ttl-jitter',
};
const route = routes[strategy];

if (!route) {
  throw new Error(`Unknown STRATEGY: ${strategy}`);
}

const cacheHit = new Counter('cache_hit');
const originLoad = new Counter('origin_load');
const staleHit = new Counter('stale_hit');
const responseError = new Counter('response_error');

export const options = {
  scenarios: {
    cache_reads: {
      executor: 'shared-iterations',
      iterations: Number.parseInt(__ENV.REQUESTS ?? '1000', 10),
      maxDuration: __ENV.MAX_DURATION ?? '2m',
      vus: Number.parseInt(__ENV.CONCURRENCY ?? '100', 10),
    },
  },
};

const jsonHeaders = { 'Content-Type': 'application/json' };

export function setup() {
  const reset = http.post(
    `${baseUrl}/labs/cache-stampede/reset`,
    JSON.stringify({ productCount: 10 }),
    { headers: jsonHeaders },
  );
  check(reset, { 'reset succeeds': (response) => response.status === 201 });

  if (strategy === 'refresh-ahead') {
    http.post(`${baseUrl}/labs/cache-stampede/refresh-ahead/prewarm/${productId}`);
    sleep(Math.max(0.001, (baseTtlMs - refreshAheadMs + 100) / 1000));
    return;
  }

  http.get(`${baseUrl}/labs/cache-stampede/${route}/products/${productId}`);
  if (strategy === 'stale-while-revalidate') {
    http.put(
      `${baseUrl}/labs/cache-stampede/origin/products/${productId}`,
      JSON.stringify({ name: 'Updated Product', priceCents: 20_000 }),
      { headers: jsonHeaders },
    );
  }
  sleep((baseTtlMs + 100) / 1000);
}

export default function () {
  const response = http.get(`${baseUrl}/labs/cache-stampede/${route}/products/${productId}`);
  const validResponse = check(response, {
    'cache response succeeds': (value) => value.status === 200,
  });
  if (!validResponse) {
    responseError.add(1);
    return;
  }

  const source = response.json('source');
  if (source === 'CACHE') {
    cacheHit.add(1);
  } else if (source === 'ORIGIN') {
    originLoad.add(1);
  } else if (source === 'STALE') {
    staleHit.add(1);
  } else {
    responseError.add(1);
  }
}

export function teardown() {
  const metrics = http.get(`${baseUrl}/labs/cache-stampede/metrics`);
  console.log(`${strategy} origin metrics: ${metrics.body}`);
}

export function handleSummary(summary) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    [`results/cache-stampede/${strategy}/${timestamp}.json`]: JSON.stringify(summary, null, 2),
    stdout: `\n${strategy} result written to results/cache-stampede/${strategy}\n`,
  };
}
