# Saga Pattern Lab

## 목적

한 비즈니스 흐름이 여러 서비스에 걸칠 때 로컬 DB transaction만으로는 전체 원자성을 만들 수 없다.
이 Lab은 같은 주문 흐름을 Choreography와 Orchestration으로 각각 실행해 다음 차이를 관찰한다.

- 누가 다음 단계와 보상 순서를 결정하는가
- 진행 상태와 실패 지점을 어디에서 확인하는가
- 서비스가 추가될 때 이벤트 의존성과 중앙 상태 머신이 어떻게 변하는가
- Kafka 중복 전달과 보상 실패가 Saga에 어떤 영향을 주는가

Order, Inventory, Payment, Shipping의 비즈니스 동작은 성공 또는 실패만 반환한다. 실제 재고 수량,
PG, 배송 API는 구현하지 않는다.

## 가설

- Choreography는 중앙 제어점 없이 서비스 자율성이 높지만 전체 흐름이 여러 consumer에 분산된다.
- Orchestration은 흐름과 보상 순서를 한 상태 머신에서 읽을 수 있지만 Orchestrator 운영 책임이
  추가된다.
- 보상은 rollback이 아니라 별도 transaction이므로 보상 자체도 실패할 수 있다.

특정 방식이 항상 우월하다고 가정하지 않는다. 아래 시나리오의 timeline과 로그를 같은 조건에서
비교한다.

## 실행 Architecture

하나의 repository와 Docker image를 사용하지만 process와 consumer group은 서비스별로 분리한다.

```text
Client -> nginx:8089 -> HTTP Gateway + Timeline Recorder
                              |
                              +-> PostgreSQL
                              `-> Kafka

Kafka <-> Order process
Kafka <-> Inventory process
Kafka <-> Payment process
Kafka <-> Shipping process
Kafka <-> Orchestrator process
```

도메인 process는 Choreography event consumer와 Orchestration command consumer를 함께 가지지만,
각 process는 `SAGA_SERVICE_ROLE`로 자신의 topic만 구독한다. 서비스 간 HTTP 호출은 없다.

### Choreography

```text
Order
  |
  v
Kafka
  |
  v
Inventory -> Kafka -> Payment -> Kafka -> Shipping -> Kafka -> Order
```

각 서비스가 받은 이벤트의 의미를 해석하고 다음 이벤트 또는 보상 이벤트를 자율적으로 발행한다.
`SagaTimelineRecorder`는 모든 이벤트를 읽어 관찰용 projection만 만들며 흐름을 제어하지 않는다.

### Orchestration

```text
                  +----------------+
                  |  Orchestrator  |
                  +-------+--------+
                          |
              +-----------+-----------+
              v           v           v
          Inventory    Payment     Shipping
              ^           ^           ^
              +-----------+-----------+
                          |
                         Kafka
```

Orchestrator가 현재 Saga 상태를 영속화하고 다음 command와 역방향 보상 command를 결정한다. 각
도메인 서비스는 받은 command를 실행하고 result event만 반환한다.

## Infrastructure

| 구성          | 기본 주소                | 역할                           |
| ------------- | ------------------------ | ------------------------------ |
| HTTP Gateway  | `http://localhost:8089`  | Saga 시작·조회·초기화          |
| PostgreSQL 16 | `localhost:25432`        | 상태·timeline·멱등 처리·outbox |
| Kafka 4.2     | `localhost:29092`        | 서비스 간 event/command/result |
| Kafka UI      | `http://localhost:28080` | topic과 consumer group 관찰    |

```bash
pnpm lab:config saga-pattern
pnpm lab:up saga-pattern
pnpm lab:logs saga-pattern
pnpm lab:down saga-pattern
```

## Kafka 계약

모든 메시지는 `sagaId`를 key로 사용한다. 동일 topic의 같은 partition 안에서는 순서가 보장되지만
서로 다른 topic 사이의 전역 순서는 보장되지 않는다. Timeline은 메시지의 `sequence`와 DB insert
순서를 함께 사용한다.

