# nestjs-backend-lab

`nestjs-backend-lab`은 백엔드 문제를 직접 재현하고, 여러 해결 방식을 동일 조건에서 측정하며,
장애 상황까지 비교하기 위한 NestJS 기반 Backend Engineering Lab이다. 현재 단계는 실험 기능이
아닌 반복 가능한 실행 기반과 첫 Lab skeleton만 제공한다.

## Architecture

```text
client -> nginx:8088 -> NestJS app x3
                           |-- PostgreSQL
                           |-- MySQL (선택)
                           |-- Redis
                           `-- Kafka (KRaft) -> Kafbat UI:8080
```

공통 모듈은 연결, ping, graceful shutdown, raw query 또는 최소 publish 기능까지만 담당한다. 락,
retry, DLQ, idempotency, Outbox 같은 실험 정책은 각 Lab 안에 구현한다. 모든 연결은
`*_ENABLED` 환경변수가 `true`일 때만 열린다.

## Directory Structure

```text
src/
├── common/
│   ├── config/
│   ├── database/{postgres,mysql}/
│   ├── health/
│   ├── kafka/
│   ├── logger/
│   └── redis/
└── labs/inventory-concurrency/
infra/
├── shared/
└── labs/inventory-concurrency/
load-tests/inventory-concurrency/
results/inventory-concurrency/
scripts/
test/
```

## Environment Setup

요구사항은 Node.js 20 이상, pnpm 10, Docker와 Docker Compose다. 권장 Node.js 버전은 `.nvmrc`의
24다.

```bash
cp .env.example .env
pnpm install
pnpm build
pnpm test
pnpm test:e2e
```

기본 `.env.example`에서는 모든 외부 인프라가 비활성화되므로 NestJS만 실행할 수 있다.

## NestJS 실행과 Health API

```bash
pnpm start:dev
curl http://localhost:3000/health
curl http://localhost:3000/health/infrastructure
```

첫 응답에는 `status`와 `instanceId`가 포함된다. 두 번째 응답은 PostgreSQL, MySQL, Redis,
Kafka를 `up`, `down`, `not-configured` 중 하나로 표시한다. `INSTANCE_ID`가 없으면 OS hostname을
사용하며 Docker에서는 각 container hostname이 고유 instance id가 된다.

## Infrastructure 독립 실행

각 명령은 별도 Compose project를 사용하므로 필요한 것만 독립적으로 실행할 수 있다.

```bash
pnpm infra:postgres   # localhost:5432, lab/lab, backend_lab
pnpm infra:mysql      # localhost:3306, lab/lab, backend_lab
pnpm infra:redis      # localhost:6379
pnpm infra:kafka      # localhost:9092
pnpm infra:kafka-ui   # Kafka + http://localhost:8080
```

애플리케이션 연결을 확인하려면 해당 서비스 실행 후 `.env`의 `*_ENABLED=true`와 URL을 설정하고
`/health/infrastructure`를 조회한다. 예를 들어 PostgreSQL은 `POSTGRES_ENABLED=true`, Kafka는
`KAFKA_ENABLED=true`로 설정한다.

종료 예시는 다음과 같다.

```bash
docker compose -p backend-lab-postgres -f infra/shared/postgres.yml down
docker compose -p backend-lab-mysql -f infra/shared/mysql.yml down
docker compose -p backend-lab-redis -f infra/shared/redis.yml down
docker compose -p backend-lab-kafka -f infra/shared/kafka.yml -f infra/shared/kafka-ui.yml down
```

## Kafka Topic과 Consumer Group 확인

Kafka topic 자동 생성은 기본적으로 꺼져 있다. 다음 명령은 Lab namespace를 지킨 테스트 topic을
생성하고 조회한다. 공식 image의 CLI 경로는 `/opt/kafka/bin`이다.

```bash
docker compose -p backend-lab-kafka -f infra/shared/kafka.yml exec kafka \
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 \
  --create --if-not-exists --topic lab.inventory-concurrency.stock.changed \
  --partitions 3 --replication-factor 1

docker compose -p backend-lab-kafka -f infra/shared/kafka.yml exec kafka \
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:29092 --list

docker compose -p backend-lab-kafka -f infra/shared/kafka.yml exec kafka \
  /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:29092 --list
```

Consumer lag는 consumer가 생성된 뒤 다음처럼 확인한다.

```bash
docker compose -p backend-lab-kafka -f infra/shared/kafka.yml exec kafka \
  /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:29092 \
  --describe --group backend-lab.inventory-concurrency.inventory-writer
```

## Lab별 실행과 Multi Instance

첫 Lab은 PostgreSQL, Redis, Kafka, 선택형 Kafka UI, app 3개, nginx만 실행한다. MySQL은 포함하지
않는다. 독립 실행 인프라와 충돌하지 않도록 Lab의 host port는 PostgreSQL 15432, Redis 16379,
Kafka 19092, Kafka UI 18080이며 container 내부 연결은 기본 port를 유지한다.

```bash
pnpm lab:config inventory-concurrency
pnpm lab:up inventory-concurrency
```

분산 여부는 여러 번 호출해 서로 다른 `instanceId`가 반환되는지 확인한다.

```bash
for i in 1 2 3 4 5 6; do curl -s http://localhost:8088/health; echo; done
curl -s http://localhost:8088/health/infrastructure
pnpm lab:logs inventory-concurrency
pnpm lab:down inventory-concurrency
```

## Load Test

k6로 NAIVE, DB_ATOMIC, REDIS_KAFKA를 같은 requests/concurrency 조건에서 실행한다. 측정하지 않은
수치는 저장하지 않는다.

```bash
k6 run load-tests/inventory-concurrency/naive.js
k6 run load-tests/inventory-concurrency/db-atomic.js
k6 run load-tests/inventory-concurrency/redis-kafka.js
```

향후 실험 결과의 원시 JSON 또는 CSV는 `results/{lab-name}`에 저장한다.

## 새로운 Lab 추가

1. `src/labs/{lab-name}`에 module, `lab.config.ts`, README와 실제 필요한 파일만 추가한다.
2. `AppModule`에 Lab module을 import한다.
3. `infra/labs/{lab-name}/compose.yml`을 만들고 `scripts/lab-compose.mjs`에 필요한 shared compose만
   매핑한다.
4. HTTP 부하가 필요할 때만 `load-tests/{lab-name}`을 추가한다.
5. 실행 조건과 failure scenario를 고정하고 실제 결과만 `results/{lab-name}`에 기록한다.

Lab README에는 목적, 문제, 가설, infrastructure, 구현, 실행, 시나리오, 지표, 예상 현상, 실제
결과, 관찰 포인트, 결론, trade-off와 재현 환경을 남긴다. 세부 작업 규칙은 `AGENTS.md`를 따른다.

## Inventory Concurrency 현재 상태

현재 `NAIVE`, PostgreSQL `DB_ATOMIC`, `REDIS_KAFKA` 전략과 reset/state/metrics API가 구현돼 있다.
optimistic/pessimistic lock, Redis distributed-lock 감소, Outbox 및 실제 benchmark 결과는 아직
추가하지 않았다. 세부 실험 방법과 알려진 dual-write 문제는 Lab README를 따른다.
