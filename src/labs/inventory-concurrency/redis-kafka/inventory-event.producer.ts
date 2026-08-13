import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../common/config/configuration';
import { KafkaService } from '../../../common/kafka/kafka.service';
import type { InventoryOrderDto } from '../dto/inventory.dto';
import { INVENTORY_LAB, INVENTORY_TOPIC } from '../domain/inventory.constants';
import type { InventoryEvent } from '../domain/inventory.types';
import { InventoryMetricsService } from '../metrics/inventory-metrics.service';

@Injectable()
export class InventoryEventProducer {
  private readonly instanceId: string;
  private readonly logger = new Logger(InventoryEventProducer.name);

  constructor(
    configService: ConfigService,
    private readonly kafka: KafkaService,
    private readonly metrics: InventoryMetricsService,
  ) {
    this.instanceId = configService.getOrThrow<AppConfig['instanceId']>('app.instanceId');
  }

  async publish(
    order: InventoryOrderDto,
    remainingStock: number,
    requestId: string,
  ): Promise<InventoryEvent> {
    // 재전달을 식별할 이벤트 ID와 요청 추적 정보를 포함한 메시지를 만든다.
    const event: InventoryEvent = {
      eventId: randomUUID(),
      eventType: 'INVENTORY_DECREASED',
      instanceId: this.instanceId,
      occurredAt: new Date().toISOString(),
      quantity: order.quantity,
      remainingStock,
      requestId,
      skuId: order.skuId,
      strategy: 'REDIS_KAFKA',
    };
    const publishStartedAt = performance.now();
    // 같은 SKU가 같은 파티션으로 가도록 skuId를 Kafka 메시지 키로 사용한다.
    await this.kafka.publish(INVENTORY_TOPIC, order.skuId, event);
    this.metrics.increment('kafkaPublishSuccess');
    this.metrics.observeDuration('kafkaPublishDuration', performance.now() - publishStartedAt);
    this.logger.log({
      event: 'KAFKA_EVENT_PUBLISHED',
      eventId: event.eventId,
      instanceId: this.instanceId,
      lab: INVENTORY_LAB,
      requestId,
      skuId: order.skuId,
      strategy: 'REDIS_KAFKA',
      topic: INVENTORY_TOPIC,
    });
    return event;
  }
}
