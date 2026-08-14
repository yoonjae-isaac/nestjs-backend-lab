import { Injectable } from '@nestjs/common';

import { SagaMessageLogger } from '../../messaging/saga-message-logger.service';
import { SagaRepository } from '../../persistence/saga.repository';
import { ORCHESTRATION_RESULT_TOPICS } from '../../shared/saga.constants';
import { createSagaEvent } from '../../shared/saga-message.factory';
import type { SagaCommandMessage, SagaEventType } from '../../shared/saga-message.types';

const CONSUMER_NAME = 'orchestration.order';

export const executeOrchestrationOrder = (message: SagaCommandMessage): SagaEventType => {
  if (message.commandType === 'COMPLETE_ORDER') {
    return 'ORDER_COMPLETED';
  }
  if (message.commandType === 'CANCEL_ORDER') {
    return 'ORDER_CANCELLED';
  }
  throw new Error(`Unsupported Order command: ${message.commandType}`);
};

@Injectable()
export class OrderOrchestration {
  constructor(
    private readonly repository: SagaRepository,
    private readonly messageLogger: SagaMessageLogger,
  ) {}

  async handle(message: SagaCommandMessage): Promise<void> {
    // Order 서비스는 Orchestrator가 지정한 완료 또는 취소 명령만 실행한다.
    const eventType = executeOrchestrationOrder(message);
    const outgoingMessage = createSagaEvent(message, 'ORDER', eventType);
    const isHandled = await this.repository.persistHandledMessage(CONSUMER_NAME, message, {
      message: outgoingMessage,
      topic: ORCHESTRATION_RESULT_TOPICS.ORDER,
    });
    if (isHandled) {
      this.messageLogger.handled(message, outgoingMessage);
    }
  }
}
