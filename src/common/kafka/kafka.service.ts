import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';

import type { AppConfig, InfrastructureStatus } from '../config/configuration';
import { LAB_TOPIC_PREFIX } from './kafka.constants';

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly config: AppConfig['kafka'];
  private readonly kafka?: Kafka;
  private readonly logger = new Logger(KafkaService.name);
  private readonly producer?: Producer;
  private isProducerConnected = false;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<AppConfig['kafka']>('app.kafka');
    this.kafka = this.config.enabled
      ? new Kafka({
          brokers: this.config.brokers,
          clientId: this.config.clientId,
          logLevel: logLevel.NOTHING,
        })
      : undefined;
    this.producer = this.kafka?.producer({ allowAutoTopicCreation: this.config.autoCreateTopics });
  }

  async onModuleInit(): Promise<void> {
    if (!this.producer) {
      return;
    }

    try {
      await this.producer.connect();
      this.isProducerConnected = true;
      this.logger.log({ event: 'KAFKA_CONNECTION', status: 'up' });
    } catch (error: unknown) {
      this.logger.warn({ error, event: 'KAFKA_CONNECT_FAILED' });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.isProducerConnected) {
      await this.producer?.disconnect();
    }
  }

  async publish(topic: string, key: string, value: unknown): Promise<void> {
    if (!topic.startsWith(LAB_TOPIC_PREFIX)) {
      throw new Error(`Kafka topic must start with ${LAB_TOPIC_PREFIX}`);
    }
    if (!this.producer || !this.isProducerConnected) {
      throw new Error('Kafka producer is not connected');
    }

    await this.producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(value) }],
    });
  }

  isConfigured(): boolean {
    return this.kafka !== undefined;
  }

  createConsumer(groupSuffix: string): Consumer {
    if (!this.kafka) {
      throw new Error('Kafka is not configured for this run');
    }

    return this.kafka.consumer({ groupId: `${this.config.consumerGroupPrefix}.${groupSuffix}` });
  }

  async ensureTopic(topic: string, partitions: number): Promise<void> {
    if (!topic.startsWith(LAB_TOPIC_PREFIX)) {
      throw new Error(`Kafka topic must start with ${LAB_TOPIC_PREFIX}`);
    }
    if (!this.kafka) {
      throw new Error('Kafka is not configured for this run');
    }

    const admin = this.kafka.admin();
    await admin.connect();
    try {
      await admin.createTopics({
        topics: [{ topic, numPartitions: partitions, replicationFactor: 1 }],
      });
    } finally {
      await admin.disconnect();
    }
  }

  async listTopics(): Promise<string[]> {
    if (!this.kafka) {
      throw new Error('Kafka is not configured for this run');
    }

    const admin = this.kafka.admin();
    await admin.connect();
    try {
      return await admin.listTopics();
    } finally {
      await admin.disconnect();
    }
  }

  async status(): Promise<InfrastructureStatus> {
    if (!this.kafka) {
      return 'not-configured';
    }

    try {
      await this.listTopics();
      return 'up';
    } catch (error: unknown) {
      this.logger.warn({ error, event: 'KAFKA_PING_FAILED' });
      return 'down';
    }
  }
}
