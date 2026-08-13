import { hostname } from 'node:os';

export type InfrastructureStatus = 'up' | 'down' | 'not-configured';

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  instanceId: string;
  kafka: {
    autoCreateTopics: boolean;
    brokers: string[];
    clientId: string;
    consumerGroupPrefix: string;
    enabled: boolean;
  };
  logLevel: string;
  inventoryConcurrency: {
    consumerDelayMs: number;
    initLockRetryMs: number;
    initLockTtlMs: number;
    initLockWaitMs: number;
    naiveDelayMs: number;
    postgresLockTimeoutMs: number;
    postgresStatementTimeoutMs: number;
  };
  mysql: {
    enabled: boolean;
    poolMax: number;
    url: string;
  };
  port: number;
  postgres: {
    enabled: boolean;
    poolMax: number;
    url: string;
  };
  redis: {
    enabled: boolean;
    url: string;
  };
}

const toBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const toNonNegativeInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const toPositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = toNonNegativeInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
};

export const configuration = (): { app: AppConfig } => ({
  app: {
    env: (process.env.NODE_ENV as AppConfig['env'] | undefined) ?? 'development',
    instanceId: process.env.INSTANCE_ID ?? hostname(),
    kafka: {
      autoCreateTopics: toBoolean(process.env.KAFKA_AUTO_CREATE_TOPICS, false),
      brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092')
        .split(',')
        .map((broker) => broker.trim())
        .filter(Boolean),
      clientId: process.env.KAFKA_CLIENT_ID ?? 'backend-lab',
      consumerGroupPrefix: process.env.KAFKA_CONSUMER_GROUP_PREFIX ?? 'backend-lab',
      enabled: toBoolean(process.env.KAFKA_ENABLED, false),
    },
    inventoryConcurrency: {
      consumerDelayMs: toNonNegativeInteger(process.env.INVENTORY_CONSUMER_DELAY_MS, 0),
      initLockRetryMs: toPositiveInteger(process.env.INVENTORY_INIT_LOCK_RETRY_MS, 25),
      initLockTtlMs: toPositiveInteger(process.env.INVENTORY_INIT_LOCK_TTL_MS, 3_000),
      initLockWaitMs: toPositiveInteger(process.env.INVENTORY_INIT_LOCK_WAIT_MS, 3_000),
      naiveDelayMs: toNonNegativeInteger(process.env.INVENTORY_NAIVE_DELAY_MS, 10),
      postgresLockTimeoutMs: toPositiveInteger(
        process.env.INVENTORY_POSTGRES_LOCK_TIMEOUT_MS,
        3_000,
      ),
      postgresStatementTimeoutMs: toPositiveInteger(
        process.env.INVENTORY_POSTGRES_STATEMENT_TIMEOUT_MS,
        5_000,
      ),
    },
    logLevel: process.env.LOG_LEVEL ?? 'info',
    mysql: {
      enabled: toBoolean(process.env.MYSQL_ENABLED, false),
      poolMax: toPositiveInteger(process.env.MYSQL_POOL_MAX, 10),
      url: process.env.MYSQL_URL ?? 'mysql://lab:lab@localhost:3306/backend_lab',
    },
    port: toPositiveInteger(process.env.PORT, 3000),
    postgres: {
      enabled: toBoolean(process.env.POSTGRES_ENABLED, false),
      poolMax: toPositiveInteger(process.env.POSTGRES_POOL_MAX, 10),
      url: process.env.POSTGRES_URL ?? 'postgresql://lab:lab@localhost:5432/backend_lab',
    },
    redis: {
      enabled: toBoolean(process.env.REDIS_ENABLED, false),
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },
  },
});
