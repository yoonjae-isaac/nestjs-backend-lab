export const SAGA_STRATEGIES = ['CHOREOGRAPHY', 'ORCHESTRATION'] as const;
export type SagaStrategy = (typeof SAGA_STRATEGIES)[number];

export const SAGA_FAILURE_POINTS = ['NONE', 'INVENTORY', 'PAYMENT', 'SHIPPING'] as const;
export type SagaFailurePoint = (typeof SAGA_FAILURE_POINTS)[number];

export const SAGA_STATUSES = [
  'STARTED',
  'IN_PROGRESS',
  'COMPENSATING',
  'COMPLETED',
  'FAILED',
  'COMPENSATED',
  'COMPENSATION_FAILED',
] as const;
export type SagaStatus = (typeof SAGA_STATUSES)[number];

export const SAGA_STEPS = [
  'ORDER',
  'INVENTORY',
  'PAYMENT',
  'SHIPPING',
  'PAYMENT_COMPENSATION',
  'INVENTORY_COMPENSATION',
  'ORDER_COMPLETION',
  'ORDER_COMPENSATION',
  'FINISHED',
] as const;
export type SagaStep = (typeof SAGA_STEPS)[number];

export const SAGA_DOMAIN_SERVICES = ['ORDER', 'INVENTORY', 'PAYMENT', 'SHIPPING'] as const;
export type SagaDomainService = (typeof SAGA_DOMAIN_SERVICES)[number];
export type SagaService = SagaDomainService | 'ORCHESTRATOR';

export interface SagaInstance {
  completedSteps: SagaDomainService[];
  compensationFailAt: SagaFailurePoint;
  createdAt: string;
  currentStep: SagaStep;
  failAt: SagaFailurePoint;
  failedStep: SagaDomainService | null;
  orderId: string;
  sagaId: string;
  status: SagaStatus;
  strategy: SagaStrategy;
  updatedAt: string;
}

export interface SagaStateTransition {
  completedSteps: SagaDomainService[];
  currentStep: SagaStep;
  failedStep: SagaDomainService | null;
  status: SagaStatus;
}

export interface SagaTimelineEntry {
  action: string;
  kind: 'COMMAND' | 'EVENT';
  occurredAt: string;
  service: SagaService;
  step: number;
  targetService: SagaDomainService | null;
}
