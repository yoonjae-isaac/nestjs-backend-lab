import type { SagaCommandType, SagaEventMessage } from '../../shared/saga-message.types';
import type {
  SagaDomainService,
  SagaInstance,
  SagaStateTransition,
} from '../../shared/saga-status.types';

export interface OrchestratorDecision {
  commandType: SagaCommandType | null;
  targetService: SagaDomainService | null;
  transition: SagaStateTransition;
}

const appendStep = (
  completedSteps: SagaDomainService[],
  step: SagaDomainService,
): SagaDomainService[] =>
  completedSteps.includes(step) ? completedSteps : [...completedSteps, step];

export const decideOrchestrator = (
  saga: SagaInstance,
  message: SagaEventMessage,
): OrchestratorDecision | null => {
  const completedSteps = saga.completedSteps;

  switch (message.eventType) {
    case 'ORDER_CREATED': {
      if (saga.status !== 'STARTED' || saga.currentStep !== 'ORDER') {
        return null;
      }
      return {
        commandType: 'RESERVE_INVENTORY',
        targetService: 'INVENTORY',
        transition: {
          completedSteps: appendStep(completedSteps, 'ORDER'),
          currentStep: 'INVENTORY',
          failedStep: null,
          status: 'IN_PROGRESS',
        },
      };
    }
    case 'INVENTORY_RESERVED': {
      if (saga.status !== 'IN_PROGRESS' || saga.currentStep !== 'INVENTORY') {
        return null;
      }
      return {
        commandType: 'APPROVE_PAYMENT',
        targetService: 'PAYMENT',
        transition: {
          completedSteps: appendStep(completedSteps, 'INVENTORY'),
          currentStep: 'PAYMENT',
          failedStep: null,
          status: 'IN_PROGRESS',
        },
      };
    }
    case 'INVENTORY_RESERVATION_FAILED': {
      if (saga.status !== 'IN_PROGRESS' || saga.currentStep !== 'INVENTORY') {
        return null;
      }
      return {
        commandType: 'CANCEL_ORDER',
        targetService: 'ORDER',
        transition: {
          completedSteps,
          currentStep: 'ORDER_COMPENSATION',
          failedStep: 'INVENTORY',
          status: 'COMPENSATING',
        },
      };
    }
    case 'PAYMENT_APPROVED': {
      if (saga.status !== 'IN_PROGRESS' || saga.currentStep !== 'PAYMENT') {
        return null;
      }
      return {
        commandType: 'CREATE_SHIPPING',
        targetService: 'SHIPPING',
        transition: {
          completedSteps: appendStep(completedSteps, 'PAYMENT'),
          currentStep: 'SHIPPING',
          failedStep: null,
          status: 'IN_PROGRESS',
        },
      };
    }
    case 'PAYMENT_FAILED': {
      if (saga.status !== 'IN_PROGRESS' || saga.currentStep !== 'PAYMENT') {
        return null;
      }
      return {
        commandType: 'RELEASE_INVENTORY',
        targetService: 'INVENTORY',
        transition: {
          completedSteps,
          currentStep: 'INVENTORY_COMPENSATION',
          failedStep: 'PAYMENT',
          status: 'COMPENSATING',
        },
      };
    }
    case 'SHIPPING_CREATED': {
      if (saga.status !== 'IN_PROGRESS' || saga.currentStep !== 'SHIPPING') {
        return null;
      }
      return {
        commandType: 'COMPLETE_ORDER',
        targetService: 'ORDER',
        transition: {
          completedSteps: appendStep(completedSteps, 'SHIPPING'),
          currentStep: 'ORDER_COMPLETION',
          failedStep: null,
          status: 'IN_PROGRESS',
        },
      };
    }
    case 'SHIPPING_FAILED': {
      if (saga.status !== 'IN_PROGRESS' || saga.currentStep !== 'SHIPPING') {
        return null;
      }
      return {
        commandType: 'CANCEL_PAYMENT',
        targetService: 'PAYMENT',
        transition: {
          completedSteps,
          currentStep: 'PAYMENT_COMPENSATION',
          failedStep: 'SHIPPING',
          status: 'COMPENSATING',
        },
      };
    }
    case 'PAYMENT_CANCELLED': {
      if (saga.status !== 'COMPENSATING' || saga.currentStep !== 'PAYMENT_COMPENSATION') {
        return null;
      }
      return {
        commandType: 'RELEASE_INVENTORY',
        targetService: 'INVENTORY',
        transition: {
          completedSteps,
          currentStep: 'INVENTORY_COMPENSATION',
          failedStep: saga.failedStep,
          status: 'COMPENSATING',
        },
      };
    }
    case 'INVENTORY_RELEASED': {
      if (saga.status !== 'COMPENSATING' || saga.currentStep !== 'INVENTORY_COMPENSATION') {
        return null;
      }
      return {
        commandType: 'CANCEL_ORDER',
        targetService: 'ORDER',
        transition: {
          completedSteps,
          currentStep: 'ORDER_COMPENSATION',
          failedStep: saga.failedStep,
          status: 'COMPENSATING',
        },
      };
    }
    case 'PAYMENT_CANCELLATION_FAILED': {
      if (saga.status !== 'COMPENSATING' || saga.currentStep !== 'PAYMENT_COMPENSATION') {
        return null;
      }
      return {
        commandType: null,
        targetService: null,
        transition: {
          completedSteps,
          currentStep: 'FINISHED',
          failedStep: saga.failedStep,
          status: 'COMPENSATION_FAILED',
        },
      };
    }
    case 'INVENTORY_RELEASE_FAILED': {
      if (saga.status !== 'COMPENSATING' || saga.currentStep !== 'INVENTORY_COMPENSATION') {
        return null;
      }
      return {
        commandType: null,
        targetService: null,
        transition: {
          completedSteps,
          currentStep: 'FINISHED',
          failedStep: saga.failedStep,
          status: 'COMPENSATION_FAILED',
        },
      };
    }
    case 'ORDER_COMPLETED': {
      if (saga.status !== 'IN_PROGRESS' || saga.currentStep !== 'ORDER_COMPLETION') {
        return null;
      }
      return {
        commandType: null,
        targetService: null,
        transition: {
          completedSteps,
          currentStep: 'FINISHED',
          failedStep: null,
          status: 'COMPLETED',
        },
      };
    }
    case 'ORDER_CANCELLED': {
      if (saga.status !== 'COMPENSATING' || saga.currentStep !== 'ORDER_COMPENSATION') {
        return null;
      }
      return {
        commandType: null,
        targetService: null,
        transition: {
          completedSteps,
          currentStep: 'FINISHED',
          failedStep: saga.failedStep,
          status: 'COMPENSATED',
        },
      };
    }
    default:
      return null;
  }
};