모든 event와 command에 다음 추적 metadata가 포함된다.

```json
{
  "eventId": "uuid",
  "sagaId": "uuid",
  "orderId": "uuid",
  "correlationId": "sagaId",
  "causationId": "previous-eventId",
  "sequence": 3,
  "occurredAt": "2026-08-14T00:00:00.000Z"
}
```

### Choreography event topics

```text
lab.saga.choreography.order.events
lab.saga.choreography.inventory.events
lab.saga.choreography.payment.events
lab.saga.choreography.shipping.events
```

### Orchestration command topics

```text
lab.saga.orchestration.order.commands
lab.saga.orchestration.inventory.commands
lab.saga.orchestration.payment.commands
lab.saga.orchestration.shipping.commands
```

### Orchestration result topics

```text
lab.saga.orchestration.order.results
lab.saga.orchestration.inventory.results
lab.saga.orchestration.payment.results
lab.saga.orchestration.shipping.results
```

## 상태와 전달 안정성

PostgreSQL namespace는 `lab_saga_pattern`이다.

```text
saga_instance      Orchestrator 상태와 Choreography 관찰 projection
saga_timeline      event/command/result 순서
processed_message  consumer별 eventId 처리 이력
saga_outbox         상태 전이와 원자적으로 저장한 발행 대기 메시지
```

consumer는 처리 이력, 상태 변경, 다음 outbox 메시지를 한 DB transaction으로 저장한다. Outbox
relay는 lease로 한 메시지를 점유해 Kafka 발행을 재시도한다. Kafka 발행 성공 직후 DB 확인 전에
process가 죽으면 같은 메시지가 재발행될 수 있으므로 downstream은 `eventId`로 중복 처리를 막는다.
이는 at-least-once 전달에서 중복 가능성을 제거하는 것이 아니라 안전하게 흡수하는 구조다.

## API

### Lab 설정

```http
GET /labs/saga-pattern
```

### Choreography 시작

```bash
curl -s -X POST http://localhost:8089/labs/saga-pattern/choreography/orders \
  -H 'Content-Type: application/json' \
  -d '{"failAt":"NONE","compensationFailAt":"NONE"}'
```

### Orchestration 시작

```bash
curl -s -X POST http://localhost:8089/labs/saga-pattern/orchestration/orders \
  -H 'Content-Type: application/json' \
  -d '{"failAt":"SHIPPING","compensationFailAt":"NONE"}'
```

응답은 비동기 실행 시작만 보장한다.

```json
{
  "sagaId": "uuid",
  "orderId": "uuid",
  "strategy": "ORCHESTRATION",
  "status": "STARTED"
}
```

### Saga 상태와 Timeline

```bash
curl -s http://localhost:8089/labs/saga-pattern/sagas/{sagaId}
curl -s http://localhost:8089/labs/saga-pattern/sagas/{sagaId}/timeline
```

Timeline entry는 event뿐 아니라 Orchestration command도 포함한다.

```json
{
  "step": 4,
  "kind": "COMMAND",
  "service": "ORCHESTRATOR",
  "targetService": "PAYMENT",
  "action": "APPROVE_PAYMENT",
  "occurredAt": "2026-08-14T00:00:00.000Z"
}
```

### 초기화

진행 중 메시지가 모두 처리된 뒤 실행한다.

```bash
curl -s -X POST http://localhost:8089/labs/saga-pattern/reset
```

새 실행은 항상 새로운 `sagaId`를 사용하므로 Kafka topic을 삭제하지 않는다.

## Failure Injection

`failAt`과 `compensationFailAt`은 다음 값을 받는다.

```text
NONE | INVENTORY | PAYMENT | SHIPPING
```

현재 forward flow 뒤에는 Shipping을 취소해야 하는 후속 단계가 없으므로 compensation failure의
실질적인 관찰 지점은 `PAYMENT`와 `INVENTORY`다.

## 필수 Scenario

### 성공

Choreography:

```text
ORDER_CREATED
-> INVENTORY_RESERVED
-> PAYMENT_APPROVED
-> SHIPPING_CREATED
-> ORDER_COMPLETED
```

