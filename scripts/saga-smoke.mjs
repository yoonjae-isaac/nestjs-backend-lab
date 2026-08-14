const baseUrl = process.env.SAGA_BASE_URL ?? 'http://localhost:8089';
const terminalStatuses = new Set(['COMPLETED', 'COMPENSATED', 'COMPENSATION_FAILED', 'FAILED']);

const scenarios = [
  {
    name: 'choreography-success',
    path: 'choreography',
    request: { failAt: 'NONE' },
    status: 'COMPLETED',
    actions: [
      'ORDER_CREATED',
      'INVENTORY_RESERVED',
      'PAYMENT_APPROVED',
      'SHIPPING_CREATED',
      'ORDER_COMPLETED',
    ],
  },
  {
    name: 'choreography-inventory-failure',
    path: 'choreography',
    request: { failAt: 'INVENTORY' },
    status: 'COMPENSATED',
    actions: ['ORDER_CREATED', 'INVENTORY_RESERVATION_FAILED', 'ORDER_CANCELLED'],
  },
  {
    name: 'choreography-payment-failure',
    path: 'choreography',
    request: { failAt: 'PAYMENT' },
    status: 'COMPENSATED',
    actions: [
      'ORDER_CREATED',
      'INVENTORY_RESERVED',
      'PAYMENT_FAILED',
      'INVENTORY_RELEASED',
      'ORDER_CANCELLED',
    ],
  },
  {
    name: 'choreography-shipping-failure',
    path: 'choreography',
    request: { failAt: 'SHIPPING' },
    status: 'COMPENSATED',
    actions: [
      'ORDER_CREATED',
      'INVENTORY_RESERVED',
      'PAYMENT_APPROVED',
      'SHIPPING_FAILED',
      'PAYMENT_CANCELLED',
      'INVENTORY_RELEASED',
      'ORDER_CANCELLED',
    ],
  },
  {
    name: 'choreography-compensation-failure',
    path: 'choreography',
    request: { compensationFailAt: 'INVENTORY', failAt: 'SHIPPING' },
    status: 'COMPENSATION_FAILED',
    actions: [
      'ORDER_CREATED',
      'INVENTORY_RESERVED',
      'PAYMENT_APPROVED',
      'SHIPPING_FAILED',
      'PAYMENT_CANCELLED',
      'INVENTORY_RELEASE_FAILED',
    ],
  },
  {
    name: 'orchestration-success',
    path: 'orchestration',
    request: { failAt: 'NONE' },
    status: 'COMPLETED',
    actions: [
      'ORDER_CREATED',
      'RESERVE_INVENTORY',
      'INVENTORY_RESERVED',
      'APPROVE_PAYMENT',
      'PAYMENT_APPROVED',
      'CREATE_SHIPPING',
      'SHIPPING_CREATED',
      'COMPLETE_ORDER',
      'ORDER_COMPLETED',
    ],
  },
  {
    name: 'orchestration-inventory-failure',
    path: 'orchestration',
    request: { failAt: 'INVENTORY' },
    status: 'COMPENSATED',
    actions: [
      'ORDER_CREATED',
      'RESERVE_INVENTORY',
      'INVENTORY_RESERVATION_FAILED',
      'CANCEL_ORDER',
      'ORDER_CANCELLED',
    ],
  },
  {
    name: 'orchestration-payment-failure',
    path: 'orchestration',
    request: { failAt: 'PAYMENT' },
    status: 'COMPENSATED',
    actions: [
      'ORDER_CREATED',
      'RESERVE_INVENTORY',
      'INVENTORY_RESERVED',
      'APPROVE_PAYMENT',
      'PAYMENT_FAILED',
      'RELEASE_INVENTORY',
      'INVENTORY_RELEASED',
      'CANCEL_ORDER',
      'ORDER_CANCELLED',
    ],
  },
  {
    name: 'orchestration-shipping-failure',
    path: 'orchestration',
    request: { failAt: 'SHIPPING' },
    status: 'COMPENSATED',
    actions: [
      'ORDER_CREATED',
      'RESERVE_INVENTORY',
      'INVENTORY_RESERVED',
      'APPROVE_PAYMENT',
      'PAYMENT_APPROVED',
      'CREATE_SHIPPING',
      'SHIPPING_FAILED',
      'CANCEL_PAYMENT',
      'PAYMENT_CANCELLED',
      'RELEASE_INVENTORY',
      'INVENTORY_RELEASED',
      'CANCEL_ORDER',
      'ORDER_CANCELLED',
    ],
  },
  {
    name: 'orchestration-compensation-failure',
    path: 'orchestration',
    request: { compensationFailAt: 'INVENTORY', failAt: 'SHIPPING' },
    status: 'COMPENSATION_FAILED',
    actions: [
      'ORDER_CREATED',
      'RESERVE_INVENTORY',
      'INVENTORY_RESERVED',
      'APPROVE_PAYMENT',
      'PAYMENT_APPROVED',
      'CREATE_SHIPPING',
      'SHIPPING_FAILED',
      'CANCEL_PAYMENT',
      'PAYMENT_CANCELLED',
      'RELEASE_INVENTORY',
      'INVENTORY_RELEASE_FAILED',
    ],
  },
];

const wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const fetchJson = async (path, init) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
};

const waitForScenario = async (scenario, sagaId) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const saga = await fetchJson(`/labs/saga-pattern/sagas/${sagaId}`);
    const timeline = await fetchJson(`/labs/saga-pattern/sagas/${sagaId}/timeline`);
    const actions = timeline.map((entry) => entry.action);

    // 상태와 recorder timeline이 모두 도착해야 실제 분산 흐름이 끝난 것으로 판정한다.
    if (terminalStatuses.has(saga.status) && actions.length >= scenario.actions.length) {
      if (saga.status !== scenario.status) {
        throw new Error(`${scenario.name}: expected ${scenario.status}, received ${saga.status}`);
      }
      if (JSON.stringify(actions) !== JSON.stringify(scenario.actions)) {
        throw new Error(
          `${scenario.name}: unexpected timeline\n${JSON.stringify(actions, null, 2)}`,
        );
      }
      return actions;
    }
    await wait(100);
  }
  throw new Error(`${scenario.name}: timed out`);
};

await fetchJson('/labs/saga-pattern/reset', { method: 'POST' });

for (const scenario of scenarios) {
  const startedSaga = await fetchJson(`/labs/saga-pattern/${scenario.path}/orders`, {
    body: JSON.stringify(scenario.request),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const actions = await waitForScenario(scenario, startedSaga.sagaId);
  process.stdout.write(
    `${scenario.name}: ${scenario.status} (${actions.length} messages, ${startedSaga.sagaId})\n`,
  );
}
