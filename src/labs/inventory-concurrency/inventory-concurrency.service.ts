import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import type { InventoryResetDto } from './dto/inventory.dto';
import type { InventoryState } from './domain/inventory.types';
import { InventoryMetricsService } from './metrics/inventory-metrics.service';
import { InventoryPostgresRepository } from './postgres/inventory-postgres.repository';
import { RedisInventoryRepository } from './redis-kafka/redis-inventory.repository';

@Injectable()
export class InventoryConcurrencyService {
  constructor(
    private readonly postgresRepository: InventoryPostgresRepository,
    private readonly redisRepository: RedisInventoryRepository,
    private readonly metrics: InventoryMetricsService,
  ) {}

  async reset(resetRequest: InventoryResetDto): Promise<InventoryState> {
    this.assertConfigured();
    await this.postgresRepository.reset(resetRequest.skuId, resetRequest.stock);
    await this.redisRepository.reset(resetRequest.skuId, resetRequest.stock);
    this.metrics.reset();
    return this.getState(resetRequest.skuId);
  }

  async getState(skuId: string): Promise<InventoryState> {
    this.assertConfigured();
    const [postgresStock, redisStock] = await Promise.all([
      this.postgresRepository.findStock(skuId),
      this.redisRepository.getStock(skuId),
    ]);

    return {
      difference: postgresStock === null || redisStock === null ? null : redisStock - postgresStock,
      postgresStock,
      redisStock,
      skuId,
    };
  }

  private assertConfigured(): void {
    if (!this.postgresRepository.isConfigured() || !this.redisRepository.isConfigured()) {
      throw new ServiceUnavailableException('PostgreSQL and Redis are required for this Lab');
    }
  }
}
