import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../common/config/configuration';
import type { StartSagaDto } from './dto/start-saga.dto';
import { SagaRepository } from './persistence/saga.repository';
import { CHOREOGRAPHY_TOPICS, ORCHESTRATION_RESULT_TOPICS } from './shared/saga.constants';
import { createInitialSagaEvent } from './shared/saga-message.factory';
import type { SagaInstance, SagaStrategy, SagaTimelineEntry } from './shared/saga-status.types';

export interface SagaStartedResponse {
  orderId: string;
  sagaId: string;
  status: 'STARTED';
  strategy: SagaStrategy;
}

@Injectable()
export class SagaPatternService {
  private readonly appConfig: AppConfig;

  constructor(
    configService: ConfigService,
    private readonly repository: SagaRepository,
  ) {
    this.appConfig = configService.getOrThrow<AppConfig>('app');
  }

  async start(strategy: SagaStrategy, request: StartSagaDto): Promise<SagaStartedResponse> {
    this.assertConfigured();
    const initialEvent = createInitialSagaEvent(
      strategy,
      request.failAt,
      request.compensationFailAt,
    );
    const topic =
      strategy === 'CHOREOGRAPHY' ? CHOREOGRAPHY_TOPICS.ORDER : ORCHESTRATION_RESULT_TOPICS.ORDER;

    // HTTP 요청은 상태와 첫 outbox 메시지만 커밋하고 실제 Saga 실행은 비동기로 넘긴다.
    const saga = await this.repository.createSaga({ message: initialEvent, topic });
    return {
      orderId: saga.orderId,
      sagaId: saga.sagaId,
      status: 'STARTED',
      strategy,
    };
  }

  async getSaga(sagaId: string): Promise<SagaInstance> {
    this.assertConfigured();
    const saga = await this.repository.findSaga(sagaId);
    if (!saga) {
      throw new NotFoundException(`Saga not found: ${sagaId}`);
    }
    return saga;
  }

  async getTimeline(sagaId: string): Promise<SagaTimelineEntry[]> {
    await this.getSaga(sagaId);
    return this.repository.getTimeline(sagaId);
  }

  async reset(): Promise<{ reset: true }> {
    this.assertConfigured();
    await this.repository.reset();
    return { reset: true };
  }

  private assertConfigured(): void {
    if (
      !this.appConfig.sagaPattern.enabled ||
      !this.appConfig.postgres.enabled ||
      !this.appConfig.kafka.enabled ||
      !this.repository.isConfigured()
    ) {
      throw new ServiceUnavailableException('PostgreSQL and Kafka are required for this Lab');
    }
  }
}
