import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';

import type { AppConfig } from '../../../common/config/configuration';
import { PostgresService } from '../../../common/database/postgres/postgres.service';
import {
  sagaMessageAction,
  sagaMessageService,
  type SagaMessage,
} from '../shared/saga-message.types';
import type {
  SagaDomainService,
  SagaFailurePoint,
  SagaInstance,
  SagaStateTransition,
  SagaStatus,
  SagaStep,
  SagaStrategy,
  SagaTimelineEntry,
} from '../shared/saga-status.types';

interface SagaRow {
  completed_steps: SagaDomainService[];
  compensation_fail_at: SagaFailurePoint;
  created_at: Date;
  current_step: SagaStep;
  fail_at: SagaFailurePoint;
  failed_step: SagaDomainService | null;
  order_id: string;
  saga_id: string;
  status: SagaStatus;
  strategy: SagaStrategy;
  updated_at: Date;
}

interface TimelineRow {
  action: string;
  kind: 'COMMAND' | 'EVENT';
  occurred_at: Date;
  sequence: number;
  service: SagaInstance['completedSteps'][number] | 'ORCHESTRATOR';
  target_service: SagaDomainService | null;
}

interface OutboxRow {
  message_id: string;
  message_key: string;
  payload: unknown;
  topic: string;
}

export interface SagaOutgoingMessage {
  message: SagaMessage;
  topic: string;
}

export interface SagaStartRecord {
  message: SagaMessage;
  topic: string;
}

@Injectable()
export class SagaRepository implements OnModuleInit {
  private readonly config: AppConfig['sagaPattern'];

  constructor(
    configService: ConfigService,
    private readonly postgres: PostgresService,
  ) {
    this.config = configService.getOrThrow<AppConfig['sagaPattern']>('app.sagaPattern');
  }

  async onModuleInit(): Promise<void> {
    if (this.config.enabled && this.postgres.isConfigured()) {
      await this.initializeSchema();
    }
  }

  isConfigured(): boolean {
    return this.config.enabled && this.postgres.isConfigured();
  }

