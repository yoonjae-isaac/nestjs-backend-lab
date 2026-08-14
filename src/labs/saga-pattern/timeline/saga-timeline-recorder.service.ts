import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../common/config/configuration';
import { SagaConsumerService } from '../messaging/saga-consumer.service';
import { SagaRepository } from '../persistence/saga.repository';
import { SAGA_TOPICS } from '../shared/saga.constants';
import type { SagaMessage } from '../shared/saga-message.types';
import { observeChoreographyEvent } from './choreography-observation';

@Injectable()
export class SagaTimelineRecorder implements OnModuleInit {
  private readonly config: AppConfig['sagaPattern'];

  constructor(
    configService: ConfigService,
    private readonly consumer: SagaConsumerService,
    private readonly repository: SagaRepository,
  ) {
    this.config = configService.getOrThrow<AppConfig['sagaPattern']>('app.sagaPattern');
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled || !this.repository.isConfigured()) {
      return;
    }

    await this.consumer.subscribe('saga-pattern.timeline-recorder', SAGA_TOPICS, async (message) =>
      this.record(message),
    );
  }

  private async record(message: SagaMessage): Promise<void> {
    // Recorder는 메시지 순서만 영속화하며 다음 이벤트나 명령을 발행하지 않는다.
    const isRecorded = await this.repository.recordTimeline(message);
    if (!isRecorded || message.kind !== 'EVENT' || message.strategy !== 'CHOREOGRAPHY') {
      return;
    }

    const saga = await this.repository.findSaga(message.sagaId);
    if (!saga) {
      throw new Error(`Saga does not exist: ${message.sagaId}`);
    }
    const observation = observeChoreographyEvent(saga, message);
    if (observation) {
      // Choreography 상태는 제어용 상태가 아니라 조회를 위한 관찰 projection으로만 갱신한다.
      await this.repository.updateSagaState(message.sagaId, observation);
    }
  }
}
