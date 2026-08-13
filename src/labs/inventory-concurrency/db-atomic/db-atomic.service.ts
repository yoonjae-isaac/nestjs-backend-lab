import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../common/config/configuration';
import type { InventoryOrderDto } from '../dto/inventory.dto';
import { INVENTORY_LAB } from '../domain/inventory.constants';
import type { InventoryOrderResponse } from '../domain/inventory.types';
import { InventoryMetricsService } from '../metrics/inventory-metrics.service';
import { InventoryPostgresRepository } from '../postgres/inventory-postgres.repository';

@Injectable()
export class DbAtomicService {
  private readonly instanceId: string;
  private readonly logger = new Logger(DbAtomicService.name);

  constructor(
    configService: ConfigService,
    private readonly postgresRepository: InventoryPostgresRepository,
    private readonly metrics: InventoryMetricsService,
  ) {
    this.instanceId = configService.getOrThrow<AppConfig['instanceId']>('app.instanceId');
  }

  async order(order: InventoryOrderDto, requestId: string): Promise<InventoryOrderResponse> {
    const startedAt = performance.now();
    this.logger.log(this.logFields('DB_ATOMIC_START', order.skuId, requestId, 0));

    try {
      // 재고 확인과 감소를 조건부 UPDATE 한 번으로 묶어 DB가 원자성을 보장하게 한다.
      const decreaseRecord = await this.postgresRepository.decreaseAtomically(
        order.skuId,
        order.quantity,
      );
      const duration = performance.now() - startedAt;
      // 전체 요청 시간과 별도로 트랜잭션 및 쿼리 구간의 경합 시간을 기록한다.
      this.metrics.observeDuration(
        'dbAtomicTransactionDuration',
        decreaseRecord.transactionDurationMs,
      );
      this.metrics.observeDuration('dbAtomicQueryDuration', decreaseRecord.queryDurationMs);

      // 조건을 만족한 행이 없으면 재고 부족으로 해석한다.
      if (decreaseRecord.remainingStock === null) {
        this.metrics.record('DB_ATOMIC', 'outOfStock', duration);
        this.logger.log(this.logFields('DB_ATOMIC_OUT_OF_STOCK', order.skuId, requestId, duration));
        return {
          instanceId: this.instanceId,
          reason: 'OUT_OF_STOCK',
          strategy: 'DB_ATOMIC',
          success: false,
        };
      }

      this.metrics.record('DB_ATOMIC', 'success', duration);
      this.logger.log(this.logFields('DB_ATOMIC_SUCCESS', order.skuId, requestId, duration));
      return {
        instanceId: this.instanceId,
        remainingStock: decreaseRecord.remainingStock,
        strategy: 'DB_ATOMIC',
        success: true,
      };
    } catch (error: unknown) {
      const duration = performance.now() - startedAt;
      this.metrics.record('DB_ATOMIC', 'error', duration);
      this.logger.error({
        ...this.logFields('DB_ATOMIC_ERROR', order.skuId, requestId, duration),
        error,
      });
      return {
        instanceId: this.instanceId,
        reason: 'INFRASTRUCTURE_ERROR',
        strategy: 'DB_ATOMIC',
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
      strategy: 'DB_ATOMIC',
    };
  }
}
