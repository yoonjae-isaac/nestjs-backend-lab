export const cacheStampedeLabConfig = {
  name: 'cache-stampede',
  objective: '동시 캐시 만료가 원본 저장소에 만드는 부하와 완화 전략을 같은 조건에서 비교한다.',
  origin: 'PostgreSQL',
  cache: 'Redis',
  instances: 3,
  strategies: [
    {
      name: 'BASELINE',
      behavior: '고정 TTL 만료 뒤 모든 요청이 원본을 조회하는 비교 기준',
    },
    {
      name: 'TTL_JITTER',
      behavior: '키별 TTL을 무작위로 분산해 여러 키의 동시 만료를 줄임',
    },
    {
      name: 'REFRESH_AHEAD',
      behavior: '인기 키를 미리 채우고 만료 임박 hit가 분산 lock으로 백그라운드 갱신',
    },
    {
      name: 'STALE_WHILE_REVALIDATE',
      behavior: 'fresh TTL 뒤 stale 값을 즉시 응답하고 한 요청만 백그라운드 갱신',
    },
    {
      name: 'SINGLE_FLIGHT',
      behavior: 'miss 시 동일 키의 원본 조회를 분산 lock으로 하나로 병합',
    },
  ],
} as const;
