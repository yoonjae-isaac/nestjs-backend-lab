import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const baseUrl = __ENV.BASE_URL ?? 'http://localhost:8088';
const skuId = __ENV.SKU_ID ?? 'SKU-001';
const initialStock = Number.parseInt(__ENV.INITIAL_STOCK ?? '100', 10);
const success = new Counter('inventory_success');
const outOfStock = new Counter('inventory_out_of_stock');
const error = new Counter('inventory_error');
const eventPublishFailure = new Counter('inventory_event_publish_failure');

export const options = {
  scenarios: {
    orders: {
      executor: 'shared-iterations',
      iterations: Number.parseInt(__ENV.REQUESTS ?? '1000', 10),
      maxDuration: __ENV.MAX_DURATION ?? '2m',
      vus: Number.parseInt(__ENV.CONCURRENCY ?? '100', 10),
    },
  },
};

export function setup() {
  const resetResponse = http.post(
    `${baseUrl}/labs/inventory-concurrency/reset`,
    JSON.stringify({ skuId, stock: initialStock }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(resetResponse, { 'reset succeeds': (response) => response.status === 201 });
}

export default function () {
  const response = http.post(
    `${baseUrl}/labs/inventory-concurrency/redis-kafka/orders`,
    JSON.stringify({ skuId, quantity: 1 }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const body = response.json();
  if (body.success === true) {
    success.add(1);
  } else if (body.reason === 'OUT_OF_STOCK') {
    outOfStock.add(1);
  } else {
    error.add(1);
    if (body.reason === 'EVENT_PUBLISH_FAILED') {
      eventPublishFailure.add(1);
    }
  }
  check(response, { 'order response is valid': () => response.status === 201 });
}

export function teardown() {
  const state = http.get(`${baseUrl}/labs/inventory-concurrency/state/${skuId}`);
  console.log(`REDIS_KAFKA state at teardown: ${state.body}`);
}

export function handleSummary(summary) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    [`results/inventory-concurrency/redis-kafka/${timestamp}.json`]: JSON.stringify(
      summary,
      null,
      2,
    ),
    stdout: '\nREDIS_KAFKA result written to results/inventory-concurrency/redis-kafka\n',
  };
}
