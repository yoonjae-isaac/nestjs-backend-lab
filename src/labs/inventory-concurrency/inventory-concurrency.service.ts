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
    // 영속 재고와 Redis 재고를 같은 값으로 맞춰 전략별 실험 출발점을 통일한다.
    await this.postgresRepository.reset(resetRequest.skuId, resetRequest.stock);
    await this.redisRepository.reset(resetRequest.skuId, resetRequest.stock);
    // 이전 실행의 지표가 새 실험 결과에 섞이지 않도록 초기화한다.
    this.metrics.reset();
    return this.getState(resetRequest.skuId);
  }

  async getState(skuId: string): Promise<InventoryState> {
    this.assertConfigured();
    // 두 저장소를 동시에 조회해 Redis와 DB 사이의 비동기 반영 차이를 관찰한다.
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
    // 상태 초기화와 비교에는 두 저장소가 모두 필요하므로 시작 전에 명확히 실패시킨다.
    if (!this.postgresRepository.isConfigured() || !this.redisRepository.isConfigured()) {
      throw new ServiceUnavailableException('PostgreSQL and Redis are required for this Lab');
    }
  }
}