Orchestration:

```text
ORDER_CREATED
-> RESERVE_INVENTORY -> INVENTORY_RESERVED
-> APPROVE_PAYMENT -> PAYMENT_APPROVED
-> CREATE_SHIPPING -> SHIPPING_CREATED
-> COMPLETE_ORDER -> ORDER_COMPLETED
```

최종 상태는 모두 `COMPLETED`다.

### Inventory 실패

```text
ORDER_CREATED
-> INVENTORY_RESERVATION_FAILED
-> ORDER_CANCELLED
```

Orchestration은 `RESERVE_INVENTORY` 실패를 확인한 뒤 `CANCEL_ORDER`를 명시적으로 발행한다.

### Payment 실패

```text
INVENTORY_RESERVED
-> PAYMENT_FAILED
-> INVENTORY_RELEASED
-> ORDER_CANCELLED
```

Orchestration command의 보상 순서는 `RELEASE_INVENTORY -> CANCEL_ORDER`다.

### Shipping 실패

```text
PAYMENT_APPROVED
-> SHIPPING_FAILED
-> PAYMENT_CANCELLED
-> INVENTORY_RELEASED
-> ORDER_CANCELLED
```

Orchestration command의 보상 순서는
`CANCEL_PAYMENT -> RELEASE_INVENTORY -> CANCEL_ORDER`다.

### 보상 실패

```json
{
  "failAt": "SHIPPING",
  "compensationFailAt": "INVENTORY"
}
```

`INVENTORY_RELEASE_FAILED` 이후 자동 진행을 멈추고 최종 상태를 `COMPENSATION_FAILED`로 남긴다.
운영자가 재시도 또는 수동 복구 정책을 선택해야 하는 상태를 의도적으로 노출한다.

## Logging

Saga 처리 로그에는 다음 metadata를 남긴다.

```text
lab, strategy, sagaId, orderId, service, sourceService, eventType,
commandType, instanceId, timestamp, action, nextAction
```

Choreography에서는 여러 서비스 로그를 `sagaId`로 모아야 전체 흐름이 보인다. Orchestration에서는
Orchestrator 로그와 `saga_instance.current_step`에서 다음 결정 지점을 함께 확인할 수 있다.

## 비교

| 항목                  | Choreography          | Orchestration        |
| --------------------- | --------------------- | -------------------- |
| 중앙 Coordinator      | 없음                  | 있음                 |
| 흐름 제어 위치        | 여러 서비스           | Orchestrator         |
| 서비스 자율성         | 높음                  | 상대적으로 낮음      |
| 전체 흐름 파악        | 어려울 수 있음        | 상대적으로 쉬움      |
| Event 수              | 많아질 수 있음        | Command/Result 중심  |
| 서비스 간 이벤트 결합 | 높아질 수 있음        | Orchestrator로 집중  |
| 보상 순서             | 이벤트 흐름으로 구현  | Orchestrator가 명시  |
| Saga 상태 확인        | 분산됨                | 중앙 관리 가능       |
| Orchestrator 장애     | 해당 없음             | 고려 필요            |
| 복잡한 Workflow       | 관리 어려워질 수 있음 | 상대적으로 관리 쉬움 |

## 관찰 질문에 대한 코드 기준 답

1. Choreography 전체 흐름은 제어 상태가 아니라 Timeline Recorder와 `sagaId` 로그로 재구성한다.
2. 단계가 늘면 새 이벤트를 알아야 하는 upstream/downstream consumer가 함께 늘 수 있다.
3. Choreography 보상 순서는 실패 이벤트를 구독하는 각 서비스가, Orchestration 보상 순서는
   Orchestrator 상태 머신이 결정한다.
4. Orchestration 흐름은 한 switch에서 읽히지만 상태 전이, timeout, 복구 책임이 중앙에 집중된다.
5. Orchestrator는 single point of coordination이다. process 장애는 재시작으로 복구할 수 있지만
   장기 중단은 전체 진행을 멈춘다.
