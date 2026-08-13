# Inventory Concurrency Lab

## 실험 목적

쇼핑몰/OMS에서 동일 SKU에 주문이 몰릴 때 발생하는 lost update와 고경합을 재현하고 다음 세
전략의 정합성, 성능, 장애 영향 및 운영 복잡도를 동일 조건에서 비교한다.

- `NAIVE`: 의도적으로 잘못된 SELECT → application 계산 → UPDATE
- `DB_ATOMIC`: PostgreSQL atomic conditional update
- `REDIS_KAFKA`: Redis 실시간 재고 + Kafka 비동기 PostgreSQL 반영

실제 benchmark 전에는 어느 전략이 빠르거나 충분하다고 결론 내리지 않는다.

## 문제 상황

초기 재고가 100인 `SKU-001`에 여러 NestJS instance가 동시에 주문을 처리한다. 동시 update,
중복 요청, Kafka event 중복, Redis와 DB의 일시적 차이는 서로 다른 문제이므로 각각 관찰한다.

## 가설

- NAIVE는 여러 요청이 같은 stock을 읽어 success 수와 실제 감소량이 달라질 수 있다.
- DB_ATOMIC은 overselling을 막지만 동일 row 경합 시 connection wait와 tail latency가 증가할 수
  있다.
- REDIS_KAFKA는 HTTP hot path를 Redis로 옮기지만 DB 반영 지연과 dual-write 장애 지점을 만든다.

가설은 결과가 아니며 k6와 failure experiment로 검증해야 한다.

## Architecture

### NAIVE

```text
Request
  ↓
SELECT stock
  ↓
Application 비교와 artificial delay
  ↓
UPDATE stock = 계산값
```

lock이 없으므로 요청 A와 B가 같은 stock을 읽은 뒤 같은 값을 쓸 수 있다. 두 요청은 성공으로
응답하지만 감소 하나가 사라지는 lost update를 의도적으로 재현한다. Production에서 사용하면
안 된다.

### DB Atomic

```text
Request
  ↓
BEGIN
  ↓
UPDATE inventory
SET stock = stock - quantity
WHERE sku_id = ? AND stock >= quantity
RETURNING stock
  ↓
COMMIT
  ↓
Response
```

재고 확인과 감소가 한 SQL statement 안에서 일어난다. transaction에는 주문 조회, 결제, Kafka
publish 또는 다른 business logic을 넣지 않는다. PostgreSQL `lock_timeout`과
`statement_timeout`은 환경변수로 조정할 수 있다.

### Redis + Kafka

```text
Request
  ↓
Redis initialization (miss일 때만 lock + double-check + DB read)
  ↓
Redis Lua atomic decrease
  ↓
Kafka publish
  ↓
Response

Kafka topic
  ↓
Consumer group
  ↓
processed event INSERT + DB conditional UPDATE (한 transaction)
```

Redis 감소는 distributed lock + GET + SET이 아니라 하나의 Lua script로 비교와 `DECRBY`를
원자적으로 실행한다. 동일 SKU를 Kafka message key로 사용하므로 해당 SKU event는 같은
partition으로 전송된다.

## Infrastructure

- NestJS 3 instances
- PostgreSQL 16, pool 기본값 10 per instance
- Redis 7
- Apache Kafka 4.2.0 KRaft, topic partition 3
- consumer group `backend-lab.inventory-concurrency.db-writer`
- nginx load balancer
- Kafbat UI

PostgreSQL Lab namespace는 `lab_inventory_concurrency`다.

```text
lab_inventory_concurrency.inventory
lab_inventory_concurrency.inventory_processed_event
```

MySQL은 이번 버전에 구현하지 않았다. MySQL atomic update를 추가할 때 PostgreSQL 동작과 같다고
가정하거나 억지로 공통 repository로 묶지 않는다.

## Redis Key Lifecycle

실시간 재고 key는 다음과 같다.

```text
lab:inventory-concurrency:stock:{skuId}
```

이 값은 단순 cache가 아니라 REDIS_KAFKA 전략의 authoritative hot path이므로 TTL이 없다. Redis
재시작이나 data loss가 발생하면 DB가 lag 중일 수 있어 단순 DB reload만으로 안전하게 복구할 수
없다는 점이 운영 비용이다.

초기화 lock은 별도 key다.

```text
lab:inventory-concurrency:init-lock:{skuId}
```

이 lock은 재고 감소를 보호하지 않는다. cache miss 시 여러 instance가 동시에 DB를 읽는
initialization stampede만 막으며 짧은 TTL을 갖는다. lock 획득 후 Redis를 다시 확인하는
double-check를 수행한다.

## Kafka Event와 Idempotency

Topic:

```text
lab.inventory-concurrency.stock.changed
```

Event:

```json
{
  "eventId": "uuid",
  "eventType": "INVENTORY_DECREASED",
  "occurredAt": "ISO_DATE",
  "skuId": "SKU-001",
  "quantity": 1,
  "remainingStock": 99,
  "requestId": "request-id",
  "instanceId": "app-instance",
  "strategy": "REDIS_KAFKA"
}
```

