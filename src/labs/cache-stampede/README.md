# Cache Stampede Lab

## 실험 목적

여러 애플리케이션 인스턴스가 같은 캐시 만료를 관찰했을 때 원본 저장소로 요청이 한꺼번에
몰리는 Cache Stampede를 재현하고 다음 전략을 동일한 PostgreSQL 원본, Redis 캐시, TTL, 원본
지연 조건에서 비교한다.

- `BASELINE`: 고정 TTL + 보호 없는 cache-aside
- `TTL_JITTER`: 키마다 TTL을 무작위로 분산
- `REFRESH_AHEAD`: 명시적 pre-warm + 만료 임박 hit의 백그라운드 갱신
- `STALE_WHILE_REVALIDATE`: stale 즉시 응답 + 한 요청의 백그라운드 갱신
- `SINGLE_FLIGHT`: 동일 키 miss의 원본 조회를 하나로 병합

## 문제와 가설

고정 TTL cache-aside에서는 같은 키를 기다리던 요청이 만료 직후 모두 miss를 보고 원본을
조회한다. 인기 키가 많고 TTL까지 정렬돼 있으면 원본 connection, CPU, downstream quota가 동시에
소진될 수 있다.

- BASELINE은 만료 직후 동시 요청 수만큼 원본 조회가 증가한다.
- TTL Jitter는 여러 키의 만료 시점을 흩지만, **같은 키**에 동시에 들어온 miss를 합치지는 않는다.
- Refresh Ahead는 꾸준히 읽히는 인기 키를 만료 전에 바꿔 expiration miss를 피한다.
- SWR은 stale 허용 시간만큼 가용성과 latency를 우선하고 한 번만 갱신한다.
- Single Flight는 정합성을 유지하지만 cold miss 요청들이 첫 원본 조회 시간만큼 기다린다.

가설은 benchmark 결과가 아니다. `metrics`와 k6 결과를 함께 확인한다.

## Architecture

```text
client
  ↓
nginx :8090
  ↓ round-robin
NestJS app x3
  ├── Redis 7           lab:cache-stampede:*
  └── PostgreSQL 16     lab_cache_stampede.*
        └── artificial origin delay
```

이 Lab은 Kafka/MySQL을 시작하지 않는다. Cache API만 가진 전용 gateway process를 3개 실행하므로
다른 Lab module의 초기화나 background worker가 실험에 섞이지 않는다.

PostgreSQL namespace:

```text
lab_cache_stampede.product
lab_cache_stampede.origin_load
```

`origin_load`는 3개 process 전체의 원본 조회 횟수를 합산한다. 증가 쿼리는 짧은 auto-commit으로
끝내 원본 지연 구간 자체를 직렬화하지 않는다.

Redis key:

```text
lab:cache-stampede:{strategy}:value:{productId}
lab:cache-stampede:{strategy}:lock:{productId}
```

전략마다 value와 lock namespace를 분리해 한 전략의 warm 상태가 다른 전략에 영향을 주지 않는다.

## 전략 구현

### Baseline

```text
GET cache → miss → origin load → SET PX fixed-TTL → response
```

의도적으로 lock과 request coalescing이 없다. 원본 지연 동안 도착한 요청은 모두 이미 miss를
관찰했으므로 각각 원본을 조회한다. Production 권장 구현이 아니라 비교 기준이다.

### TTL Jitter

각 write의 TTL은 아래 범위에서 독립적으로 선택한다.

```text
max(1ms, baseTTL - jitter) <= TTL <= baseTTL + jitter
```

예를 들어 10초 ± 2초면 여러 키가 8~12초 사이에 분산된다. 하나의 hot key가 만료된 직후 몰리는
요청에는 여전히 stampede가 생긴다. Jitter와 Single Flight/SWR은 대체재가 아니며 실무에서는
함께 적용할 수 있다.

### Refresh Ahead / Pre-warming

`POST /refresh-ahead/prewarm/:productId`가 배포 또는 캠페인 시작 전에 인기 키를 채운다. 이후 cache
hit에서 남은 fresh 시간이 `refreshAheadMs` 이하이면 현재 값은 바로 반환하고 백그라운드 갱신을
시작한다.

```text
cache hit near expiry → response immediately
                      └→ distributed lock → double-check → origin → cache replace
```

