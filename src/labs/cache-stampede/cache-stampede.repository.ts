import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../common/config/configuration';
import { PostgresService } from '../../common/database/postgres/postgres.service';
import type { CacheStrategy, OriginLoadMetric, Product } from './domain/cache-stampede.types';

interface ProductRow {
  name: string;
  price_cents: number;
  product_id: string;
  updated_at: Date;
  version: number;
}

interface MetricRow {
  last_loaded_at: Date | null;
  load_count: string;
  product_id: string;
  strategy: CacheStrategy;
}

@Injectable()
export class CacheStampedeRepository implements OnModuleInit {
  private readonly config: AppConfig['cacheStampede'];

  constructor(
    private readonly postgres: PostgresService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<AppConfig['cacheStampede']>('app.cacheStampede');
  }

  async onModuleInit(): Promise<void> {
    if (this.postgres.isConfigured()) {
      await this.initializeSchema();
    }
  }

  isConfigured(): boolean {
    return this.postgres.isConfigured();
  }

  async initializeSchema(): Promise<void> {
    await this.postgres.withTransaction(async (client) => {
      // 여러 앱 인스턴스의 동시 부팅을 advisory lock으로 직렬화한다.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('lab_cache_stampede_schema'))`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS lab_cache_stampede`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS lab_cache_stampede.product (
          product_id varchar(32) PRIMARY KEY,
          name varchar(100) NOT NULL,
          price_cents integer NOT NULL CHECK (price_cents >= 0),
          version integer NOT NULL CHECK (version > 0),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS lab_cache_stampede.origin_load (
          strategy varchar(32) NOT NULL,
          product_id varchar(32) NOT NULL,
          load_count bigint NOT NULL DEFAULT 0,
          last_loaded_at timestamptz,
          PRIMARY KEY (strategy, product_id)
        )
      `);

      // 별도 reset 없이도 첫 API 호출을 실행할 수 있도록 기본 원본 데이터를 넣는다.
      await client.query(`
        INSERT INTO lab_cache_stampede.product
          (product_id, name, price_cents, version, updated_at)
        SELECT 'product-' || number, 'Product ' || number, 10000 + number * 100, 1, now()
        FROM generate_series(1, 10) AS number
        ON CONFLICT (product_id) DO NOTHING
      `);
    });
  }

  async resetProducts(productCount: number): Promise<string[]> {
    return this.postgres.withTransaction(async (client) => {
      const previousProducts = await client.query<{ product_id: string }>(
        `SELECT product_id FROM lab_cache_stampede.product`,
      );

      // 원본과 분산 측정값을 한 트랜잭션에서 동일한 시작 상태로 되돌린다.
      await client.query(`DELETE FROM lab_cache_stampede.origin_load`);
      await client.query(`DELETE FROM lab_cache_stampede.product`);
      await client.query(
        `
          INSERT INTO lab_cache_stampede.product
            (product_id, name, price_cents, version, updated_at)
          SELECT 'product-' || number, 'Product ' || number, 10000 + number * 100, 1, now()
          FROM generate_series(1, $1::integer) AS number
        `,
        [productCount],
      );

      const currentProductIds = Array.from(
        { length: productCount },
        (_, index) => `product-${index + 1}`,
      );
      return [
        ...new Set([...previousProducts.rows.map((row) => row.product_id), ...currentProductIds]),
      ];
    });
  }

  async loadOrigin(strategy: CacheStrategy, productId: string): Promise<Product> {
    // 짧은 auto-commit 증가로 3개 인스턴스 값을 합산하되 원본 지연 구간을 직렬화하지 않는다.
    await this.postgres.query(
      `
        INSERT INTO lab_cache_stampede.origin_load
          (strategy, product_id, load_count, last_loaded_at)
        VALUES ($1, $2, 1, now())
        ON CONFLICT (strategy, product_id)
        DO UPDATE SET
          load_count = origin_load.load_count + 1,
          last_loaded_at = now()
      `,
      [strategy, productId],
    );

    // 느린 DB나 외부 API를 재현해 동시 miss가 겹칠 수 있는 관찰 구간을 만든다.
    await this.postgres.query(`SELECT pg_sleep($1::double precision / 1000.0)`, [
      this.config.originDelayMs,
    ]);
    const result = await this.postgres.query<ProductRow>(
      `
        SELECT product_id, name, price_cents, version, updated_at
        FROM lab_cache_stampede.product
        WHERE product_id = $1
      `,
      [productId],
    );
    const product = result.rows[0];

    if (!product) {
      throw new NotFoundException(`Product ${productId} does not exist`);
    }
    return this.mapProduct(product);
  }

  async updateProduct(productId: string, name: string, priceCents: number): Promise<Product> {
    // 캐시는 일부러 무효화하지 않아 각 전략이 원본 변경을 언제 반영하는지 관찰한다.
    const result = await this.postgres.query<ProductRow>(
      `
        UPDATE lab_cache_stampede.product
        SET name = $2, price_cents = $3, version = version + 1, updated_at = now()
        WHERE product_id = $1
        RETURNING product_id, name, price_cents, version, updated_at
      `,
      [productId, name, priceCents],
    );
    const product = result.rows[0];
    if (!product) {
      throw new NotFoundException(`Product ${productId} does not exist`);
    }
    return this.mapProduct(product);
  }

  async getMetrics(productId?: string): Promise<OriginLoadMetric[]> {
    const result = await this.postgres.query<MetricRow>(
      `
        SELECT strategy, product_id, load_count, last_loaded_at
        FROM lab_cache_stampede.origin_load
        WHERE ($1::varchar IS NULL OR product_id = $1)
        ORDER BY strategy, product_id
      `,
      [productId ?? null],
    );
    return result.rows.map((row) => ({
      lastLoadedAt: row.last_loaded_at?.toISOString() ?? null,
      loadCount: Number.parseInt(row.load_count, 10),
      productId: row.product_id,
      strategy: row.strategy,
    }));
  }

  private mapProduct(row: ProductRow): Product {
    return {
      name: row.name,
      priceCents: row.price_cents,
      productId: row.product_id,
      updatedAt: row.updated_at.toISOString(),
      version: row.version,
    };
  }
}