  async createSaga(startRecord: SagaStartRecord): Promise<SagaInstance> {
    const { message } = startRecord;
    const createdAt = new Date();

    // Saga 시작 상태와 첫 메시지를 같은 트랜잭션에 저장해 시작 이벤트 유실을 막는다.
    await this.postgres.withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO lab_saga_pattern.saga_instance (
            saga_id,
            order_id,
            strategy,
            status,
            current_step,
            failed_step,
            fail_at,
            compensation_fail_at,
            completed_steps,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'STARTED', 'ORDER', NULL, $4, $5, '{}', $6, $6)
        `,
        [
          message.sagaId,
          message.orderId,
          message.strategy,
          message.failAt,
          message.compensationFailAt,
          createdAt,
        ],
      );
      await this.enqueueOutbox(client, startRecord);
    });

    return {
      completedSteps: [],
      compensationFailAt: message.compensationFailAt,
      createdAt: createdAt.toISOString(),
      currentStep: 'ORDER',
      failAt: message.failAt,
      failedStep: null,
      orderId: message.orderId,
      sagaId: message.sagaId,
      status: 'STARTED',
      strategy: message.strategy,
      updatedAt: createdAt.toISOString(),
    };
  }

  async persistHandledMessage(
    consumerName: string,
    incomingMessage: SagaMessage,
    outgoingMessage: SagaOutgoingMessage | null,
    transition: SagaStateTransition | null = null,
  ): Promise<boolean> {
    return this.postgres.withTransaction(async (client) => {
      // 처리 이력을 먼저 확보해 Kafka 재전달이 같은 상태 변경을 반복하지 않게 한다.
      const processedRecord = await client.query<{ message_id: string }>(
        `
          INSERT INTO lab_saga_pattern.processed_message (consumer_name, message_id, saga_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (consumer_name, message_id) DO NOTHING
          RETURNING message_id
        `,
        [consumerName, incomingMessage.eventId, incomingMessage.sagaId],
      );
      if (processedRecord.rowCount === 0) {
        return false;
      }

      if (transition) {
        await this.updateState(client, incomingMessage.sagaId, transition);
      }
      if (outgoingMessage) {
        // 처리 이력과 후속 메시지 outbox를 함께 커밋해 consumer crash 구간을 닫는다.
        await this.enqueueOutbox(client, outgoingMessage);
      }
      return true;
    });
  }

  async findSaga(sagaId: string): Promise<SagaInstance | null> {
    const queryRecord = await this.postgres.query<SagaRow>(
      `SELECT * FROM lab_saga_pattern.saga_instance WHERE saga_id = $1`,
      [sagaId],
    );
    const sagaRow = queryRecord.rows[0];
    return sagaRow ? this.toSagaInstance(sagaRow) : null;
  }

  async recordTimeline(message: SagaMessage): Promise<boolean> {
    const insertRecord = await this.postgres.query<{ message_id: string }>(
      `
        INSERT INTO lab_saga_pattern.saga_timeline (
          message_id,
          saga_id,
          sequence,
          kind,
          service,
          target_service,
          action,
          occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (message_id) DO NOTHING
        RETURNING message_id
      `,
      [
        message.eventId,
        message.sagaId,
        message.sequence,
        message.kind,
        sagaMessageService(message),
        message.kind === 'COMMAND' ? message.targetService : null,
        sagaMessageAction(message),
        message.occurredAt,
      ],
    );
    return insertRecord.rowCount === 1;
  }

  async updateSagaState(sagaId: string, transition: SagaStateTransition): Promise<void> {
    await this.postgres.withTransaction(async (client) => {
      await this.updateState(client, sagaId, transition);
    });
  }

  async getTimeline(sagaId: string): Promise<SagaTimelineEntry[]> {
    const queryRecord = await this.postgres.query<TimelineRow>(
      `
        SELECT sequence, kind, service, target_service, action, occurred_at
        FROM lab_saga_pattern.saga_timeline
        WHERE saga_id = $1
        ORDER BY sequence ASC, id ASC
      `,
      [sagaId],
    );

    return queryRecord.rows.map((timelineRow) => ({
      action: timelineRow.action,
      kind: timelineRow.kind,
      occurredAt: timelineRow.occurred_at.toISOString(),
      service: timelineRow.service,
      step: timelineRow.sequence,
      targetService: timelineRow.target_service,
    }));
  }

  async claimOutbox(owner: string, leaseMs: number): Promise<OutboxRow | null> {
    const claimRecord = await this.postgres.query<OutboxRow>(
      `
        WITH candidate AS (
          SELECT message_id
          FROM lab_saga_pattern.saga_outbox
          WHERE published_at IS NULL
            AND (locked_until IS NULL OR locked_until < now())
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE lab_saga_pattern.saga_outbox AS outbox
        SET locked_by = $1,
            locked_until = now() + ($2::integer * interval '1 millisecond'),
            attempts = attempts + 1
        FROM candidate
        WHERE outbox.message_id = candidate.message_id
        RETURNING outbox.message_id, outbox.topic, outbox.message_key, outbox.payload
      `,
      [owner, leaseMs],
    );
    return claimRecord.rows[0] ?? null;
  }

  async markOutboxPublished(messageId: string, owner: string): Promise<void> {
    await this.postgres.query(
      `
        UPDATE lab_saga_pattern.saga_outbox
        SET published_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL
        WHERE message_id = $1 AND locked_by = $2
      `,
      [messageId, owner],
    );
  }

  async releaseOutbox(messageId: string, owner: string, errorMessage: string): Promise<void> {
    await this.postgres.query(
      `
        UPDATE lab_saga_pattern.saga_outbox
        SET locked_by = NULL, locked_until = NULL, last_error = left($3, 2000)
        WHERE message_id = $1 AND locked_by = $2
      `,
      [messageId, owner, errorMessage],
    );
  }

  async reset(): Promise<void> {
    await this.postgres.withTransaction(async (client) => {
      await client.query(`DELETE FROM lab_saga_pattern.processed_message`);
      await client.query(`DELETE FROM lab_saga_pattern.saga_timeline`);
      await client.query(`DELETE FROM lab_saga_pattern.saga_outbox`);
      await client.query(`DELETE FROM lab_saga_pattern.saga_instance`);
    });
  }

  private async initializeSchema(): Promise<void> {
    await this.postgres.withTransaction(async (client) => {
      // 여러 독립 서비스가 동시에 시작해도 스키마 DDL은 한 번씩 순서대로 실행한다.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('lab_saga_pattern_schema'))`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS lab_saga_pattern`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS lab_saga_pattern.saga_instance (
          saga_id uuid PRIMARY KEY,
          order_id uuid NOT NULL,
          strategy varchar(32) NOT NULL,
          status varchar(32) NOT NULL,
          current_step varchar(32) NOT NULL,
          failed_step varchar(32),
          fail_at varchar(32) NOT NULL,
          compensation_fail_at varchar(32) NOT NULL,
          completed_steps text[] NOT NULL DEFAULT '{}',
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS lab_saga_pattern.saga_timeline (
          id bigserial PRIMARY KEY,
          message_id uuid NOT NULL UNIQUE,
          saga_id uuid NOT NULL,
          sequence integer NOT NULL,
          kind varchar(16) NOT NULL,
          service varchar(32) NOT NULL,
          target_service varchar(32),
          action varchar(64) NOT NULL,
          occurred_at timestamptz NOT NULL,
          recorded_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS saga_timeline_saga_sequence_idx
        ON lab_saga_pattern.saga_timeline (saga_id, sequence, id)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS lab_saga_pattern.processed_message (
          consumer_name varchar(128) NOT NULL,
          message_id uuid NOT NULL,
          saga_id uuid NOT NULL,
          processed_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (consumer_name, message_id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS lab_saga_pattern.saga_outbox (
          message_id uuid PRIMARY KEY,
          topic varchar(255) NOT NULL,
          message_key uuid NOT NULL,
          payload jsonb NOT NULL,
          attempts integer NOT NULL DEFAULT 0,
          locked_by varchar(255),
          locked_until timestamptz,
          last_error text,
          created_at timestamptz NOT NULL DEFAULT now(),
          published_at timestamptz
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS saga_outbox_pending_idx
        ON lab_saga_pattern.saga_outbox (created_at)
        WHERE published_at IS NULL
      `);
    });
  }

