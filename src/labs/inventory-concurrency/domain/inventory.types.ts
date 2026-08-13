export type InventoryStrategy = 'NAIVE' | 'DB_ATOMIC' | 'REDIS_KAFKA';
export type InventoryFailureReason =
  'OUT_OF_STOCK' | 'EVENT_PUBLISH_FAILED' | 'INFRASTRUCTURE_ERROR';

export interface InventoryOrderSuccess {
  instanceId: string;
  remainingStock: number;
  strategy: InventoryStrategy;
  success: true;
}

export interface InventoryOrderFailure {
  instanceId: string;
  inventoryChanged?: boolean;
  reason: InventoryFailureReason;
  remainingStock?: number;
  strategy: InventoryStrategy;
  success: false;
}

export type InventoryOrderResponse = InventoryOrderSuccess | InventoryOrderFailure;

export interface InventoryEvent {
  eventId: string;
  eventType: 'INVENTORY_DECREASED';
  instanceId: string;
  occurredAt: string;
  quantity: number;
  remainingStock: number;
  requestId: string;
  skuId: string;
  strategy: 'REDIS_KAFKA';
}

export const parseInventoryEvent = (serializedEvent: string): InventoryEvent => {
  // 외부 메시지는 신뢰하지 않고 런타임에서 이벤트 계약을 모두 확인한다.
  const parsedEvent: unknown = JSON.parse(serializedEvent);
  if (
    typeof parsedEvent !== 'object' ||
    parsedEvent === null ||
    !('eventId' in parsedEvent) ||
    typeof parsedEvent.eventId !== 'string' ||
    !('eventType' in parsedEvent) ||
    parsedEvent.eventType !== 'INVENTORY_DECREASED' ||
    !('instanceId' in parsedEvent) ||
    typeof parsedEvent.instanceId !== 'string' ||
    !('occurredAt' in parsedEvent) ||
    typeof parsedEvent.occurredAt !== 'string' ||
    !('quantity' in parsedEvent) ||
    typeof parsedEvent.quantity !== 'number' ||
    !('remainingStock' in parsedEvent) ||
    typeof parsedEvent.remainingStock !== 'number' ||
    !('requestId' in parsedEvent) ||
    typeof parsedEvent.requestId !== 'string' ||
    !('skuId' in parsedEvent) ||
    typeof parsedEvent.skuId !== 'string' ||
    !('strategy' in parsedEvent) ||
    parsedEvent.strategy !== 'REDIS_KAFKA'
  ) {
    throw new Error('Invalid inventory event');
  }

  return parsedEvent as InventoryEvent;
};

export interface InventoryState {
  difference: number | null;
  postgresStock: number | null;
  redisStock: number | null;
  skuId: string;
}

export interface AtomicDecreaseRecord {
  queryDurationMs: number;
  remainingStock: number | null;
  transactionDurationMs: number;
}

export interface ConsumerPersistenceRecord {
  duplicate: boolean;
  remainingStock: number | null;
  transactionDurationMs: number;
}

export interface StrategyMetrics {
  averageLatencyMs: number;
  error: number;
  outOfStock: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  success: number;
  totalRequests: number;
}

export interface InventoryMetricsSnapshot {
  counters: Record<string, number>;
  instanceId: string;
  pool: { idle: number; total: number; waiting: number } | null;
  strategies: Record<InventoryStrategy, StrategyMetrics>;
}
