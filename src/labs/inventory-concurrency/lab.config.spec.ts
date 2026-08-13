import { inventoryConcurrencyLabConfig } from './lab.config';

describe('inventoryConcurrencyLabConfig', () => {
  it('uses only the infrastructure needed by the initial lab', () => {
    expect(inventoryConcurrencyLabConfig).toEqual({
      name: 'inventory-concurrency',
      infrastructure: {
        appInstances: 3,
        postgres: true,
        mysql: false,
        redis: true,
        kafka: true,
      },
    });
  });
});