Consumer는 processed-event INSERT와 DB 감소를 같은 transaction에서 수행한다. `event_id` PK와
`ON CONFLICT DO NOTHING`으로 같은 event가 재전달돼도 DB 재고는 한 번만 감소한다. 이것은
동시 update 해결책이 아니라 at-least-once delivery에서 발생하는 event duplication 해결책이다.

## 실행 방법

```bash
pnpm install
pnpm lab:up inventory-concurrency
```

기본 host port:

- API/load balancer: `8088`
- PostgreSQL: `15432`
- Redis: `16379`
- Kafka: `19092`
- Kafka UI: `18080`

```bash
curl http://localhost:8088/health
curl http://localhost:8088/health/infrastructure
open http://localhost:18080
```

종료:

```bash
pnpm lab:down inventory-concurrency
```

## API

초기화:

```bash
curl -X POST http://localhost:8088/labs/inventory-concurrency/reset \
  -H 'Content-Type: application/json' \
  -d '{"skuId":"SKU-001","stock":100}'
```

주문:

```bash
curl -X POST 'http://localhost:8088/labs/inventory-concurrency/naive/orders?delayMs=10' \
  -H 'Content-Type: application/json' \
  -d '{"skuId":"SKU-001","quantity":1}'

curl -X POST http://localhost:8088/labs/inventory-concurrency/db-atomic/orders \
  -H 'Content-Type: application/json' \
  -d '{"skuId":"SKU-001","quantity":1}'

curl -X POST http://localhost:8088/labs/inventory-concurrency/redis-kafka/orders \
  -H 'Content-Type: application/json' \
  -d '{"skuId":"SKU-001","quantity":1}'
```

상태와 process-local 보조 metric:

```bash
curl http://localhost:8088/labs/inventory-concurrency/state/SKU-001
curl http://localhost:8088/labs/inventory-concurrency/metrics
```

state의 `difference`는 `redisStock - postgresStock`이다. Kafka lag 중에는 음수가 될 수 있다.
metrics endpoint는 응답한 instance의 보조 관찰값과 현재 PostgreSQL pool snapshot이다. 다중
instance 전체의 request count와 latency 정본은 k6 summary를 사용한다. 보조 metric 자체가
실험 hot path에 Redis/DB write를 추가하지 않도록 process-local로 유지한다.

Reset은 해당 SKU의 PostgreSQL row, Redis stock/init-lock, processed event 및 요청을 처리한
instance의 보조 metric을 초기화한다. Kafka topic과 committed offset은 초기화하지 않는다. reset
직전의 in-flight event가 있으면 수렴을 기다린 후 다음 실험을 시작해야 한다.

## Configuration

```env
POSTGRES_POOL_MAX=10
INVENTORY_NAIVE_DELAY_MS=10
INVENTORY_INIT_LOCK_TTL_MS=3000
INVENTORY_INIT_LOCK_WAIT_MS=3000
INVENTORY_INIT_LOCK_RETRY_MS=25
INVENTORY_CONSUMER_DELAY_MS=0
INVENTORY_POSTGRES_LOCK_TIMEOUT_MS=3000
INVENTORY_POSTGRES_STATEMENT_TIMEOUT_MS=5000
```

`INVENTORY_CONSUMER_DELAY_MS`를 늘리면 의도적으로 consumer lag과 Redis↔DB 차이를 만들 수 있다.
pool 실험은 `POSTGRES_POOL_MAX`를 10, 20, 50 등으로 바꾸되 app instance 수와 머신 조건을 함께
기록한다.

## Load Test

기본값은 initial stock 100, requests 1,000, concurrency 100이다.

```bash
k6 run load-tests/inventory-concurrency/naive.js
k6 run load-tests/inventory-concurrency/db-atomic.js
k6 run load-tests/inventory-concurrency/redis-kafka.js
```

조건 변경:

```bash
REQUESTS=100 CONCURRENCY=100 INITIAL_STOCK=100 \
  k6 run load-tests/inventory-concurrency/db-atomic.js

REQUESTS=10000 CONCURRENCY=100 INITIAL_STOCK=100 \
  k6 run load-tests/inventory-concurrency/redis-kafka.js
```

k6의 `http_req_duration` average/p50/p95/p99, request rate와 custom success/out-of-stock/error
counter를 사용한다. raw summary는 자동으로 다음 위치에 저장된다.

```text
results/inventory-concurrency/naive/{timestamp}.json
results/inventory-concurrency/db-atomic/{timestamp}.json
results/inventory-concurrency/redis-kafka/{timestamp}.json
```

## 테스트 시나리오

| Scenario | Initial stock | Requests | Concurrency | 관찰점                                     |
| -------- | ------------: | -------: | ----------: | ------------------------------------------ |
| 1        |           100 |      100 |         100 | 정상 전략 success 100, final stock 0       |
| 2        |           100 |    1,000 |         100 | 정상 전략 success 100, out-of-stock 900    |
| 3        |           100 |   10,000 |   별도 기록 | 동일 SKU 고경합의 tail latency와 pool wait |

