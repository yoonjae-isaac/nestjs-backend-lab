import { Injectable } from '@nestjs/common';

import { SagaMessageLogger } from '../../messaging/saga-message-logger.service';
import { SagaRepository } from '../../persistence/saga.repository';
import { CHOREOGRAPHY_TOPICS } from '../../shared/saga.constants';
import { createSagaEvent } from '../../shared/saga-message.factory';
import type { SagaEventMessage, SagaEventType } from '../../shared/saga-message.types';

const CONSUMER_NAME = 'choreography.shipping';

export const decideChoreographyShipping = (message: SagaEventMessage): SagaEventType | null => {
  if (message.eventType !== 'PAYMENT_APPROVED') {
    return null;
  }
  return message.failAt === 'SHIPPING' ? 'SHIPPING_FAILED' : 'SHIPPING_CREATED';
};

@Injectable()
export class ShippingChoreography {
  constructor(
    private readonly repository: SagaRepository,
    private readonly messageLogger: SagaMessageLogger,
  ) {}

  async handle(message: SagaEventMessage): Promise<void> {
    const eventType = decideChoreographyShipping(message);
    if (!eventType) {
      return;
    }

    // Shipping 서비스는 결제 승인 이벤트만 구독하고 배송 생성 결과를 다시 이벤트로 알린다.
    const outgoingMessage = createSagaEvent(message, 'SHIPPING', eventType);
    const isHandled = await this.repository.persistHandledMessage(CONSUMER_NAME, message, {
      message: outgoingMessage,
      topic: CHOREOGRAPHY_TOPICS.SHIPPING,
    });
    if (isHandled) {
      this.messageLogger.handled(message, outgoingMessage);
    }
  }
}
