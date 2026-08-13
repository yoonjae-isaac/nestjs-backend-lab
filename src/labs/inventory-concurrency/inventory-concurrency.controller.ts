import { randomUUID } from 'node:crypto';

import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';

import { DbAtomicService } from './db-atomic/db-atomic.service';
import {
  InventoryOrderDto,
  InventoryResetDto,
  InventorySkuDto,
  NaiveDelayDto,
} from './dto/inventory.dto';
import type {
  InventoryMetricsSnapshot,
  InventoryOrderResponse,
  InventoryState,
} from './domain/inventory.types';
import { InventoryConcurrencyService } from './inventory-concurrency.service';
import { inventoryConcurrencyLabConfig } from './lab.config';
import { InventoryMetricsService } from './metrics/inventory-metrics.service';
import { NaiveInventoryService } from './naive/naive-inventory.service';
import { RedisInventoryService } from './redis-kafka/redis-inventory.service';

interface RequestWithId {
  id?: string;
}

@Controller('labs/inventory-concurrency')
export class InventoryConcurrencyController {
  constructor(
    private readonly inventory: InventoryConcurrencyService,
    private readonly naive: NaiveInventoryService,
    private readonly dbAtomic: DbAtomicService,
    private readonly redisInventory: RedisInventoryService,
    private readonly metrics: InventoryMetricsService,
  ) {}

  @Get()
  getLabConfig(): typeof inventoryConcurrencyLabConfig {
    return inventoryConcurrencyLabConfig;
  }

  @Post('reset')
  reset(@Body() resetRequest: InventoryResetDto): Promise<InventoryState> {
    // 모든 전략이 동일한 초기 재고에서 시작하도록 실험 상태를 초기화한다.
    return this.inventory.reset(resetRequest);
  }

  @Post('naive/orders')
  orderNaively(
    @Body() order: InventoryOrderDto,
    @Query() delay: NaiveDelayDto,
    @Req() request: RequestWithId,
  ): Promise<InventoryOrderResponse> {
    // 요청 식별자와 인위적 지연 시간을 전달해 Lost Update 재현 조건을 만든다.
    return this.naive.order(order, request.id ?? randomUUID(), delay.delayMs);
  }

  @Post('db-atomic/orders')
  orderWithDbAtomic(
    @Body() order: InventoryOrderDto,
    @Req() request: RequestWithId,
  ): Promise<InventoryOrderResponse> {
    // 재고 조건을 포함한 PostgreSQL 단일 UPDATE 전략으로 주문을 처리한다.
    return this.dbAtomic.order(order, request.id ?? randomUUID());
  }

  @Post('redis-kafka/orders')
  orderWithRedisKafka(
    @Body() order: InventoryOrderDto,
    @Req() request: RequestWithId,
  ): Promise<InventoryOrderResponse> {
    // Redis에서 재고를 차감한 뒤 Kafka로 DB 반영 이벤트를 발행한다.
    return this.redisInventory.order(order, request.id ?? randomUUID());
  }

  @Get('state/:skuId')
  getState(@Param() inventorySku: InventorySkuDto): Promise<InventoryState> {
    // PostgreSQL과 Redis의 현재 재고 차이를 한 응답에서 확인한다.
    return this.inventory.getState(inventorySku.skuId);
  }

  @Get('metrics')
  getMetrics(): InventoryMetricsSnapshot {
    return this.metrics.getSnapshot();
  }
}