각 전략 전 reset하고 이전 REDIS_KAFKA event가 DB에 수렴했는지 state로 확인한다.

## 측정 지표

- 공통: total, success, out of stock, error, throughput, average, p50/p95/p99, final stock
- PostgreSQL: pool total/idle/waiting, query/transaction duration, lock/statement timeout
- Redis: miss, initialization lock 획득/대기, Lua duration
- Kafka: publish success/failure, consumer processed, duplicate event, consumer lag

Kafka consumer lag은 CLI 또는 Kafka UI에서 확인한다.

```bash
docker exec lab-inventory-concurrency-kafka-1 \
  /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:29092 \
  --describe --group backend-lab.inventory-concurrency.db-writer
```

DB lock wait와 상세 connection 상태는 실험 중 `pg_stat_activity`, `pg_locks`를 함께 수집한다.

## Logging

로그에는 `lab`, `strategy`, `instanceId`, `requestId`, `skuId`, `event`, `duration`을 포함한다.
Kafka consumer 로그에는 `topic`, `partition`, `offset`, `eventId`도 포함한다.

주요 event:

```text
NAIVE_START / NAIVE_SUCCESS
DB_ATOMIC_START / DB_ATOMIC_SUCCESS / DB_ATOMIC_OUT_OF_STOCK
REDIS_STOCK_MISS / REDIS_INIT_LOCK_ACQUIRED / REDIS_STOCK_INITIALIZED
REDIS_DECREASE_SUCCESS
KAFKA_EVENT_PUBLISHED / KAFKA_EVENT_RECEIVED
DB_ASYNC_UPDATE_SUCCESS / KAFKA_DUPLICATE_EVENT_SKIPPED
```

## Failure Scenario

### Kafka publish failure

Redis 감소와 Kafka publish는 원자적이지 않다. Redis 감소 후 publish가 실패하면 응답은 이를
정상 성공으로 숨기지 않고 다음 정보를 반환하며 로그와 metric을 남긴다.

```json
{
  "success": false,
  "strategy": "REDIS_KAFKA",
  "reason": "EVENT_PUBLISH_FAILED",
  "inventoryChanged": true,
  "remainingStock": 99
}
```

클라이언트가 이 응답을 단순 retry하면 재고가 다시 감소할 수 있다. 이 dual write/event loss
문제의 완전한 해결책(Outbox, reservation, reconciliation 등)은 이번 버전에 넣지 않았다.

### Redis failure

Redis가 authoritative hot path이므로 Redis data loss 시 lag 중인 DB 값으로 즉시 복원하는 것은
안전하지 않을 수 있다. Redis 장애 시 자동 DB fallback은 의도적으로 구현하지 않았다.

### Consumer failure

DB commit 후 offset commit 전에 consumer가 죽으면 event가 재전달될 수 있다. processed-event
transaction이 중복 DB 감소를 막는지 관찰한다.

## 실제 결과

아직 성능 수치를 기록하지 않았다. 실행 환경과 raw JSON 없이 수치를 문서에 추가하지 않는다.

| Strategy    | TPS | p95 | p99 | Overselling   | DB Load | Complexity |
| ----------- | --: | --: | --: | ------------- | ------- | ---------- |
| NAIVE       |   - |   - |   - | 실험으로 확인 | -       | Low        |
| DB_ATOMIC   |   - |   - |   - | 0 expected    | -       | Low        |
| REDIS_KAFKA |   - |   - |   - | 0 expected    | -       | High       |

## 재현 환경 기록

결과마다 app instance 수, Node.js/DB/Redis/Kafka version, DB pool, Kafka partition 수, consumer 수와
group, requests, concurrency, consumer delay, timeout, 테스트 머신 CPU/memory 및 주요 설정을 함께
기록한다.

## 결론과 핵심 비교 질문

실제 결과 전에는 결론을 내리지 않는다. 다음 질문에 수치와 장애 관찰로 답한다.

> DB Atomic Update가 충분히 빠르다면 굳이 Redis + Kafka라는 복잡한 architecture가 필요한가?

> 어느 수준의 contention에서 DB Atomic Update의 latency와 connection usage가 실제 문제가 되기
> 시작하는가?

> Redis + Kafka가 성능을 개선하더라도 Redis 장애, Kafka 장애, consumer lag, Redis↔DB
> consistency라는 추가 비용이 이를 정당화하는가?

## Trade-off

DB_ATOMIC은 경로와 복구 모델이 단순하지만 DB row contention과 pool pressure를 직접 받는다.
REDIS_KAFKA는 hot path를 분리하지만 authoritative state, event delivery, lag, reconciliation을
운영해야 한다. 어느 쪽이 적절한지는 예상이 아니라 동일 조건의 측정 결과로 결정한다.
