import { decideChoreographyInventory } from '../choreography/inventory/inventory.choreography';
import { decideChoreographyOrder } from '../choreography/order/order.choreography';
import { decideChoreographyPayment } from '../choreography/payment/payment.choreography';
import { decideChoreographyShipping } from '../choreography/shipping/shipping.choreography';
import { executeOrchestrationInventory } from '../orchestration/inventory/inventory.orchestration';
import { decideOrchestrator } from '../orchestration/orchestrator/orchestrator.flow';
import { executeOrchestrationOrder } from '../orchestration/order/order.orchestration';
import { executeOrchestrationPayment } from '../orchestration/payment/payment.orchestration';
import { executeOrchestrationShipping } from '../orchestration/shipping/shipping.orchestration';
import {
  createInitialSagaEvent,
  createSagaCommand,
  createSagaEvent,
} from '../shared/saga-message.factory';
import type {
  SagaCommandMessage,
  SagaCommandType,
  SagaEventMessage,
  SagaEventType,
} from '../shared/saga-message.types';
import type {
  SagaDomainService,
  SagaFailurePoint,
  SagaInstance,
  SagaStatus,
} from '../shared/saga-status.types';

interface ChoreographyDecision {
  eventType: SagaEventType;
  service: SagaDomainService;
}

const choreographyDecision = (message: SagaEventMessage): ChoreographyDecision | null => {
  const decisions: Array<ChoreographyDecision | null> = [
    decideChoreographyOrder(message)
      ? { eventType: decideChoreographyOrder(message) as SagaEventType, service: 'ORDER' }
      : null,
    decideChoreographyInventory(message)
      ? { eventType: decideChoreographyInventory(message) as SagaEventType, service: 'INVENTORY' }
      : null,
    decideChoreographyPayment(message)
      ? { eventType: decideChoreographyPayment(message) as SagaEventType, service: 'PAYMENT' }
      : null,
    decideChoreographyShipping(message)
      ? { eventType: decideChoreographyShipping(message) as SagaEventType, service: 'SHIPPING' }
      : null,
  ];
  const activeDecisions = decisions.filter(
    (decision): decision is ChoreographyDecision => decision !== null,
  );
  if (activeDecisions.length > 1) {
    throw new Error(`Multiple services handled ${message.eventType}`);
  }
  return activeDecisions[0] ?? null;
};

const runChoreography = (
  failAt: SagaFailurePoint,
  compensationFailAt: SagaFailurePoint = 'NONE',
): SagaEventType[] => {
  let message = createInitialSagaEvent('CHOREOGRAPHY', failAt, compensationFailAt);
  const events: SagaEventType[] = [];

  for (let step = 0; step < 20; step += 1) {
    events.push(message.eventType);
    const decision = choreographyDecision(message);
    if (!decision) {
      return events;
    }
    message = createSagaEvent(message, decision.service, decision.eventType);
  }
  throw new Error('Choreography did not terminate');
};

const executeCommand = (message: SagaCommandMessage): SagaEventType => {
  switch (message.targetService) {
    case 'ORDER':
      return executeOrchestrationOrder(message);
    case 'INVENTORY':
      return executeOrchestrationInventory(message);
    case 'PAYMENT':
      return executeOrchestrationPayment(message);
    case 'SHIPPING':
      return executeOrchestrationShipping(message);
  }
};

const runOrchestration = (
  failAt: SagaFailurePoint,
  compensationFailAt: SagaFailurePoint = 'NONE',
): { commands: SagaCommandType[]; events: SagaEventType[]; status: SagaStatus } => {
  let message = createInitialSagaEvent('ORCHESTRATION', failAt, compensationFailAt);
  const createdAt = new Date().toISOString();
  let saga: SagaInstance = {
    completedSteps: [],
    compensationFailAt,
    createdAt,
    currentStep: 'ORDER',
    failAt,
    failedStep: null,
    orderId: message.orderId,
    sagaId: message.sagaId,
    status: 'STARTED',
    strategy: 'ORCHESTRATION',
    updatedAt: createdAt,
  };
  const commands: SagaCommandType[] = [];
  const events: SagaEventType[] = [];

  for (let step = 0; step < 20; step += 1) {
    events.push(message.eventType);
    const decision = decideOrchestrator(saga, message);
    if (!decision) {
      throw new Error(`Orchestrator ignored ${message.eventType}`);
    }
    saga = { ...saga, ...decision.transition };
    if (!decision.commandType || !decision.targetService) {
      return { commands, events, status: saga.status };
    }

    const command = createSagaCommand(message, decision.targetService, decision.commandType);
    commands.push(command.commandType);
    message = createSagaEvent(command, command.targetService, executeCommand(command));
  }
  throw new Error('Orchestration did not terminate');
};

