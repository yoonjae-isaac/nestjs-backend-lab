import { randomUUID } from 'node:crypto';

import type {
  SagaCommandMessage,
  SagaCommandType,
  SagaEventMessage,
  SagaEventType,
  SagaMessage,
} from './saga-message.types';
import type { SagaDomainService, SagaFailurePoint, SagaStrategy } from './saga-status.types';

export const createInitialSagaEvent = (
  strategy: SagaStrategy,
  failAt: SagaFailurePoint,
  compensationFailAt: SagaFailurePoint,
): SagaEventMessage => {
  const sagaId = randomUUID();

  return {
    causationId: null,
    compensationFailAt,
    correlationId: sagaId,
    eventId: randomUUID(),
    eventType: 'ORDER_CREATED',
    failAt,
    kind: 'EVENT',
    occurredAt: new Date().toISOString(),
    orderId: randomUUID(),
    sagaId,
    sequence: 1,
    service: 'ORDER',
    strategy,
  };
};

export const createSagaEvent = (
  cause: SagaMessage,
  service: SagaDomainService,
  eventType: SagaEventType,
): SagaEventMessage => ({
  causationId: cause.eventId,
  compensationFailAt: cause.compensationFailAt,
  correlationId: cause.correlationId,
  eventId: randomUUID(),
  eventType,
  failAt: cause.failAt,
  kind: 'EVENT',
  occurredAt: new Date().toISOString(),
  orderId: cause.orderId,
  sagaId: cause.sagaId,
  sequence: cause.sequence + 1,
  service,
  strategy: cause.strategy,
});

export const createSagaCommand = (
  cause: SagaMessage,
  targetService: SagaDomainService,
  commandType: SagaCommandType,
): SagaCommandMessage => ({
  causationId: cause.eventId,
  commandType,
  compensationFailAt: cause.compensationFailAt,
  correlationId: cause.correlationId,
  eventId: randomUUID(),
  failAt: cause.failAt,
  kind: 'COMMAND',
  occurredAt: new Date().toISOString(),
  orderId: cause.orderId,
  sagaId: cause.sagaId,
  sequence: cause.sequence + 1,
  service: 'ORCHESTRATOR',
  strategy: cause.strategy,
  targetService,
});
