export const inventoryConcurrencyLabConfig = {
  name: 'inventory-concurrency',
  infrastructure: {
    appInstances: 3,
    postgres: true,
    mysql: false,
    redis: true,
    kafka: true,
  },
} as const;
