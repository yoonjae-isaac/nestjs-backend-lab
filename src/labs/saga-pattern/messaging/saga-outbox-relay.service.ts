import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../common/config/configuration';
import { KafkaService } from '../../../common/kafka/kafka.service';
import { SagaRepository } from '../persistence/saga.repository';
import { SAGA_LAB } from '../shared/saga.constants';
import { parseSagaMessage } from '../shared/saga-message.types';

@Injectable()
export class SagaOutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly config: AppConfig['sagaPattern'];
  private isDraining = false;
  private readonly logger = new Logger(SagaOutboxRelay.name);
  private readonly owner: string;
  private timer?: NodeJS.Timeout;

  constructor(
    configService: ConfigService,
    private readonly kafka: KafkaService,
    private readonly repository: SagaRepository,
  ) {
    this.config = configService.getOrThrow<AppConfig['sagaPattern']>('app.sagaPattern');
    const instanceId = configService.getOrThrow<AppConfig['instanceId']>('app.instanceId');
    this.owner = `${instanceId}:${process.pid}`;
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled || !this.kafka.isConfigured() || !this.repository.isConfigured()) {
      return;
    }

    // 짧은 polling과 lease를 조합해 여러 relay가 떠도 한 메시지만 점유하게 한다.
    this.timer = setInterval(() => void this.drain(), this.config.outboxPollMs);
    void this.drain();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async drain(): Promise<void> {
    if (this.isDraining) {
      return;
    }
    this.isDraining = true;

    try {
      for (let publishedCount = 0; publishedCount < 100; publishedCount += 1) {
        const outboxRecord = await this.repository.claimOutbox(
          this.owner,
          this.config.outboxLeaseMs,
        );
        if (!outboxRecord) {
          return;
        }

        try {
          const message = parseSagaMessage(JSON.stringify(outboxRecord.payload));
          await this.kafka.publish(outboxRecord.topic, outboxRecord.message_key, message);
          await this.repository.markOutboxPublished(outboxRecord.message_id, this.owner);
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          await this.repository.releaseOutbox(outboxRecord.message_id, this.owner, errorMessage);
          this.logger.error({
            error,
            event: 'SAGA_OUTBOX_PUBLISH_FAILED',
            lab: SAGA_LAB,
            messageId: outboxRecord.message_id,
            topic: outboxRecord.topic,
          });
          return;
        }
      }
    } finally {
      this.isDraining = false;
    }
  }
}