6. 영속 상태와 outbox는 재시작 후 유지된다. 다만 result 대기 timeout scheduler는 현재 없다.
7. Kafka 중복은 `processed_message`로 side effect를 멱등 처리한다. 보상 command도 같은 원칙이다.
8. 보상 실패는 `COMPENSATION_FAILED`로 멈추며 자동 무한 재시도를 하지 않는다.
9. 같은 topic/partition 밖의 순서는 보장되지 않는다. `sequence`, 예상 상태 검증, 멱등성이 필요하다.
10. 짧고 자율적인 흐름과 중앙 정책이 많은 복잡한 workflow는 서로 다른 trade-off를 가진다.

## 알려진 한계와 확장 지점

- Command 발행은 result 도착을 보장하지 않는다. timeout, retry 횟수, DLQ, 운영자 알림 정책이
  추가로 필요하다.
- 현재 mock domain에는 실제 로컬 상태 table이 없다. 실제 서비스에서는 domain 변경과 outbox를
  각 서비스의 로컬 DB transaction으로 묶어야 한다.
- Orchestrator는 예상하지 않은 지연·역순 result를 더 엄격한 state guard로 격리해야 한다.
- Timeline Recorder도 장애 시 늦게 따라잡을 수 있으며 제어 흐름의 source of truth가 아니다.
- 단일 Kafka broker 실험 환경이므로 broker 장애 내구성과 replication은 측정 대상이 아니다.

## 검증

자동 테스트는 Choreography와 Orchestration 각각의 성공, Inventory/Payment/Shipping 실패와
Orchestration 보상 실패를 production flow 함수로 연쇄 실행한다.

```bash
pnpm test
pnpm test:e2e
pnpm build
```

## 실제 결과

2026-08-14에 macOS Docker 환경에서 `node:24-alpine`, PostgreSQL 16, Kafka 4.2.0 단일 broker,
Gateway 1개, 도메인 worker 4개, Orchestrator 1개로 실행했다. `pnpm lab:saga:smoke`가 다음 10개
시나리오의 최종 상태와 전체 action 순서를 API timeline 기준으로 검증했다.

| 전략          | 시나리오                            | 최종 상태             | Timeline 메시지 수 |
| ------------- | ----------------------------------- | --------------------- | -----------------: |
| Choreography  | 성공                                | `COMPLETED`           |                  5 |
| Choreography  | Inventory 실패                      | `COMPENSATED`         |                  3 |
| Choreography  | Payment 실패                        | `COMPENSATED`         |                  5 |
| Choreography  | Shipping 실패                       | `COMPENSATED`         |                  7 |
| Choreography  | Shipping 실패 + Inventory 보상 실패 | `COMPENSATION_FAILED` |                  6 |
| Orchestration | 성공                                | `COMPLETED`           |                  9 |
| Orchestration | Inventory 실패                      | `COMPENSATED`         |                  5 |
| Orchestration | Payment 실패                        | `COMPENSATED`         |                  9 |
| Orchestration | Shipping 실패                       | `COMPENSATED`         |                 13 |
| Orchestration | Shipping 실패 + Inventory 보상 실패 | `COMPENSATION_FAILED` |                 11 |

총 Saga 10개, timeline 73개, consumer 처리 이력 68개가 저장되었고 검증 종료 시 미발행 outbox는
0개였다. Gateway와 다섯 worker는 모두 실행 상태였으며 `SAGA_CONSUMER_FAILED`,
`SAGA_OUTBOX_PUBLISH_FAILED`, warn/error 로그는 없었다. 이 수치는 단일 로컬 실행의 기능 검증값이며
성능 결론으로 사용하지 않는다.

## 결론과 Trade-off 기록

실험 후 다음 내용을 기록한다.

- 어떤 방식에서 실패 원인과 현재 위치를 더 빨리 찾았는가
- 새 단계를 추가할 때 실제로 수정된 consumer와 상태 전이는 어디였는가
- 보상 실패 복구를 어떤 주체가 소유하는 편이 명확했는가
- Orchestrator 운영 비용이 workflow 가시성 이득보다 컸는가
