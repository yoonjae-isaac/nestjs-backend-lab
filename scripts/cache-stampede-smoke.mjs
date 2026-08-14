import assert from 'node:assert/strict';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:8090';
const baseTtlMs = Number.parseInt(process.env.CACHE_STAMPEDE_BASE_TTL_MS ?? '1200', 10);
const refreshAheadMs = Number.parseInt(process.env.CACHE_STAMPEDE_REFRESH_AHEAD_MS ?? '500', 10);
const concurrency = Number.parseInt(process.env.CONCURRENCY ?? '30', 10);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const requestJson = async (path, init) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  assert.ok(response.ok, `${init?.method ?? 'GET'} ${path} failed: ${JSON.stringify(body)}`);
  return body;
};

const metricCount = async (strategy, productId) => {
  const metrics = await requestJson('/labs/cache-stampede/metrics');
  return (
    metrics.find((metric) => metric.strategy === strategy && metric.productId === productId)
      ?.loadCount ?? 0
  );
};

const waitFor = async (predicate, description, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
};

const getConcurrently = (path) =>
  Promise.all(Array.from({ length: concurrency }, () => requestJson(path)));

const jsonHeaders = { 'Content-Type': 'application/json' };

await requestJson('/labs/cache-stampede/reset', {
  body: JSON.stringify({ productCount: 10 }),
  headers: jsonHeaders,
  method: 'POST',
});

const instanceIds = new Set(
  await Promise.all(
    Array.from({ length: 12 }, async () => (await requestJson('/health')).instanceId),
  ),
);
assert.ok(instanceIds.size >= 2, 'nginx did not distribute requests across app instances');

await requestJson('/labs/cache-stampede/baseline/products/product-1');
await sleep(baseTtlMs + 100);
const baselineBefore = await metricCount('BASELINE', 'product-1');
const baselineResponses = await getConcurrently('/labs/cache-stampede/baseline/products/product-1');
const baselineAfter = await metricCount('BASELINE', 'product-1');
assert.equal(baselineAfter - baselineBefore, concurrency);
assert.equal(
  baselineResponses.filter((response) => response.source === 'ORIGIN').length,
  concurrency,
);

const jitterResponses = await Promise.all(
  Array.from({ length: 10 }, (_, index) =>
    requestJson(`/labs/cache-stampede/ttl-jitter/products/product-${index + 1}`),
  ),
);
const jitteredTtls = new Set(jitterResponses.map((response) => response.cacheTtlMs));
assert.ok(jitteredTtls.size >= 3, 'TTL jitter did not produce a useful expiry spread');

await requestJson('/labs/cache-stampede/refresh-ahead/prewarm/product-2', { method: 'POST' });
await requestJson('/labs/cache-stampede/origin/products/product-2', {
  body: JSON.stringify({ name: 'Refresh Ahead Product', priceCents: 22_000 }),
  headers: jsonHeaders,
  method: 'PUT',
});
await sleep(Math.max(1, baseTtlMs - refreshAheadMs + 100));
const refreshAheadHit = await requestJson('/labs/cache-stampede/refresh-ahead/products/product-2');
assert.equal(refreshAheadHit.source, 'CACHE');
assert.equal(refreshAheadHit.product.version, 1);
assert.equal(refreshAheadHit.refreshScheduled, true);
await waitFor(
  async () => (await metricCount('REFRESH_AHEAD', 'product-2')) === 2,
  'Refresh Ahead background load',
);
const refreshedAhead = await waitFor(async () => {
  const response = await requestJson('/labs/cache-stampede/refresh-ahead/products/product-2');
  return response.product.version === 2 ? response : null;
}, 'Refresh Ahead version 2');
assert.equal(refreshedAhead.source, 'CACHE');

await requestJson('/labs/cache-stampede/stale-while-revalidate/products/product-3');
await requestJson('/labs/cache-stampede/origin/products/product-3', {
  body: JSON.stringify({ name: 'SWR Product', priceCents: 33_000 }),
  headers: jsonHeaders,
  method: 'PUT',
});
await sleep(baseTtlMs + 100);
const staleBefore = await metricCount('STALE_WHILE_REVALIDATE', 'product-3');
const staleResponses = await getConcurrently(
  '/labs/cache-stampede/stale-while-revalidate/products/product-3',
);
assert.ok(staleResponses.every((response) => response.source === 'STALE'));
assert.ok(staleResponses.every((response) => response.product.version === 1));
await waitFor(
  async () => (await metricCount('STALE_WHILE_REVALIDATE', 'product-3')) === staleBefore + 1,
  'SWR background load',
);
const revalidated = await waitFor(async () => {
  const response = await requestJson(
    '/labs/cache-stampede/stale-while-revalidate/products/product-3',
  );
  return response.product.version === 2 ? response : null;
}, 'SWR version 2');
assert.notEqual(revalidated.source, 'ORIGIN');

await requestJson('/labs/cache-stampede/single-flight/products/product-4');
await sleep(baseTtlMs + 100);
const singleFlightBefore = await metricCount('SINGLE_FLIGHT', 'product-4');
const singleFlightResponses = await getConcurrently(
  '/labs/cache-stampede/single-flight/products/product-4',
);
const singleFlightAfter = await metricCount('SINGLE_FLIGHT', 'product-4');
assert.equal(singleFlightAfter - singleFlightBefore, 1);
assert.equal(singleFlightResponses.filter((response) => response.source === 'ORIGIN').length, 1);

process.stdout.write(
  `${JSON.stringify(
    {
      baselineConcurrentOriginLoads: baselineAfter - baselineBefore,
      concurrency,
      instancesObserved: [...instanceIds],
      refreshAheadOriginLoads: await metricCount('REFRESH_AHEAD', 'product-2'),
      singleFlightConcurrentOriginLoads: singleFlightAfter - singleFlightBefore,
      staleWhileRevalidateConcurrentOriginLoads:
        (await metricCount('STALE_WHILE_REVALIDATE', 'product-3')) - staleBefore,
      ttlJitterDistinctTtls: jitteredTtls.size,
    },
    null,
    2,
  )}\n`,
);
