import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../common/config/configuration';
import { KafkaService } from '../../../common/kafka/kafka.service';
import { SAGA_TOPICS, SAGA_TOPIC_PARTITIONS } from '../shared/saga.constants';

@Injectable()
export class SagaTopicService implements OnModuleInit {
  private readonly config: AppConfig['sagaPattern'];

  constructor(
    configService: ConfigService,
    private readonly kafka: KafkaService,
  ) {
    this.config = configService.getOrThrow<AppConfig['sagaPattern']>('app.sagaPattern');
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled || this.config.serviceRole || !this.kafka.isConfigured()) {
      return;
    }

    // Gateway 한 곳만 topic을 생성해 여러 worker가 동시에 Kafka metadata를 갱신하지 않게 한다.
    for (const topic of SAGA_TOPICS) {
      await this.kafka.ensureTopic(topic, SAGA_TOPIC_PARTITIONS);
    }
  }
}