  private async enqueueOutbox(
    client: PoolClient,
    outgoingMessage: SagaOutgoingMessage,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO lab_saga_pattern.saga_outbox (message_id, topic, message_key, payload)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (message_id) DO NOTHING
      `,
      [
        outgoingMessage.message.eventId,
        outgoingMessage.topic,
        outgoingMessage.message.sagaId,
        JSON.stringify(outgoingMessage.message),
      ],
    );
  }

  private async updateState(
    client: PoolClient,
    sagaId: string,
    transition: SagaStateTransition,
  ): Promise<void> {
    await client.query(
      `
        UPDATE lab_saga_pattern.saga_instance
        SET status = $2,
            current_step = $3,
            failed_step = $4,
            completed_steps = $5,
            updated_at = now()
        WHERE saga_id = $1
      `,
      [
        sagaId,
        transition.status,
        transition.currentStep,
        transition.failedStep,
        transition.completedSteps,
      ],
    );
  }

  private toSagaInstance(sagaRow: SagaRow): SagaInstance {
    return {
      completedSteps: sagaRow.completed_steps,
      compensationFailAt: sagaRow.compensation_fail_at,
      createdAt: sagaRow.created_at.toISOString(),
      currentStep: sagaRow.current_step,
      failAt: sagaRow.fail_at,
      failedStep: sagaRow.failed_step,
      orderId: sagaRow.order_id,
      sagaId: sagaRow.saga_id,
      status: sagaRow.status,
      strategy: sagaRow.strategy,
      updatedAt: sagaRow.updated_at.toISOString(),
    };
  }
}
