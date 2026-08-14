import { Injectable, type OnModuleInit } from '@nestjs/common';

import { SagaConsumerService } from '../../messaging/saga-consumer.service';
import { SagaMessageLogger } from '../../messaging/saga-message-logger.service';
import { SagaRepository } from '../../persistence/saga.repository';
import {
  ORCHESTRATION_COMMAND_TOPICS,
  ORCHESTRATION_RESULT_TOPICS,
} from '../../shared/saga.constants';
import { createSagaCommand } from '../../shared/saga-message.factory';
import type { SagaEventMessage, SagaMessage } from '../../shared/saga-message.types';
import { decideOrchestrator, type OrchestratorDecision } from './orchestrator.flow';

const CONSUMER_NAME = 'orchestration.orchestrator';

@Injectable()
export class SagaOrchestratorService implements OnModuleInit {
  constructor(
    private readonly consumer: SagaConsumerService,
    private readonly repository: SagaRepository,
    private readonly messageLogger: SagaMessageLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.subscribe(
      'saga-pattern.orchestration.orchestrator',
      Object.values(ORCHESTRATION_RESULT_TOPICS),
      async (message) => this.handle(message),
    );
  }

  async handle(message: SagaMessage): Promise<void> {
    if (message.kind !== 'EVENT' || message.strategy !== 'ORCHESTRATION') {
      return;
    }

    const saga = await this.repository.findSaga(message.sagaId);
    if (!saga) {
      throw new Error(`Saga does not exist: ${message.sagaId}`);
    }

    // Orchestrator만 현재 상태를 읽고 다음 명령과 역방향 보상 순서를 결정한다.
    const decision = decideOrchestrator(saga, message);
    if (!decision) {
      const isHandled = await this.repository.persistHandledMessage(CONSUMER_NAME, message, null);
      if (isHandled) {
        this.messageLogger.ignored(
          message,
          `Unexpected ${saga.status}/${saga.currentStep} transition`,
          'ORCHESTRATOR',
        );
      }
      return;
    }

    const outgoingMessage = this.createOutgoingCommand(message, decision);
    const isHandled = await this.repository.persistHandledMessage(
      CONSUMER_NAME,
      message,
      outgoingMessage,
      decision.transition,
    );
    if (isHandled) {
      this.messageLogger.handled(message, outgoingMessage?.message ?? null, 'ORCHESTRATOR');
    }
  }

  private createOutgoingCommand(
    message: SagaEventMessage,
    decision: OrchestratorDecision,
  ): { message: SagaMessage; topic: string } | null {
    if (!decision.commandType || !decision.targetService) {
      return null;
    }

    const command = createSagaCommand(message, decision.targetService, decision.commandType);
    return {
      message: command,
      topic: ORCHESTRATION_COMMAND_TOPICS[decision.targetService],
    };
  }
}
