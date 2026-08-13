import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Consumer, EachMessagePayload } from 'kafkajs';

import type { AppConfig } from '../../../common/config/configuration';
import { KafkaService } from '../../../common/kafka/kafka.service';
import {
  INVENTORY_CONSUMER_GROUP_SUFFIX,
  INVENTORY_LAB,
  INVENTORY_TOPIC,
  INVENTORY_TOPIC_PARTITIONS,
} from '../domain/inventory.constants';
import { parseInventoryEvent, type InventoryEvent } from '../domain/inventory.types';
import { InventoryMetricsService } from '../metrics/inventory-metrics.service';
import { InventoryPostgresRepository } from '../postgres/inventory-postgres.repository';

const wait = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

@Injectable()
export class InventoryEventConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly config: AppConfig['inventoryConcurrency'];
  private consumer?: Consumer;
  private readonly instanceId: string;
  private readonly logger = new Logger(InventoryEventConsumer.name);

  constructor(
    configService: ConfigService,
    private readonly kafka: KafkaService,
    private readonly postgresRepository: InventoryPostgresRepository,
    private readonly metrics: InventoryMetricsService,
  ) {
    this.config = configService.getOrThrow<AppConfig['inventoryConcurrency']>(
      'app.inventoryConcurrency',
    );
    this.instanceId = configService.getOrThrow<AppConfig['instanceId']>('app.instanceId');
  }

  async onModuleInit(): Promise<void> {
    if (!this.kafka.isConfigured() || !this.postgresRepository.isConfigured()) {
      return;
    }

    await this.kafka.ensureTopic(INVENTORY_TOPIC, INVENTORY_TOPIC_PARTITIONS);
    this.consumer = this.kafka.createConsumer(INVENTORY_CONSUMER_GROUP_SUFFIX);
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: INVENTORY_TOPIC, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async (payload) => this.consume(payload),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.disconnect();
  }

  async handleEvent(event: InventoryEvent): Promise<void> {
    if (this.config.consumerDelayMs > 0) {
      await wait(this.config.consumerDelayMs);
    }

    const persistenceRecord = await this.postgresRepository.persistInventoryEvent(event);
    if (persistenceRecord.duplicate) {
      this.metrics.increment('kafkaDuplicateEvent');
      this.logger.warn({
        event: 'KAFKA_DUPLICATE_EVENT_SKIPPED',
        eventId: event.eventId,
        instanceId: this.instanceId,
        lab: INVENTORY_LAB,
        requestId: event.requestId,
        skuId: event.skuId,
        strategy: 'REDIS_KAFKA',
      });
      return;
    }

    this.metrics.increment('kafkaConsumerProcessed');
    this.metrics.observeDuration(
      'consumerTransactionDuration',
      persistenceRecord.transactionDurationMs,
    );
    this.logger.log({
      event: 'DB_ASYNC_UPDATE_SUCCESS',
      eventId: event.eventId,
      instanceId: this.instanceId,
      lab: INVENTORY_LAB,
      requestId: event.requestId,
      skuId: event.skuId,
      strategy: 'REDIS_KAFKA',
    });
  }

  private async consume(payload: EachMessagePayload): Promise<void> {
    if (!payload.message.value) {
      throw new Error('Inventory event has no value');
    }

    const event = parseInventoryEvent(payload.message.value.toString('utf8'));
    this.logger.log({
      consumerGroup: `backend-lab.${INVENTORY_CONSUMER_GROUP_SUFFIX}`,
      event: 'KAFKA_EVENT_RECEIVED',
      eventId: event.eventId,
      instanceId: this.instanceId,
      lab: INVENTORY_LAB,
      offset: payload.message.offset,
      partition: payload.partition,
      requestId: event.requestId,
      skuId: event.skuId,
      strategy: 'REDIS_KAFKA',
      topic: payload.topic,
    });
    await this.handleEvent(event);
  }
}
