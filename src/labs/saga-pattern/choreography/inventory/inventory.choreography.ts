import { Injectable } from '@nestjs/common';

import { SagaMessageLogger } from '../../messaging/saga-message-logger.service';
import { SagaRepository } from '../../persistence/saga.repository';
import { CHOREOGRAPHY_TOPICS } from '../../shared/saga.constants';
import { createSagaEvent } from '../../shared/saga-message.factory';
import type { SagaEventMessage, SagaEventType } from '../../shared/saga-message.types';

const CONSUMER_NAME = 'choreography.inventory';

export const decideChoreographyInventory = (message: SagaEventMessage): SagaEventType | null => {
  if (message.eventType === 'ORDER_CREATED') {
    return message.failAt === 'INVENTORY' ? 'INVENTORY_RESERVATION_FAILED' : 'INVENTORY_RESERVED';
  }
  if (message.eventType === 'PAYMENT_FAILED' || message.eventType === 'PAYMENT_CANCELLED') {
    return message.compensationFailAt === 'INVENTORY'
      ? 'INVENTORY_RELEASE_FAILED'
      : 'INVENTORY_RELEASED';
  }
  return null;
};

@Injectable()
export class InventoryChoreography {
  constructor(
    private readonly repository: SagaRepository,
    private readonly messageLogger: SagaMessageLogger,
  ) {}

  async handle(message: SagaEventMessage): Promise<void> {
    const eventType = decideChoreographyInventory(message);
    if (!eventType) {
      return;
    }

    // Inventory 서비스는 주문과 결제 이벤트만으로 예약 또는 역방향 보상을 결정한다.
    const outgoingMessage = createSagaEvent(message, 'INVENTORY', eventType);
    const isHandled = await this.repository.persistHandledMessage(CONSUMER_NAME, message, {
      message: outgoingMessage,
      topic: CHOREOGRAPHY_TOPICS.INVENTORY,
    });
    if (isHandled) {
      this.messageLogger.handled(message, outgoingMessage);
    }
  }
}
