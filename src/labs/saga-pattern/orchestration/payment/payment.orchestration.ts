import { Injectable } from '@nestjs/common';

import { SagaMessageLogger } from '../../messaging/saga-message-logger.service';
import { SagaRepository } from '../../persistence/saga.repository';
import { ORCHESTRATION_RESULT_TOPICS } from '../../shared/saga.constants';
import { createSagaEvent } from '../../shared/saga-message.factory';
import type { SagaCommandMessage, SagaEventType } from '../../shared/saga-message.types';

const CONSUMER_NAME = 'orchestration.payment';

export const executeOrchestrationPayment = (message: SagaCommandMessage): SagaEventType => {
  if (message.commandType === 'APPROVE_PAYMENT') {
    return message.failAt === 'PAYMENT' ? 'PAYMENT_FAILED' : 'PAYMENT_APPROVED';
  }
  if (message.commandType === 'CANCEL_PAYMENT') {
    return message.compensationFailAt === 'PAYMENT'
      ? 'PAYMENT_CANCELLATION_FAILED'
      : 'PAYMENT_CANCELLED';
  }
  throw new Error(`Unsupported Payment command: ${message.commandType}`);
};

@Injectable()
export class PaymentOrchestration {
  constructor(
    private readonly repository: SagaRepository,
    private readonly messageLogger: SagaMessageLogger,
  ) {}

  async handle(message: SagaCommandMessage): Promise<void> {
    // Payment 서비스는 승인과 취소의 성공 여부를 Orchestrator에 결과 이벤트로 회신한다.
    const eventType = executeOrchestrationPayment(message);
    const outgoingMessage = createSagaEvent(message, 'PAYMENT', eventType);
    const isHandled = await this.repository.persistHandledMessage(CONSUMER_NAME, message, {
      message: outgoingMessage,
      topic: ORCHESTRATION_RESULT_TOPICS.PAYMENT,
    });
    if (isHandled) {
      this.messageLogger.handled(message, outgoingMessage);
    }
  }
}
