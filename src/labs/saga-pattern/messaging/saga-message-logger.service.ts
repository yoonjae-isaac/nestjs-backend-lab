import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../common/config/configuration';
import { SAGA_LAB } from '../shared/saga.constants';
import { sagaMessageAction, type SagaMessage } from '../shared/saga-message.types';
import type { SagaService } from '../shared/saga-status.types';

@Injectable()
export class SagaMessageLogger {
  private readonly instanceId: string;
  private readonly logger = new Logger(SagaMessageLogger.name);

  constructor(configService: ConfigService) {
    this.instanceId = configService.getOrThrow<AppConfig['instanceId']>('app.instanceId');
  }

  handled(
    incomingMessage: SagaMessage,
    outgoingMessage: SagaMessage | null,
    actorService: SagaService = outgoingMessage?.service ?? incomingMessage.service,
  ): void {
    this.logger.log({
      action: sagaMessageAction(incomingMessage),
      commandType: incomingMessage.kind === 'COMMAND' ? incomingMessage.commandType : undefined,
      event: 'SAGA_MESSAGE_HANDLED',
      eventType: incomingMessage.kind === 'EVENT' ? incomingMessage.eventType : undefined,
      instanceId: this.instanceId,
      lab: SAGA_LAB,
      nextAction: outgoingMessage ? sagaMessageAction(outgoingMessage) : null,
      orderId: incomingMessage.orderId,
      sagaId: incomingMessage.sagaId,
      service: actorService,
      sourceService: incomingMessage.service,
      strategy: incomingMessage.strategy,
      timestamp: new Date().toISOString(),
    });
  }

  ignored(message: SagaMessage, reason: string, actorService: SagaService): void {
    this.logger.warn({
      action: sagaMessageAction(message),
      event: 'SAGA_MESSAGE_IGNORED',
      instanceId: this.instanceId,
      lab: SAGA_LAB,
      orderId: message.orderId,
      reason,
      sagaId: message.sagaId,
      service: actorService,
      sourceService: message.service,
      strategy: message.strategy,
      timestamp: new Date().toISOString(),
    });
  }
}
