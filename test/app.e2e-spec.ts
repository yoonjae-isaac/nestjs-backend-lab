import type { Server } from 'node:http';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';

describe('application (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.INSTANCE_ID = 'e2e-1';
    const testingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = testingModule.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        whitelist: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the instance id from health', async () => {
    await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', instanceId: 'e2e-1' });
  });

  it('reports disabled infrastructure as not configured', async () => {
    await request(app.getHttpServer() as Server)
      .get('/health/infrastructure')
      .expect(200)
      .expect({
        postgres: 'not-configured',
        mysql: 'not-configured',
        redis: 'not-configured',
        kafka: 'not-configured',
      });
  });

  it('exposes the inventory concurrency lab config', async () => {
    await request(app.getHttpServer() as Server)
      .get('/labs/inventory-concurrency')
      .expect(200)
      .expect(({ body }: { body: { name?: string } }) => {
        expect(body.name).toBe('inventory-concurrency');
      });
  });

  it('exposes the Cache Stampede lab config', async () => {
    await request(app.getHttpServer() as Server)
      .get('/labs/cache-stampede')
      .expect(200)
      .expect(({ body }: { body: { name?: string } }) => {
        expect(body.name).toBe('cache-stampede');
      });
  });

  it('does not query cache data when its infrastructure is disabled', async () => {
    await request(app.getHttpServer() as Server)
      .get('/labs/cache-stampede/single-flight/products/product-1')
      .expect(503);
  });

  it('exposes the Saga Pattern lab config', async () => {
    await request(app.getHttpServer() as Server)
      .get('/labs/saga-pattern')
      .expect(200)
      .expect(({ body }: { body: { name?: string } }) => {
        expect(body.name).toBe('saga-pattern');
      });
  });

  it('does not start a Saga when its infrastructure is disabled', async () => {
    await request(app.getHttpServer() as Server)
      .post('/labs/saga-pattern/choreography/orders')
      .send({ failAt: 'NONE' })
      .expect(503);
  });

  it('rejects an invalid inventory order', async () => {
    await request(app.getHttpServer() as Server)
      .post('/labs/inventory-concurrency/db-atomic/orders')
      .send({ skuId: 'invalid sku id', quantity: 0 })
      .expect(400);
  });
});
