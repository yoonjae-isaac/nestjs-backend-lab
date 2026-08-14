import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';

import { CacheStampedeService } from './cache-stampede.service';
import { ProductIdDto, ResetCacheStampedeDto, UpdateProductDto } from './dto/cache-stampede.dto';
import type {
  CacheReadResponse,
  CacheState,
  OriginLoadMetric,
  Product,
} from './domain/cache-stampede.types';
import { cacheStampedeLabConfig } from './lab.config';

@Controller('labs/cache-stampede')
export class CacheStampedeController {
  constructor(private readonly cacheStampede: CacheStampedeService) {}

  @Get()
  getLabConfig(): typeof cacheStampedeLabConfig {
    return cacheStampedeLabConfig;
  }

  @Post('reset')
  reset(
    @Body() resetRequest: ResetCacheStampedeDto,
  ): Promise<{ productCount: number; strategies: number }> {
    // 원본 상품, 측정값, 모든 전략의 Redis key를 같은 cold-start 상태로 초기화한다.
    return this.cacheStampede.reset(resetRequest.productCount);
  }

  @Get('baseline/products/:productId')
  getBaseline(@Param() product: ProductIdDto): Promise<CacheReadResponse> {
    return this.cacheStampede.getBaseline(product.productId);
  }

  @Get('ttl-jitter/products/:productId')
  getWithTtlJitter(@Param() product: ProductIdDto): Promise<CacheReadResponse> {
    return this.cacheStampede.getWithTtlJitter(product.productId);
  }

  @Get('refresh-ahead/products/:productId')
  getWithRefreshAhead(@Param() product: ProductIdDto): Promise<CacheReadResponse> {
    return this.cacheStampede.getWithRefreshAhead(product.productId);
  }

  @Post('refresh-ahead/prewarm/:productId')
  prewarm(@Param() product: ProductIdDto): Promise<CacheReadResponse> {
    return this.cacheStampede.prewarm(product.productId);
  }

  @Get('stale-while-revalidate/products/:productId')
  getWithStaleWhileRevalidate(@Param() product: ProductIdDto): Promise<CacheReadResponse> {
    return this.cacheStampede.getWithStaleWhileRevalidate(product.productId);
  }

  @Get('single-flight/products/:productId')
  getWithSingleFlight(@Param() product: ProductIdDto): Promise<CacheReadResponse> {
    return this.cacheStampede.getWithSingleFlight(product.productId);
  }

  @Put('origin/products/:productId')
  updateOrigin(@Param() product: ProductIdDto, @Body() update: UpdateProductDto): Promise<Product> {
    // 캐시 무효화 없이 원본 version만 바꿔 stale 응답과 갱신 시점을 눈으로 확인한다.
    return this.cacheStampede.updateProduct(product.productId, update.name, update.priceCents);
  }

  @Get('metrics')
  getMetrics(): Promise<OriginLoadMetric[]> {
    return this.cacheStampede.getMetrics();
  }

  @Get('state/:productId')
  getState(@Param() product: ProductIdDto): Promise<CacheState[]> {
    // 전략별 Redis TTL과 캐시된 상품 version을 한 응답에서 비교한다.
    return this.cacheStampede.getState(product.productId);
  }
}
