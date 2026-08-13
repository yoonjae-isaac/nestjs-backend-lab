import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';

import type { AppConfig } from '../../../common/config/configuration';
import { PostgresService } from '../../../common/database/postgres/postgres.service';
import type {
  AtomicDecreaseRecord,
  ConsumerPersistenceRecord,
  InventoryEvent,
} from '../domain/inventory.types';

interface StockRow {
  stock: number;
}

@Injectable()
export class InventoryPostgresRepository implements OnModuleInit {
  private readonly config: AppConfig['inventoryConcurrency'];

  constructor(
    private readonly postgres: PostgresService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<AppConfig['inventoryConcurrency']>(
      'app.inventoryConcurrency',
    );
  }

  async onModuleInit(): Promise<void> {
    if (this.postgres.isConfigured()) {
      await this.initializeSchema();
    }
  }

  async initializeSchema(): Promise<void> {
    await this.postgres.withTransaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('lab_inventory_concurrency_schema'))`,
      );
      await client.query(`CREATE SCHEMA IF NOT EXISTS lab_inventory_concurrency`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS lab_inventory_concurrency.inventory (
          sku_id varchar(64) PRIMARY KEY,
          stock integer NOT NULL CHECK (stock >= 0),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS lab_inventory_concurrency.inventory_processed_event (
          event_id uuid PRIMARY KEY,
          sku_id varchar(64) NOT NULL,
          processed_at timestamptz NOT NULL DEFAULT now()
        )
      `);
    });
  }

  isConfigured(): boolean {
    return this.postgres.isConfigured();
  }

  async reset(skuId: string, stock: number): Promise<void> {
    await this.postgres.withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO lab_inventory_concurrency.inventory (sku_id, stock, updated_at)
          VALUES ($1, $2, now())
          ON CONFLICT (sku_id)
          DO UPDATE SET stock = EXCLUDED.stock, updated_at = now()
        `,
        [skuId, stock],
      );
      await client.query(
        `DELETE FROM lab_inventory_concurrency.inventory_processed_event WHERE sku_id = $1`,
        [skuId],
      );
    });
  }

  async findStock(skuId: string): Promise<number | null> {
    const queryRecord = await this.postgres.query<StockRow>(
      `SELECT stock FROM lab_inventory_concurrency.inventory WHERE sku_id = $1`,
      [skuId],
    );
    return queryRecord.rows[0]?.stock ?? null;
  }

  async writeStockWithoutLock(skuId: string, stock: number): Promise<void> {
    await this.postgres.query(
      `
        UPDATE lab_inventory_concurrency.inventory
        SET stock = $1, updated_at = now()
        WHERE sku_id = $2
      `,
      [stock, skuId],
    );
  }

  async decreaseAtomically(skuId: string, quantity: number): Promise<AtomicDecreaseRecord> {
    let transactionStartedAt = 0;
    let queryDurationMs = 0;
    const remainingStock = await this.postgres.withTransaction(async (client) => {
      transactionStartedAt = performance.now();
      await this.applyTransactionTimeouts(client);
      const queryStartedAt = performance.now();
      const updateRecord = await client.query<StockRow>(
        `
          UPDATE lab_inventory_concurrency.inventory
          SET stock = stock - $1, updated_at = now()
          WHERE sku_id = $2 AND stock >= $1
          RETURNING stock
        `,
        [quantity, skuId],
      );
      queryDurationMs = performance.now() - queryStartedAt;
      return updateRecord.rows[0]?.stock ?? null;
    });

    return {
      queryDurationMs,
      remainingStock,
      transactionDurationMs: performance.now() - transactionStartedAt,
    };
  }

  async persistInventoryEvent(event: InventoryEvent): Promise<ConsumerPersistenceRecord> {
    let transactionStartedAt = 0;
    const persistenceRecord = await this.postgres.withTransaction(async (client) => {
      transactionStartedAt = performance.now();
      await this.applyTransactionTimeouts(client);
      const processedEvent = await client.query<{ event_id: string }>(
        `
          INSERT INTO lab_inventory_concurrency.inventory_processed_event (event_id, sku_id)
          VALUES ($1, $2)
          ON CONFLICT (event_id) DO NOTHING
          RETURNING event_id
        `,
        [event.eventId, event.skuId],
      );

      if (processedEvent.rowCount === 0) {
        return { duplicate: true, remainingStock: null };
      }

      const updateRecord = await client.query<StockRow>(
        `
          UPDATE lab_inventory_concurrency.inventory
          SET stock = stock - $1, updated_at = now()
          WHERE sku_id = $2 AND stock >= $1
          RETURNING stock
        `,
        [event.quantity, event.skuId],
      );
      if (updateRecord.rowCount !== 1) {
        throw new Error(`Cannot persist inventory event for SKU ${event.skuId}`);
      }

      return { duplicate: false, remainingStock: updateRecord.rows[0]?.stock ?? null };
    });

    return {
      ...persistenceRecord,
      transactionDurationMs: performance.now() - transactionStartedAt,
    };
  }

  getPoolSnapshot(): { idle: number; total: number; waiting: number } | null {
    return this.postgres.getPoolSnapshot();
  }

  private async applyTransactionTimeouts(client: PoolClient): Promise<void> {
    await client.query(`SELECT set_config('lock_timeout', $1, true)`, [
      `${this.config.postgresLockTimeoutMs}ms`,
    ]);
    await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
      `${this.config.postgresStatementTimeoutMs}ms`,
    ]);
  }
}
