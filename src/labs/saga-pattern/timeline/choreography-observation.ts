import type { SagaEventMessage } from '../shared/saga-message.types';
import type {
  SagaDomainService,
  SagaInstance,
  SagaStateTransition,
} from '../shared/saga-status.types';

const appendStep = (
  completedSteps: SagaDomainService[],
  step: SagaDomainService,
): SagaDomainService[] =>
  completedSteps.includes(step) ? completedSteps : [...completedSteps, step];

export const observeChoreographyEvent = (
  saga: SagaInstance,
  message: SagaEventMessage,
): SagaStateTransition | null => {
  if (['COMPLETED', 'COMPENSATED', 'COMPENSATION_FAILED'].includes(saga.status)) {
    return null;
  }

  const baseTransition: SagaStateTransition = {
    completedSteps: saga.completedSteps,
    currentStep: saga.currentStep,
    failedStep: saga.failedStep,
    status: saga.status,
  };

  switch (message.eventType) {
    case 'ORDER_CREATED':
      return {
        ...baseTransition,
        completedSteps: appendStep(saga.completedSteps, 'ORDER'),
        currentStep: 'INVENTORY',
        status: 'IN_PROGRESS',
      };
    case 'INVENTORY_RESERVED':
      return {
        ...baseTransition,
        completedSteps: appendStep(saga.completedSteps, 'INVENTORY'),
        currentStep: 'PAYMENT',
        status: 'IN_PROGRESS',
      };
    case 'PAYMENT_APPROVED':
      return {
        ...baseTransition,
        completedSteps: appendStep(saga.completedSteps, 'PAYMENT'),
        currentStep: 'SHIPPING',
        status: 'IN_PROGRESS',
      };
    case 'SHIPPING_CREATED':
      return {
        ...baseTransition,
        completedSteps: appendStep(saga.completedSteps, 'SHIPPING'),
        currentStep: 'ORDER_COMPLETION',
        status: 'IN_PROGRESS',
      };
    case 'INVENTORY_RESERVATION_FAILED':
      return {
        ...baseTransition,
        currentStep: 'ORDER_COMPENSATION',
        failedStep: 'INVENTORY',
        status: 'COMPENSATING',
      };
    case 'PAYMENT_FAILED':
      return {
        ...baseTransition,
        currentStep: 'INVENTORY_COMPENSATION',
        failedStep: 'PAYMENT',
        status: 'COMPENSATING',
      };
    case 'SHIPPING_FAILED':
      return {
        ...baseTransition,
        currentStep: 'PAYMENT_COMPENSATION',
        failedStep: 'SHIPPING',
        status: 'COMPENSATING',
      };
    case 'PAYMENT_CANCELLED':
      return { ...baseTransition, currentStep: 'INVENTORY_COMPENSATION' };
    case 'INVENTORY_RELEASED':
      return { ...baseTransition, currentStep: 'ORDER_COMPENSATION' };
    case 'PAYMENT_CANCELLATION_FAILED':
    case 'INVENTORY_RELEASE_FAILED':
    case 'SHIPPING_CANCELLATION_FAILED':
      return {
        ...baseTransition,
        currentStep: 'FINISHED',
        status: 'COMPENSATION_FAILED',
      };
    case 'ORDER_COMPLETED':
      return {
        ...baseTransition,
        currentStep: 'FINISHED',
        failedStep: null,
        status: 'COMPLETED',
      };
    case 'ORDER_CANCELLED':
      return { ...baseTransition, currentStep: 'FINISHED', status: 'COMPENSATED' };
    default:
      return null;
  }
};
