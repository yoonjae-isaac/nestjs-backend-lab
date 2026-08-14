import { Injectable } from '@nestjs/common';

import { SagaMessageLogger } from '../../messaging/saga-message-logger.service';
import { SagaRepository } from '../../persistence/saga.repository';
import { ORCHESTRATION_RESULT_TOPICS } from '../../shared/saga.constants';
import { createSagaEvent } from '../../shared/saga-message.factory';
import type { SagaCommandMessage, SagaEventType } from '../../shared/saga-message.types';

const CONSUMER_NAME = 'orchestration.shipping';

export const executeOrchestrationShipping = (message: SagaCommandMessage): SagaEventType => {
  if (message.commandType === 'CREATE_SHIPPING') {
    return message.failAt === 'SHIPPING' ? 'SHIPPING_FAILED' : 'SHIPPING_CREATED';
  }
  if (message.commandType === 'CANCEL_SHIPPING') {
    return message.compensationFailAt === 'SHIPPING'
      ? 'SHIPPING_CANCELLATION_FAILED'
      : 'SHIPPING_CANCELLED';
  }
  throw new Error(`Unsupported Shipping command: ${message.commandType}`);
};

@Injectable()
export class ShippingOrchestration {
  constructor(
    private readonly repository: SagaRepository,
    private readonly messageLogger: SagaMessageLogger,
  ) {}

  async handle(message: SagaCommandMessage): Promise<void> {
    // Shipping 서비스는 배송 생성 또는 취소 명령을 실행하고 결과만 발행한다.
    const eventType = executeOrchestrationShipping(message);
    const outgoingMessage = createSagaEvent(message, 'SHIPPING', eventType);
    const isHandled = await this.repository.persistHandledMessage(CONSUMER_NAME, message, {
      message: outgoingMessage,
      topic: ORCHESTRATION_RESULT_TOPICS.SHIPPING,
    });
    if (isHandled) {
      this.messageLogger.handled(message, outgoingMessage);
    }
  }
}
