import { Injectable } from '@nestjs/common';

import { SagaMessageLogger } from '../../messaging/saga-message-logger.service';
import { SagaRepository } from '../../persistence/saga.repository';
import { CHOREOGRAPHY_TOPICS } from '../../shared/saga.constants';
import { createSagaEvent } from '../../shared/saga-message.factory';
import type { SagaEventMessage, SagaEventType } from '../../shared/saga-message.types';

const CONSUMER_NAME = 'choreography.order';

export const decideChoreographyOrder = (message: SagaEventMessage): SagaEventType | null => {
  if (message.eventType === 'SHIPPING_CREATED') {
    return 'ORDER_COMPLETED';
  }
  if (
    message.eventType === 'INVENTORY_RESERVATION_FAILED' ||
    message.eventType === 'INVENTORY_RELEASED'
  ) {
    return 'ORDER_CANCELLED';
  }
  return null;
};

@Injectable()
export class OrderChoreography {
  constructor(
    private readonly repository: SagaRepository,
    private readonly messageLogger: SagaMessageLogger,
  ) {}

  async handle(message: SagaEventMessage): Promise<void> {
    const eventType = decideChoreographyOrder(message);
    if (!eventType) {
      return;
    }

    // Order 서비스가 선행 서비스의 이벤트를 보고 최종 완료 또는 취소를 자율 결정한다.
    const outgoingMessage = createSagaEvent(message, 'ORDER', eventType);
    const isHandled = await this.repository.persistHandledMessage(CONSUMER_NAME, message, {
      message: outgoingMessage,
      topic: CHOREOGRAPHY_TOPICS.ORDER,
    });
    if (isHandled) {
      this.messageLogger.handled(message, outgoingMessage);
    }
  }
}
