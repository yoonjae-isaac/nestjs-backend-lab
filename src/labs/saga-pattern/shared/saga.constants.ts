import type { SagaDomainService } from './saga-status.types';

export const SAGA_LAB = 'saga-pattern';
export const SAGA_SCHEMA = 'lab_saga_pattern';
export const SAGA_TOPIC_PARTITIONS = 3;

export const CHOREOGRAPHY_TOPICS: Record<SagaDomainService, string> = {
  ORDER: 'lab.saga.choreography.order.events',
  INVENTORY: 'lab.saga.choreography.inventory.events',
  PAYMENT: 'lab.saga.choreography.payment.events',
  SHIPPING: 'lab.saga.choreography.shipping.events',
};

export const ORCHESTRATION_COMMAND_TOPICS: Record<SagaDomainService, string> = {
  ORDER: 'lab.saga.orchestration.order.commands',
  INVENTORY: 'lab.saga.orchestration.inventory.commands',
  PAYMENT: 'lab.saga.orchestration.payment.commands',
  SHIPPING: 'lab.saga.orchestration.shipping.commands',
};

export const ORCHESTRATION_RESULT_TOPICS: Record<SagaDomainService, string> = {
  ORDER: 'lab.saga.orchestration.order.results',
  INVENTORY: 'lab.saga.orchestration.inventory.results',
  PAYMENT: 'lab.saga.orchestration.payment.results',
  SHIPPING: 'lab.saga.orchestration.shipping.results',
};

export const SAGA_TOPICS = [
  ...Object.values(CHOREOGRAPHY_TOPICS),
  ...Object.values(ORCHESTRATION_COMMAND_TOPICS),
  ...Object.values(ORCHESTRATION_RESULT_TOPICS),
] as const;