describe('Saga flows', () => {
  it('completes the Choreography success flow', () => {
    expect(runChoreography('NONE')).toEqual([
      'ORDER_CREATED',
      'INVENTORY_RESERVED',
      'PAYMENT_APPROVED',
      'SHIPPING_CREATED',
      'ORDER_COMPLETED',
    ]);
  });

  it('cancels the Choreography order after an Inventory failure', () => {
    expect(runChoreography('INVENTORY')).toEqual([
      'ORDER_CREATED',
      'INVENTORY_RESERVATION_FAILED',
      'ORDER_CANCELLED',
    ]);
  });

  it('releases Inventory after a Choreography Payment failure', () => {
    expect(runChoreography('PAYMENT')).toEqual([
      'ORDER_CREATED',
      'INVENTORY_RESERVED',
      'PAYMENT_FAILED',
      'INVENTORY_RELEASED',
      'ORDER_CANCELLED',
    ]);
  });

  it('compensates Payment and Inventory after a Choreography Shipping failure', () => {
    expect(runChoreography('SHIPPING')).toEqual([
      'ORDER_CREATED',
      'INVENTORY_RESERVED',
      'PAYMENT_APPROVED',
      'SHIPPING_FAILED',
      'PAYMENT_CANCELLED',
      'INVENTORY_RELEASED',
      'ORDER_CANCELLED',
    ]);
  });

  it('completes the Orchestration success flow', () => {
    const execution = runOrchestration('NONE');

    expect(execution.commands).toEqual([
      'RESERVE_INVENTORY',
      'APPROVE_PAYMENT',
      'CREATE_SHIPPING',
      'COMPLETE_ORDER',
    ]);
    expect(execution.status).toBe('COMPLETED');
  });

  it('cancels the Orchestration order after an Inventory failure', () => {
    const execution = runOrchestration('INVENTORY');

    expect(execution.commands).toEqual(['RESERVE_INVENTORY', 'CANCEL_ORDER']);
    expect(execution.status).toBe('COMPENSATED');
  });

  it('orders Inventory release before Order cancellation after a Payment failure', () => {
    const execution = runOrchestration('PAYMENT');

    expect(execution.commands).toEqual([
      'RESERVE_INVENTORY',
      'APPROVE_PAYMENT',
      'RELEASE_INVENTORY',
      'CANCEL_ORDER',
    ]);
    expect(execution.status).toBe('COMPENSATED');
  });

  it('orders reverse compensations after an Orchestration Shipping failure', () => {
    const execution = runOrchestration('SHIPPING');

    expect(execution.commands).toEqual([
      'RESERVE_INVENTORY',
      'APPROVE_PAYMENT',
      'CREATE_SHIPPING',
      'CANCEL_PAYMENT',
      'RELEASE_INVENTORY',
      'CANCEL_ORDER',
    ]);
    expect(execution.status).toBe('COMPENSATED');
  });

  it('stops with COMPENSATION_FAILED when Inventory release fails', () => {
    const execution = runOrchestration('SHIPPING', 'INVENTORY');

    expect(execution.events.at(-1)).toBe('INVENTORY_RELEASE_FAILED');
    expect(execution.status).toBe('COMPENSATION_FAILED');
  });

  it('ignores a late success result after compensation has started', () => {
    const message = createInitialSagaEvent('ORCHESTRATION', 'SHIPPING', 'NONE');
    const latePaymentApproval = createSagaEvent(message, 'PAYMENT', 'PAYMENT_APPROVED');
    const createdAt = new Date().toISOString();
    const compensatingSaga: SagaInstance = {
      completedSteps: ['ORDER', 'INVENTORY', 'PAYMENT'],
      compensationFailAt: 'NONE',
      createdAt,
      currentStep: 'PAYMENT_COMPENSATION',
      failAt: 'SHIPPING',
      failedStep: 'SHIPPING',
      orderId: message.orderId,
      sagaId: message.sagaId,
      status: 'COMPENSATING',
      strategy: 'ORCHESTRATION',
      updatedAt: createdAt,
    };

    expect(decideOrchestrator(compensatingSaga, latePaymentApproval)).toBeNull();
  });
});
