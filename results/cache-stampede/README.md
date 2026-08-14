# Cache Stampede Results

k6 실행 결과는 `results/cache-stampede/{strategy}/{timestamp}.json`에 기록한다. 결과에는 TTL,
원본 지연, app instance 수, PostgreSQL pool, 요청 수와 concurrency를 함께 남긴다.

자동 smoke 출력은 기능 불변식 검증값이므로 성능 benchmark 결과로 해석하지 않는다.

## 2026-08-14 Docker smoke

조건: NestJS 3 instances, concurrency 30, base TTL 1,200ms, jitter 500ms, stale window
2,000ms, refresh-ahead 500ms, artificial origin delay 150ms.

```json
{
  "baselineConcurrentOriginLoads": 30,
  "concurrency": 30,
  "instancesObserved": 3,
  "refreshAheadOriginLoadsIncludingPrewarm": 2,
  "singleFlightConcurrentOriginLoads": 1,
  "staleWhileRevalidateConcurrentOriginLoads": 1,
  "ttlJitterDistinctTtlsAcross10Keys": 10
}
```

검증 뒤 PostgreSQL 누적값은 Baseline 31(최초 warm 1 + 동시 miss 30), Refresh Ahead 2,
SWR 2(최초 warm 1 + background 1), Single Flight 2(최초 warm 1 + 만료 뒤 1)였다. Redis lock
key는 남지 않았다.
