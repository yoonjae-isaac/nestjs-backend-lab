import { Injectable } from '@nestjs/common';

import { SagaMessageLogger } from '../../messaging/saga-message-logger.service';
import { SagaRepository } from '../../persistence/saga.repository';
import { ORCHESTRATION_RESULT_TOPICS } from '../../shared/saga.constants';
import { createSagaEvent } from '../../shared/saga-message.factory';
import type { SagaCommandMessage, SagaEventType } from '../../shared/saga-message.types';

const CONSUMER_NAME = 'orchestration.inventory';

export const executeOrchestrationInventory = (message: SagaCommandMessage): SagaEventType => {
  if (message.commandType === 'RESERVE_INVENTORY') {
    return message.failAt === 'INVENTORY' ? 'INVENTORY_RESERVATION_FAILED' : 'INVENTORY_RESERVED';
  }
  if (message.commandType === 'RELEASE_INVENTORY') {
    return message.compensationFailAt === 'INVENTORY'
      ? 'INVENTORY_RELEASE_FAILED'
      : 'INVENTORY_RELEASED';
  }
  throw new Error(`Unsupported Inventory command: ${message.commandType}`);
};

@Injectable()
export class InventoryOrchestration {
  constructor(
    private readonly repository: SagaRepository,
    private readonly messageLogger: SagaMessageLogger,
  ) {}

  async handle(message: SagaCommandMessage): Promise<void> {
    // Inventory 서비스는 중앙에서 받은 예약 또는 해제 명령의 결과만 반환한다.
    const eventType = executeOrchestrationInventory(message);
    const outgoingMessage = createSagaEvent(message, 'INVENTORY', eventType);
    const isHandled = await this.repository.persistHandledMessage(CONSUMER_NAME, message, {
      message: outgoingMessage,
      topic: ORCHESTRATION_RESULT_TOPICS.INVENTORY,
    });
    if (isHandled) {
      this.messageLogger.handled(message, outgoingMessage);
    }
  }
}