이 구현은 전체 상품을 주기적으로 읽는 scheduler가 아니라 **실제 요청으로 인기가 확인된 키**를
갱신하는 request-triggered refresh-ahead다. 읽히지 않는 키에 불필요한 원본 부하를 만들지 않는다.
완전한 무트래픽 구간에도 갱신이 필요하면 별도 scheduler/인기 키 registry가 필요하다.

### Stale-While-Revalidate

Redis hard TTL은 `baseTTL + staleWindow`이고 record 안의 `freshUntil`은 `baseTTL`이다.

```text
fresh hit → fresh response
stale hit → stale response immediately
          └→ one distributed lock owner revalidates in background
hard miss → Single Flight로 최초 값을 채움
```

stale 구간에서는 원본 장애가 응답 latency로 바로 전파되지 않는다. 대신 상품 version이 잠시
오래될 수 있으므로 가격 확정, 잔액, 권한처럼 stale을 허용할 수 없는 데이터에는 적용하지 않는다.

### Single Flight / Distributed Lock

miss 요청 중 Redis `SET NX PX`에 성공한 한 요청만 double-check 후 원본을 조회한다. 나머지는 짧은
간격으로 cache fill을 기다리며 `lockWaitMs`가 지나면 `503`을 반환한다. timeout 뒤 보호 없이
원본으로 우회하지 않으므로 장애 시 새 stampede를 만들지 않는다.

lock 해제는 owner token 비교 + delete Lua script로 수행한다. `lockTtlMs`는 예상 원본 최대 시간보다
길어야 한다. 이 Lab은 lease 연장을 구현하지 않았으므로 실제 원본 시간이 lock TTL을 넘을 수 있는
환경에서는 watchdog/fencing token 또는 검증된 분산 coordination 도구가 필요하다.

## 실행

```bash
pnpm install
pnpm lab:config cache-stampede
pnpm lab:up cache-stampede
```

기본 host port:

- API/nginx: `8090`
- PostgreSQL: `35432`
- Redis: `36379`

```bash
curl http://localhost:8090/health
curl http://localhost:8090/health/infrastructure
pnpm lab:logs cache-stampede
pnpm lab:down cache-stampede
```

## API

초기화:

```bash
curl -X POST http://localhost:8090/labs/cache-stampede/reset \
  -H 'Content-Type: application/json' \
  -d '{"productCount":10}'
```

전략별 읽기:

```bash
curl http://localhost:8090/labs/cache-stampede/baseline/products/product-1
curl http://localhost:8090/labs/cache-stampede/ttl-jitter/products/product-1
curl http://localhost:8090/labs/cache-stampede/refresh-ahead/products/product-1
curl http://localhost:8090/labs/cache-stampede/stale-while-revalidate/products/product-1
curl http://localhost:8090/labs/cache-stampede/single-flight/products/product-1
```

pre-warm과 원본 변경:

```bash
curl -X POST \
  http://localhost:8090/labs/cache-stampede/refresh-ahead/prewarm/product-1

curl -X PUT http://localhost:8090/labs/cache-stampede/origin/products/product-1 \
  -H 'Content-Type: application/json' \
  -d '{"name":"Updated Product","priceCents":20000}'
```

원본 변경 API는 캐시를 무효화하지 않는다. 응답의 `product.version`, `source`,
`refreshScheduled`로 오래된 값과 갱신 시점을 확인한다.

상태와 분산 metric:

```bash
curl http://localhost:8090/labs/cache-stampede/state/product-1
curl http://localhost:8090/labs/cache-stampede/metrics
```

`state`는 전략별 cached version, fresh 잔여 시간, Redis hard TTL을 반환한다. `metrics`는
strategy/product별 실제 원본 조회 횟수다. HTTP source counter와 latency는 k6 summary를 정본으로
사용해 실험 hot path에 별도 metric write를 추가하지 않는다.

## 자동 Smoke

Lab을 띄운 뒤 다음 명령은 3개 인스턴스 분산, Baseline stampede, TTL 분산, 만료 전 refresh,
SWR stale 응답/단일 갱신, Single Flight 병합을 순서대로 검증한다.

```bash
pnpm lab:cache-stampede:smoke
```

기본 조건은 concurrency 30, base TTL 1.2초, 원본 지연 150ms다. 이 검증은 기능 불변식 확인용이며
성능 benchmark가 아니다.

## k6 Load Test

