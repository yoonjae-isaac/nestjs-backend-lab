import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../common/config/configuration';
import type { InventoryOrderDto } from '../dto/inventory.dto';
import { INVENTORY_LAB } from '../domain/inventory.constants';
import type { InventoryOrderResponse } from '../domain/inventory.types';
import { InventoryMetricsService } from '../metrics/inventory-metrics.service';
import { InventoryPostgresRepository } from '../postgres/inventory-postgres.repository';

const wait = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

@Injectable()
export class NaiveInventoryService {
  private readonly config: AppConfig['inventoryConcurrency'];
  private readonly instanceId: string;
  private readonly logger = new Logger(NaiveInventoryService.name);

  constructor(
    configService: ConfigService,
    private readonly postgresRepository: InventoryPostgresRepository,
    private readonly metrics: InventoryMetricsService,
  ) {
    this.config = configService.getOrThrow<AppConfig['inventoryConcurrency']>(
      'app.inventoryConcurrency',
    );
    this.instanceId = configService.getOrThrow<AppConfig['instanceId']>('app.instanceId');
  }

  async order(
    order: InventoryOrderDto,
    requestId: string,
    delayMs = this.config.naiveDelayMs,
  ): Promise<InventoryOrderResponse> {
    const startedAt = performance.now();
    this.logger.log({
      event: 'NAIVE_START',
      instanceId: this.instanceId,
      lab: INVENTORY_LAB,
      requestId,
      skuId: order.skuId,
      strategy: 'NAIVE',
    });

    try {
      // 락 없이 재고를 먼저 읽어 여러 요청이 같은 값을 보게 한다.
      const stock = await this.postgresRepository.findStock(order.skuId);
      if (stock === null || stock < order.quantity) {
        const duration = performance.now() - startedAt;
        this.metrics.record('NAIVE', 'outOfStock', duration);
        this.logger.log(this.logFields('NAIVE_OUT_OF_STOCK', order.skuId, requestId, duration));
        return {
          instanceId: this.instanceId,
          reason: 'OUT_OF_STOCK',
          strategy: 'NAIVE',
          success: false,
        };
      }

      if (delayMs > 0) {
        // 읽기와 쓰기 사이를 벌려 Lost Update가 발생할 확률을 의도적으로 높인다.
        await wait(delayMs);
      }
      // 앞서 읽은 재고를 기준으로 계산한 값을 그대로 덮어써 동시 요청의 변경을 유실시킨다.
      const remainingStock = stock - order.quantity;
      await this.postgresRepository.writeStockWithoutLock(order.skuId, remainingStock);
      const duration = performance.now() - startedAt;
      this.metrics.record('NAIVE', 'success', duration);
      this.logger.log(this.logFields('NAIVE_SUCCESS', order.skuId, requestId, duration));
      return {
        instanceId: this.instanceId,
        remainingStock,
        strategy: 'NAIVE',
        success: true,
      };
    } catch (error: unknown) {
      const duration = performance.now() - startedAt;
      this.metrics.record('NAIVE', 'error', duration);
      this.logger.error({
        ...this.logFields('NAIVE_ERROR', order.skuId, requestId, duration),
        error,
      });
      return {
        instanceId: this.instanceId,
        reason: 'INFRASTRUCTURE_ERROR',
        strategy: 'NAIVE',
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
      strategy: 'NAIVE',
    };
  }
}
