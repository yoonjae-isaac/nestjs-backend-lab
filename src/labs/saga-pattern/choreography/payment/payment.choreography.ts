import { Injectable } from '@nestjs/common';

import { SagaMessageLogger } from '../../messaging/saga-message-logger.service';
import { SagaRepository } from '../../persistence/saga.repository';
import { CHOREOGRAPHY_TOPICS } from '../../shared/saga.constants';
import { createSagaEvent } from '../../shared/saga-message.factory';
import type { SagaEventMessage, SagaEventType } from '../../shared/saga-message.types';

const CONSUMER_NAME = 'choreography.payment';

export const decideChoreographyPayment = (message: SagaEventMessage): SagaEventType | null => {
  if (message.eventType === 'INVENTORY_RESERVED') {
    return message.failAt === 'PAYMENT' ? 'PAYMENT_FAILED' : 'PAYMENT_APPROVED';
  }
  if (message.eventType === 'SHIPPING_FAILED') {
    return message.compensationFailAt === 'PAYMENT'
      ? 'PAYMENT_CANCELLATION_FAILED'
      : 'PAYMENT_CANCELLED';
  }
  return null;
};

@Injectable()
export class PaymentChoreography {
  constructor(
    private readonly repository: SagaRepository,
    private readonly messageLogger: SagaMessageLogger,
  ) {}

  async handle(message: SagaEventMessage): Promise<void> {
    const eventType = decideChoreographyPayment(message);
    if (!eventType) {
      return;
    }

    // Payment 서비스는 재고 예약과 배송 실패 이벤트에 반응해 승인 또는 취소를 수행한다.
    const outgoingMessage = createSagaEvent(message, 'PAYMENT', eventType);
    const isHandled = await this.repository.persistHandledMessage(CONSUMER_NAME, message, {
      message: outgoingMessage,
      topic: CHOREOGRAPHY_TOPICS.PAYMENT,
    });
    if (isHandled) {
      this.messageLogger.handled(message, outgoingMessage);
    }
  }
}
