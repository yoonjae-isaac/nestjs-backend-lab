import { Module } from '@nestjs/common';

import { PostgresModule } from '../../common/database/postgres/postgres.module';
import { KafkaModule } from '../../common/kafka/kafka.module';
import { SagaConsumerService } from './messaging/saga-consumer.service';
import { SagaMessageLogger } from './messaging/saga-message-logger.service';
import { SagaOutboxRelay } from './messaging/saga-outbox-relay.service';
import { SagaTopicService } from './messaging/saga-topic.service';
import { SagaRepository } from './persistence/saga.repository';

@Module({
  imports: [PostgresModule, KafkaModule],
  providers: [
    SagaRepository,
    SagaTopicService,
    SagaConsumerService,
    SagaMessageLogger,
    SagaOutboxRelay,
  ],
  exports: [SagaRepository, SagaConsumerService, SagaMessageLogger],
})
export class SagaInfrastructureModule {}
