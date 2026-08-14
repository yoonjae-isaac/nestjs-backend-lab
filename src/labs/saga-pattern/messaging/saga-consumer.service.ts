import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Consumer } from 'kafkajs';

import { KafkaService } from '../../../common/kafka/kafka.service';
import {
  parseSagaMessage,
  sagaMessageAction,
  type SagaMessage,
} from '../shared/saga-message.types';
import { SAGA_LAB } from '../shared/saga.constants';

type SagaMessageHandler = (message: SagaMessage) => Promise<void>;

@Injectable()
export class SagaConsumerService implements OnModuleDestroy {
  private readonly consumers: Consumer[] = [];
  private readonly logger = new Logger(SagaConsumerService.name);

  constructor(private readonly kafka: KafkaService) {}

  async subscribe(
    consumerGroupSuffix: string,
    topics: readonly string[],
    handler: SagaMessageHandler,
  ): Promise<void> {
    const consumer = this.kafka.createConsumer(consumerGroupSuffix);
    await consumer.connect();
    await consumer.subscribe({ topics: [...topics], fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message, partition, topic }) => {
        if (!message.value) {
          throw new Error(`Saga message has no value: ${topic}`);
        }

        const sagaMessage = parseSagaMessage(message.value.toString('utf8'));
        try {
          await handler(sagaMessage);
        } catch (error: unknown) {
          this.logger.error({
            action: sagaMessageAction(sagaMessage),
            error,
            event: 'SAGA_CONSUMER_FAILED',
            lab: SAGA_LAB,
            offset: message.offset,
            partition,
            sagaId: sagaMessage.sagaId,
            topic,
          });
          throw error;
        }
      },
    });
    this.consumers.push(consumer);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.consumers.map((consumer) => consumer.disconnect()));
  }
}
