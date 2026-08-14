import {
  SAGA_DOMAIN_SERVICES,
  SAGA_FAILURE_POINTS,
  SAGA_STRATEGIES,
  type SagaDomainService,
  type SagaFailurePoint,
  type SagaService,
  type SagaStrategy,
} from './saga-status.types';

export const SAGA_EVENT_TYPES = [
  'ORDER_CREATED',
  'INVENTORY_RESERVED',
  'INVENTORY_RESERVATION_FAILED',
  'INVENTORY_RELEASED',
  'INVENTORY_RELEASE_FAILED',
  'PAYMENT_APPROVED',
  'PAYMENT_FAILED',
  'PAYMENT_CANCELLED',
  'PAYMENT_CANCELLATION_FAILED',
  'SHIPPING_CREATED',
  'SHIPPING_FAILED',
  'SHIPPING_CANCELLED',
  'SHIPPING_CANCELLATION_FAILED',
  'ORDER_COMPLETED',
  'ORDER_CANCELLED',
] as const;
export type SagaEventType = (typeof SAGA_EVENT_TYPES)[number];

export const SAGA_COMMAND_TYPES = [
  'RESERVE_INVENTORY',
  'RELEASE_INVENTORY',
  'APPROVE_PAYMENT',
  'CANCEL_PAYMENT',
  'CREATE_SHIPPING',
  'CANCEL_SHIPPING',
  'COMPLETE_ORDER',
  'CANCEL_ORDER',
] as const;
export type SagaCommandType = (typeof SAGA_COMMAND_TYPES)[number];

interface SagaMessageMetadata {
  causationId: string | null;
  compensationFailAt: SagaFailurePoint;
  correlationId: string;
  eventId: string;
  failAt: SagaFailurePoint;
  occurredAt: string;
  orderId: string;
  sagaId: string;
  sequence: number;
  strategy: SagaStrategy;
}

export interface SagaEventMessage extends SagaMessageMetadata {
  eventType: SagaEventType;
  kind: 'EVENT';
  service: SagaDomainService;
}

export interface SagaCommandMessage extends SagaMessageMetadata {
  commandType: SagaCommandType;
  kind: 'COMMAND';
  service: 'ORCHESTRATOR';
  targetService: SagaDomainService;
}

export type SagaMessage = SagaEventMessage | SagaCommandMessage;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isIncluded = <Value extends string>(
  values: readonly Value[],
  value: unknown,
): value is Value => typeof value === 'string' && values.includes(value as Value);

export const parseSagaMessage = (serializedMessage: string): SagaMessage => {
  // Kafka 입력은 신뢰하지 않고 공통 추적 metadata와 메시지 종류를 런타임에서 검증한다.
  const message: unknown = JSON.parse(serializedMessage);
  if (
    !isRecord(message) ||
    typeof message.eventId !== 'string' ||
    typeof message.sagaId !== 'string' ||
    typeof message.orderId !== 'string' ||
    typeof message.correlationId !== 'string' ||
    (message.causationId !== null && typeof message.causationId !== 'string') ||
    typeof message.occurredAt !== 'string' ||
    !Number.isSafeInteger(message.sequence) ||
    !isIncluded(SAGA_STRATEGIES, message.strategy) ||
    !isIncluded(SAGA_FAILURE_POINTS, message.failAt) ||
    !isIncluded(SAGA_FAILURE_POINTS, message.compensationFailAt)
  ) {
    throw new Error('Invalid Saga message metadata');
  }

  if (
    message.kind === 'EVENT' &&
    isIncluded(SAGA_EVENT_TYPES, message.eventType) &&
    isIncluded(SAGA_DOMAIN_SERVICES, message.service)
  ) {
    return message as unknown as SagaEventMessage;
  }

  if (
    message.kind === 'COMMAND' &&
    message.service === 'ORCHESTRATOR' &&
    isIncluded(SAGA_COMMAND_TYPES, message.commandType) &&
    isIncluded(SAGA_DOMAIN_SERVICES, message.targetService)
  ) {
    return message as unknown as SagaCommandMessage;
  }

  throw new Error('Invalid Saga message body');
};

export const sagaMessageAction = (message: SagaMessage): SagaCommandType | SagaEventType =>
  message.kind === 'EVENT' ? message.eventType : message.commandType;

export const sagaMessageService = (message: SagaMessage): SagaService => message.service;
