import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../common/config/configuration';
import type { InventoryOrderDto } from '../dto/inventory.dto';
import { INVENTORY_LAB } from '../domain/inventory.constants';
import type { InventoryOrderResponse } from '../domain/inventory.types';
import { InventoryMetricsService } from '../metrics/inventory-metrics.service';
import { InventoryEventProducer } from './inventory-event.producer';
import { RedisInventoryRepository } from './redis-inventory.repository';

@Injectable()
export class RedisInventoryService {
  private readonly instanceId: string;
  private readonly logger = new Logger(RedisInventoryService.name);

  constructor(
    configService: ConfigService,
    private readonly redisRepository: RedisInventoryRepository,
    private readonly eventProducer: InventoryEventProducer,
    private readonly metrics: InventoryMetricsService,
  ) {
    this.instanceId = configService.getOrThrow<AppConfig['instanceId']>('app.instanceId');
  }

  async order(order: InventoryOrderDto, requestId: string): Promise<InventoryOrderResponse> {
    const startedAt = performance.now();

    try {
      // 캐시 미스면 Redis 재고를 한 번 초기화한 뒤 Lua로 원자적으로 차감한다.
      await this.redisRepository.getOrInitializeStock(order.skuId, requestId);
      const remainingStock = await this.redisRepository.decrease(order.skuId, order.quantity);
      const redisDuration = performance.now() - startedAt;
      if (remainingStock === null) {
        this.metrics.record('REDIS_KAFKA', 'outOfStock', redisDuration);
        this.logger.log(
          this.logFields('REDIS_OUT_OF_STOCK', order.skuId, requestId, redisDuration),
        );
        return {
          instanceId: this.instanceId,
          reason: 'OUT_OF_STOCK',
          strategy: 'REDIS_KAFKA',
          success: false,
        };
      }

      this.logger.log(
        this.logFields('REDIS_DECREASE_SUCCESS', order.skuId, requestId, redisDuration),
      );
      try {
        // Redis 변경이 성공한 뒤 Kafka 이벤트를 발행해 PostgreSQL에 비동기로 반영한다.
        await this.eventProducer.publish(order, remainingStock, requestId);
      } catch (error: unknown) {
        // 발행 실패 시 Redis만 변경된 dual-write 불일치를 응답과 로그에 명시한다.
        const duration = performance.now() - startedAt;
        this.metrics.increment('kafkaPublishFailure');
        this.metrics.record('REDIS_KAFKA', 'error', duration);
        this.logger.error({
          ...this.logFields('KAFKA_EVENT_PUBLISH_FAILED', order.skuId, requestId, duration),
          error,
          inventoryChanged: true,
          remainingStock,
        });
        return {
          instanceId: this.instanceId,
          inventoryChanged: true,
          reason: 'EVENT_PUBLISH_FAILED',
          remainingStock,
          strategy: 'REDIS_KAFKA',
          success: false,
        };
      }

      const duration = performance.now() - startedAt;
      this.metrics.record('REDIS_KAFKA', 'success', duration);
      return {
        instanceId: this.instanceId,
        remainingStock,
        strategy: 'REDIS_KAFKA',
        success: true,
      };
    } catch (error: unknown) {
      const duration = performance.now() - startedAt;
      this.metrics.record('REDIS_KAFKA', 'error', duration);
      this.logger.error({
        ...this.logFields('REDIS_INVENTORY_ERROR', order.skuId, requestId, duration),
        error,
      });
      return {
        instanceId: this.instanceId,
        reason: 'INFRASTRUCTURE_ERROR',
        strategy: 'REDIS_KAFKA',
        success: false,
      };
    }
  }

  private logFields(event: string, skuId: string, requestId: string, duration: number): object {
    return {
      duration,
      event,
      instanceId: this.instanceId,
      lab: INVENTORY_LAB,
      requestId,
      skuId,
      strategy: 'REDIS_KAFKA',
    };
  }
}
