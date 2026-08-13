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
    return this.inventory.reset(resetRequest);
  }

  @Post('naive/orders')
  orderNaively(
    @Body() order: InventoryOrderDto,
    @Query() delay: NaiveDelayDto,
    @Req() request: RequestWithId,
  ): Promise<InventoryOrderResponse> {
    return this.naive.order(order, request.id ?? randomUUID(), delay.delayMs);
  }

  @Post('db-atomic/orders')
  orderWithDbAtomic(
    @Body() order: InventoryOrderDto,
    @Req() request: RequestWithId,
  ): Promise<InventoryOrderResponse> {
    return this.dbAtomic.order(order, request.id ?? randomUUID());
  }

  @Post('redis-kafka/orders')
  orderWithRedisKafka(
    @Body() order: InventoryOrderDto,
    @Req() request: RequestWithId,
  ): Promise<InventoryOrderResponse> {
    return this.redisInventory.order(order, request.id ?? randomUUID());
  }

  @Get('state/:skuId')
  getState(@Param() inventorySku: InventorySkuDto): Promise<InventoryState> {
    return this.inventory.getState(inventorySku.skuId);
  }

  @Get('metrics')
  getMetrics(): InventoryMetricsSnapshot {
    return this.metrics.getSnapshot();
  }
}