같은 스크립트에 전략만 바꿔 requests/concurrency를 고정한다.

```bash
STRATEGY=baseline k6 run load-tests/cache-stampede/strategy.js
STRATEGY=ttl-jitter k6 run load-tests/cache-stampede/strategy.js
STRATEGY=refresh-ahead k6 run load-tests/cache-stampede/strategy.js
STRATEGY=stale-while-revalidate k6 run load-tests/cache-stampede/strategy.js
STRATEGY=single-flight k6 run load-tests/cache-stampede/strategy.js
```

조건 변경:

```bash
STRATEGY=single-flight REQUESTS=5000 CONCURRENCY=200 \
  k6 run load-tests/cache-stampede/strategy.js
```

TTL Jitter의 핵심은 여러 키의 만료 분산이므로 한 키 k6 결과만으로 효과를 결론 내리지 않는다.
자동 smoke가 10개 키의 실제 TTL 분산을 확인하며, 본 benchmark에서는 product pool을 확장해 시간대별
origin QPS를 함께 기록해야 한다.

## 장애 시나리오와 관찰 포인트

### Redis 중단

```bash
docker compose -p lab-cache-stampede stop redis
```

모든 전략은 Redis 오류를 성공처럼 숨기지 않고 실패한다. 무제한 DB fallback은 Redis 장애를 곧
DB 장애로 확대할 수 있으므로 구현하지 않았다. 운영에서는 circuit breaker, 제한된 bypass budget,
rate limit을 명시적으로 설계한다.

### PostgreSQL 중단

- fresh cache: 각 전략은 Redis 값으로 계속 응답할 수 있다.
- SWR stale 구간: stale 응답은 성공하고 background refresh error가 로그에 남는다.
- hard miss/Single Flight: lock owner가 실패하고 waiters는 제한 시간 뒤 실패한다.
- Refresh Ahead: 현재 hit는 성공하지만 background 교체는 다음 hit에서 재시도한다.

```bash
docker compose -p lab-cache-stampede stop postgres
```

### 느린 원본과 lock 만료

`CACHE_STAMPEDE_ORIGIN_DELAY_MS`를 늘려 `LOCK_TTL_MS`에 접근시키면 waiter latency와 timeout을
관찰할 수 있다. lock TTL보다 긴 원본 작업은 중복 owner를 허용할 수 있으므로 해당 설정은 안전한
운영 설정이 아니다.

## Configuration

```env
CACHE_STAMPEDE_BASE_TTL_MS=1200
CACHE_STAMPEDE_JITTER_MS=500
CACHE_STAMPEDE_REFRESH_AHEAD_MS=500
CACHE_STAMPEDE_STALE_MS=2000
CACHE_STAMPEDE_ORIGIN_DELAY_MS=150
CACHE_STAMPEDE_LOCK_TTL_MS=4000
CACHE_STAMPEDE_LOCK_WAIT_MS=4000
CACHE_STAMPEDE_LOCK_RETRY_MS=25
POSTGRES_POOL_MAX=20
```

실험 간에는 `reset`을 호출하고 in-flight background refresh가 끝난 뒤 시작한다. TTL, 원본 지연,
app instance 수, PostgreSQL pool, 요청 수와 concurrency를 결과와 함께 기록해야 비교가 유효하다.

## Trade-off 요약

| 전략          | 같은 키 원본 병합 | stale 허용            | 요청 대기             | 추가 운영 비용          |
| ------------- | ----------------- | --------------------- | --------------------- | ----------------------- |
| Baseline      | 없음              | 없음                  | 원본 시간             | 원본 폭주 위험          |
| TTL Jitter    | 없음              | 없음                  | 원본 시간             | TTL 분포 관리           |
| Refresh Ahead | background 1회    | 갱신 중 기존 fresh 값 | 없음                  | 인기 키/pre-warm 정책   |
| SWR           | background 1회    | 있음                  | stale hit는 없음      | 허용 window와 오류 관찰 |
| Single Flight | 1회               | 없음                  | cold miss waiter 대기 | lock TTL/waiter 정책    |

정답 하나가 모든 데이터에 맞지는 않는다. 상품 설명은 Jitter + SWR, 배포 직후 hot catalog는
pre-warm + Refresh Ahead, stale 불가 데이터는 Single Flight 같은 조합을 데이터 의미와 장애 예산에
맞춰 선택한다.
