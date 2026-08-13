import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../common/config/configuration';
import type {
  InventoryMetricsSnapshot,
  InventoryStrategy,
  StrategyMetrics,
} from '../domain/inventory.types';
import { InventoryPostgresRepository } from '../postgres/inventory-postgres.repository';

interface StrategyMetricRecord {
  error: number;
  latencies: number[];
  outOfStock: number;
  success: number;
}

const createMetricRecord = (): StrategyMetricRecord => ({
  error: 0,
  latencies: [],
  outOfStock: 0,
  success: 0,
});

@Injectable()
export class InventoryMetricsService {
  private readonly counters = new Map<string, number>();
  private readonly instanceId: string;
  private strategyRecords: Record<InventoryStrategy, StrategyMetricRecord> = {
    NAIVE: createMetricRecord(),
    DB_ATOMIC: createMetricRecord(),
    REDIS_KAFKA: createMetricRecord(),
  };

  constructor(
    configService: ConfigService,
    private readonly postgresRepository: InventoryPostgresRepository,
  ) {
    this.instanceId = configService.getOrThrow<AppConfig['instanceId']>('app.instanceId');
  }

  reset(): void {
    this.counters.clear();
    this.strategyRecords = {
      NAIVE: createMetricRecord(),
      DB_ATOMIC: createMetricRecord(),
      REDIS_KAFKA: createMetricRecord(),
    };
  }

  increment(counter: string): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + 1);
  }

  observeDuration(metric: string, durationMs: number): void {
    const countKey = `${metric}Count`;
    const totalKey = `${metric}TotalMs`;
    const maxKey = `${metric}MaxMs`;
    this.counters.set(countKey, (this.counters.get(countKey) ?? 0) + 1);
    this.counters.set(totalKey, (this.counters.get(totalKey) ?? 0) + durationMs);
    this.counters.set(maxKey, Math.max(this.counters.get(maxKey) ?? 0, durationMs));
  }

  record(
    strategy: InventoryStrategy,
    outcome: 'success' | 'outOfStock' | 'error',
    durationMs: number,
  ): void {
    const strategyRecord = this.strategyRecords[strategy];
    strategyRecord[outcome] += 1;
    strategyRecord.latencies.push(durationMs);
  }

  getSnapshot(): InventoryMetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      instanceId: this.instanceId,
      pool: this.postgresRepository.getPoolSnapshot(),
      strategies: {
        NAIVE: this.summarize(this.strategyRecords.NAIVE),
        DB_ATOMIC: this.summarize(this.strategyRecords.DB_ATOMIC),
        REDIS_KAFKA: this.summarize(this.strategyRecords.REDIS_KAFKA),
      },
    };
  }

  private summarize(metricRecord: StrategyMetricRecord): StrategyMetrics {
    const sortedLatencies = [...metricRecord.latencies].sort((left, right) => left - right);
    const totalRequests = metricRecord.success + metricRecord.outOfStock + metricRecord.error;
    const averageLatencyMs =
      totalRequests === 0
        ? 0
        : sortedLatencies.reduce((sum, duration) => sum + duration, 0) / totalRequests;

    return {
      averageLatencyMs,
      error: metricRecord.error,
      outOfStock: metricRecord.outOfStock,
      p50LatencyMs: this.percentile(sortedLatencies, 0.5),
      p95LatencyMs: this.percentile(sortedLatencies, 0.95),
      p99LatencyMs: this.percentile(sortedLatencies, 0.99),
      success: metricRecord.success,
      totalRequests,
    };
  }

  private percentile(sortedValues: readonly number[], percentile: number): number {
    if (sortedValues.length === 0) {
      return 0;
    }

    const index = Math.ceil(sortedValues.length * percentile) - 1;
    return sortedValues[Math.max(index, 0)] ?? 0;
  }
}
