# 백엔드 컨벤션 & 스택 (재사용 템플릿)

NestJS 모노레포의 스택·아키텍처·코딩 컨벤션을 **도메인 중립적으로** 정리한 문서입니다.
다른 종류의 백엔드 서비스를 만들 때 이 문서를 그대로 새 레포에 복사해 시작 규칙으로 사용합니다.
예시에 나오는 `<domain>` / `orders` / `users` 등은 자리표시자이며, 실제 도메인 이름으로 치환합니다.

> 원본과의 두 가지 사실 정정:
> - 데이터 스택은 **Prisma 가 아니라 MikroORM**(PostgreSQL) 입니다. (과거 Prisma → MikroORM 이관 완료)
> - 현재 배포 형태는 **단일 `api` 앱** 이며, 스케줄 잡은 별도 cron 앱이 아니라 `@nestjs/schedule` 로 **API 프로세스 내부에서 상주 실행**됩니다. (모노레포 구조라 필요 시 `apps/<name>` 추가 가능)

---

## 0. 이 레포의 불가침 규칙 (도메인 우선)

이 문서는 도메인 중립 템플릿이지만, **아래 네 규칙은 이 레포에서 컨벤션보다 우선한다.** 근거는
[VISION.md](./VISION.md) 와 기획 정본(`../prd/el-dorado/01-initial-build/`)이며, 어기면 금전 사고가 된다.

| # | 규칙 | 근거 |
|---|---|---|
| 1 | 금액·중량·비율에 부동소수(`double`·`float`)를 쓰지 않는다. 계산은 Decimal, 저장은 `numeric` | 10-calc-spec §1-1 · 11-data-model G1 |
| 2 | 가격 반영의 최소 단위는 **상품**이다. SKU 단위로 반영·롤백·관리 제외를 만들지 않는다 | PRD §6-6 · §10-1 |
| 3 | 역검증 전에 "완료"·"성공"을 표시하거나 집계하지 않는다. 요청 성공은 성공이 아니다 | PRD 제품 원칙 3 · 13-cafe24-spec §7 |
| 4 | 부분 실패 시 자동 원복하지 않는다. 전진 재시도 또는 상태 유지 후 승인형 복구만 | PRD §10-3 · 13-cafe24-spec §8-2 |

> 계산 정밀도 상한(`DECIMAL_PRECISION` · `MARGIN_RATE_MAX` 등)은 오차 증명의 전제다.
> 값을 바꾸면 10-calc-spec §1-4-2 를 다시 계산하고 DB CHECK 제약도 함께 고친다.

---

## 1. 기술 스택 (버전 기준선)

| 영역 | 선택 | 버전 |
| --- | --- | --- |
| 런타임 | Node.js | `>= 20` (`.nvmrc`: 24) |
| 언어 | TypeScript | `^5.7` — strict 전부 on, **CommonJS**(`module: nodenext`) |
| 프레임워크 | NestJS | `^11` (`@nestjs/common`·`core`·`platform-express`) |
| 설정 | `@nestjs/config` | `^4` — Joi 미사용, `process.env` 직접 매핑 |
| ORM | MikroORM | `^6` (`@mikro-orm/core`·`postgresql`·`migrations`·`nestjs`) |
| DB | PostgreSQL | 16 (로컬 `postgres:16-alpine`) |
| 캐시/락 | ioredis + Redis | ioredis `^5`, Redis 7 |
| 스케줄 | `@nestjs/schedule` | `^6` (in-process cron) |
| 이벤트 | `@nestjs/event-emitter` | `^3` (필요 시) |
| 로깅 | nestjs-pino + pino-http | `^4` / `^10` |
| 검증 | class-validator + class-transformer | `^0.14` / `^0.5` |
| 문서 | `@nestjs/swagger` | `^11` |
| 보안 | helmet + `@nestjs/throttler` | `^8` / `^6` |
| 헬스 | `@nestjs/terminus` | `^11` |
| AI (선택) | `@google/genai` 등 | 도메인 필요 시 client lib 으로 격리 |
| 패키지 매니저 | **pnpm** | 9 (lockfile v9) |
| 테스트 | Jest + ts-jest | `^30` / `^29` |
| 린트/포맷 | ESLint(flat) + typescript-eslint + Prettier | `^9` / `^8` / `^3.4` |
| 빌드 | `tsc` + `tsc-alias` | 전체 `apps`+`libs` 컴파일 후 `@app/*` 별칭 치환 |
| 배포 | Docker(멀티스테이지) + Railway | `node:24-alpine`, Nixpacks 아닌 Dockerfile |

---

## 2. 프로젝트 구조 — NestJS 모노레포

```
<service>-backend/
├── apps/
│   └── api/          HTTP 서버 (helmet / CORS / ValidationPipe / Swagger / pino / throttler)
│                     + @nestjs/schedule 로 스케줄 잡 상주 실행
└── libs/             공유 기능 라이브러리 (평탄 구조)
```

- 각 `apps/<name>/`은 독립 NestJS 애플리케이션. `nest-cli.json`의 `projects`에 등록.
- 스케줄 잡을 물리적으로 분리하고 싶으면 `apps/cron/` 을 추가하고 `ScheduleModule` 을 그쪽으로 옮긴다. 단일 앱이면 **replica 1개로 운영**(중복 발사 방지) — 다중 replica 는 `withLock` 분산 락 병행(§13).
- 빌드는 `nest build` 가 아니라 루트 `tsc -p tsconfig.build.json && tsc-alias` — `apps`+`libs` 를 한 번에 `dist/` 로 컴파일하고 `@app/*` 별칭을 치환. 산출물: `dist/apps/api/src/main.js`, 마이그레이션 러너 `dist/libs/database/migrate.js`.

---

## 3. libs/ 구조 — service 는 흐름만, 나머지는 관심사 서브폴더

**원칙 1: 새 lib 추가 시 설정 파일 0개 수정.**
**원칙 2: service 파일에는 비즈니스 흐름만. 타입·상수·순수로직·프롬프트는 관심사 서브폴더로 분리(가독성).**

### 표준 레이아웃

```
libs/<name>/
  <name>.module.ts              # NestJS 모듈 (providers / exports)
  <name>.service.ts             # 비즈니스 흐름만 — 오케스트레이션·캐시 호출·예외변환·매핑 조립
  <name>.repository.ts          # (선택) MikroORM 접근을 모으는 곳
  types/
    <name>.types.ts             # interface / type alias (public 계약 + 내부 타입)
  constants/
    <name>.constants.ts         # TTL·limit·threshold(정책값)·정적맵
    <데이터>.ts                 # 큰 정적 데이터는 별도 파일 (예: allowed-codes.ts)
  <도메인로직폴더>/             # (선택) this 없는 순수 로직·프롬프트
    <name>.<의미>.ts            # 예: pricing/discount.rules.ts, prompt/summary.prompt.ts
```

### 규칙

- **service = 흐름만.** 인터페이스·타입 alias → `types/`, TTL·상한·임계값·정적맵 → `constants/`, `this` 없는 순수 계산/프롬프트 빌더 → 도메인 의미 폴더로 뺀다. service 상단에 타입 선언·`const` 상수 블록을 두지 않는다.
- **폴더·파일 이름은 도메인 의미로.** `util`/`helper`/`data`/`manager` 등 모호 이름 금지(§21). 계산 묶음은 의미가 드러나는 폴더명으로.
- **서브폴더당 파일 1개로 통일** — `types/<name>.types.ts`, `constants/<name>.constants.ts`. import 경로가 예측 가능해진다(`from '@app/<name>/types/<name>.types'`). 정적 데이터가 크거나 성격이 다르면 그때만 파일 분리.
- **`index.ts` barrel 금지** (서브폴더 포함) — 사용처에서 파일을 직접 import.
- **외부 API client 는 `libs/clients/<name>/` 아래로 묶음** → §5.
- `tsconfig.lib.json` 없음. 루트 `tsconfig.json` paths 와일드카드로 처리: `"@app/*": ["libs/*"]` (하위 depth 흡수 — 서브폴더·그룹핑해도 설정 변경 불필요).
- `nest-cli.json` projects 에 lib 등록 안 함 (전체 `tsc` 빌드가 apps+libs 일괄 컴파일 + `tsc-alias`).
- 서브폴더 예외: 외부 client 묶음 `libs/clients/`, `libs/database/{entities,migrations}/`(MikroORM 관례).

---

## 4. libs/<name> = 기능만, controller 금지

| 영역 | 책임 |
| --- | --- |
| `libs/<name>/<name>.service.ts` | 비즈니스 흐름만 (타입·상수·순수로직은 서브폴더로 → §3). **HTTP controller 금지.** |
| `libs/<name>/{types,constants,...}/` | 타입·상수·정적데이터·순수로직 (§3 표준 레이아웃). |
| `apps/api/src/<name>/<name>.controller.ts` | HTTP controller (libs 의 service 를 주입받아 라우팅). 도메인별 서브폴더. |
| `libs/cron-work/<name>.cron-work.ts` | `@Cron` 잡 (libs 의 service 를 주입받아 "언제"만 담당) → §14. |

`apps/api/src/<name>/` 서브폴더 안에는 **`<name>.controller.ts` 하나만** 둡니다. controller 외 추가 파일(module/service)을 만들지 않음 — 도메인 기능은 항상 `libs/<name>` 에 있고, controller 는 그것을 import 해서 라우팅만 합니다.

---

## 5. 외부 API 호출은 별도 lib 모듈로 격리

각 외부 서비스마다 자체 `libs/clients/<name>` 모듈(`<Name>Client`). 도메인 lib 이 client lib 을 의존.

```
libs/clients/<vendor>/
  <vendor>.module.ts
  <vendor>.client.ts            # 인증·요청·응답 파싱·에러 → 도메인 예외 변환
  types/ constants/ (필요 시)
```

- 도메인 모듈은 `imports: [<Vendor>Module]` 로 client 를 주입받음.
- 이유: 각 API 는 인증/스펙/응답 형식이 다르므로 격리해야 도메인 로직이 깔끔.
- **YAGNI**: 외부 API 가 하나면 그 client 하나만. 멀티 provider 추상화(인터페이스·어댑터)는 두 번째가 실제 도입될 때.

---

## 6. "투박하게" 원칙

- **추상화 최소화** — Provider 패턴, Generic Repository, 인터페이스 어댑터는 실제 필요할 때 도입.
- **YAGNI** — 요청한 기능 외 추가 기능·"유연성"·"설정 가능성" 금지.
- **보일러플레이트 < 명확성** — 한 줄 정직한 코드 > 다섯 줄 추상 클래스.
- 새 기능은 가장 단순한 구현부터. 복잡도는 요구사항이 검증된 뒤 도입.
- "선임 엔지니어가 이것이 과하다고 할까?" → 그렇다면 단순화.

---

## 7. NestJS 모듈

- **모듈 경계 = 도메인 경계.** 한 lib = 한 모듈.
- 의존성 주입은 **생성자 주입**. `@Inject(TOKEN)` 은 Symbol DI 토큰을 쓸 때만.
- `@Global()` 은 인프라 기반 모듈만: `ConfigModule`, `LoggerModule`, `DatabaseModule`(MikroORM `forRoot` 가 EM 을 전역 등록), `RedisModule`.
- 도메인 모듈은 비-global. `imports` / `providers` / `exports` 만 선언.
- service 는 반드시 `exports` 에 넣어야 다른 모듈(controller·cron-work)에서 주입 가능.

```ts
// libs/<name>/<name>.module.ts
@Module({
  imports: [<Vendor>Module],        // 외부 client 의존 시
  providers: [<Name>Service],
  exports: [<Name>Service],
})
export class <Name>Module {}
```

---

## 8. Path alias

| 위치 | 매핑 |
| --- | --- |
| `tsconfig.json` paths | `"@app/*": ["libs/*"]` (단일 와일드카드) |
| `package.json` jest.moduleNameMapper | `"^@app/(.*)$": "<rootDir>/libs/$1"` |
| `apps/api/test/jest-e2e.json` moduleNameMapper | `"^@app/(.*)$": "<rootDir>/../../../libs/$1"` |

Import 예: `import { <Name>Service } from '@app/<name>/<name>.service'`.

---

## 9. 환경변수 (Joi 미사용)

- **검증 라이브러리 없음.** `libs/config/configuration.ts` 에서 `process.env` 직접 + 기본값. 타입 있는 `AppConfig` 로 매핑.
- 필수 키 누락은 **호출 시점**에 `ServiceUnavailableException`(예: 외부 API 키). 단 DB URL 같은 부팅 필수 의존성은 부트스트랩에서 즉시 실패(§10).
- 조회는 `configService.get<AppConfig['x']>('app.x')`.
- `.env.example` 항상 최신 유지. 로드 순서 `['.env.local', '.env']`.

```ts
// libs/config/config.module.ts
@Global()
@Module({
  imports: [NestConfigModule.forRoot({
    isGlobal: true, cache: true, load: [configuration],
    envFilePath: ['.env.local', '.env'],
  })],
  exports: [NestConfigModule],
})
export class ConfigModule {}
```

```ts
// libs/config/configuration.ts (골격)
export type NodeEnv = 'development' | 'test' | 'production';
export interface AppConfig {
  env: NodeEnv;
  port: number;
  logLevel: string;
  corsOrigin: string;
  swagger: { enabled: boolean; path: string };
  database: { url: string };
  redis: { url: string; password?: string };
  // <vendor>: { apiKey?: string; ... }
}
const toBool = (v: string | undefined, fb: boolean) =>
  v === undefined ? fb : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

export const configuration = (): { app: AppConfig } => {
  const env = (process.env.NODE_ENV as NodeEnv) ?? 'development';
  return { app: {
    env,
    port: parseInt(process.env.PORT ?? '3000', 10),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    // prod 기본은 deny('') — 미설정 시 와일드카드 노출 방지. dev 는 '*'.
    corsOrigin: process.env.CORS_ORIGIN ?? (env === 'production' ? '' : '*'),
    swagger: {
      enabled: toBool(process.env.SWAGGER_ENABLED, env !== 'production'), // prod 기본 off
      path: process.env.SWAGGER_PATH ?? 'api/docs',
    },
    database: { url: process.env.DATABASE_URL ?? '' },
    redis: { url: process.env.REDIS_URL ?? 'redis://localhost:6379',
             password: process.env.REDIS_PASSWORD || undefined },
  }};
};
```

---

## 10. 부트스트랩 (`apps/api/src/main.ts` 표준)

`NestFactory.create<NestExpressApplication>` 로 생성하고 다음을 **항상** 적용:

- `bufferLogs: true` → `app.useLogger(app.get(Logger))` (nestjs-pino).
- `app.set('trust proxy', 1)` — 프록시(Railway) 뒤에서 실제 클라이언트 IP(레이트리밋).
- **부팅 필수 의존성 즉시 검증** — prod 에서 `DATABASE_URL` 없으면 모호한 드라이버 에러 대신 명확히 throw.
- `app.use(helmet())`.
- `enableCors` — `'*'`→모두 허용, `''`→차단(prod 기본), 그 외 CSV 허용 목록, `credentials: true`.
- 글로벌 `ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: true } })`.
- 글로벌 `ClassSerializerInterceptor`.
- `app.enableShutdownHooks()`.
- 프로세스 레벨 핸들러: `uncaughtException` → 로깅 후 정리·종료(재시작 위임), `unhandledRejection` → 로깅만(가동 유지).
- Swagger 는 `appConfig.swagger.enabled` 일 때만 `DocumentBuilder().addBearerAuth()`.
- 부트스트랩 실패는 `console.error` 후 `process.exit(1)` (재시작 트리거).

응답 envelope·예외 필터는 글로벌 provider(§15)로 등록되므로 main.ts 에서 수동 부착하지 않는다.

---

## 11. 데이터 — PostgreSQL via MikroORM

- 설정 정본: `libs/database/mikro-orm.config.ts` — 런타임 `MikroOrmModule.forRoot` + CLI(`migration:*`) 공용.
  - `ReflectMetadataProvider` + `UnderscoreNamingStrategy`.
  - **엔티티는 명시 배열로 등록**(번들/탐색 환경 모두 안전 — glob 탐색 금지).
  - 마이그레이션 경로는 `join(__dirname, 'migrations')` — 실행 cwd 무관(상대경로면 엉뚱한 위치에 빈 폴더 생성).
  - SSL: `PGSSL=true` 또는 URL 에 `sslmode=require` 면 `{ rejectUnauthorized: false }`(자체서명). 내부 네트워크면 off.
  - CLI 컨텍스트엔 `@nestjs/config` 가 없어 `.env` 미로드 → `process.env.DATABASE_URL` 없을 때만 `process.loadEnvFile()`(Node 20.12+ 내장).
- `DatabaseModule` 은 `MikroOrmModule.forRoot(config)` 하나만 import — EM 이 전역 등록되고 요청별 fork(Identity Map 격리) 자동.
- 마이그레이션: `pnpm migration:create`(엔티티↔스냅샷 diff) → prettier → `pnpm migration:up`. 프로덕션은 배포 pre-deploy 로 `node dist/libs/database/migrate.js` 1회.

```ts
// libs/database/mikro-orm.config.ts (골격)
export default defineConfig({
  clientUrl: process.env.DATABASE_URL,
  driverOptions: { connection: { ssl: useSsl ? { rejectUnauthorized: false } : false,
                                 connectionTimeoutMillis: 10_000 } },
  entities: [/* 명시 배열 */],
  metadataProvider: ReflectMetadataProvider,
  namingStrategy: UnderscoreNamingStrategy,
  extensions: [Migrator],
  migrations: { path: join(__dirname, 'migrations'),
                pathTs: join(__dirname, 'migrations'), emit: 'ts' },
});
```

---

## 12. 엔티티 / 테이블 컨벤션

**네이밍**
- 파일: `libs/database/entities/<단수-kebab>.entity.ts` (예: `order-item.entity.ts`)
- 클래스: `<Pascal단수>Entity` (예: `OrderItemEntity`)
- 테이블: `@Entity({ tableName: '<snake_복수>' })` 명시 (예: `order_items`). 컬럼명은 UnderscoreNamingStrategy 가 snake_case 자동 변환.
- enum: `entities/enums.ts` 에 정의, **값은 UPPER**. `@Enum({ items })` → text + CHECK 제약 매핑(native enum 미사용 — 값 추가 유연, text-to-SQL 친화).

**컬럼**
- PK: `id` uuid + `defaultRaw: 'gen_random_uuid()'` (외부 미노출 내부 PK, 도메인 식별자는 별도).
- **모든 컬럼·`@Entity` 에 한국어 `comment` 필수** (DB IDE 가시성 — 마이그레이션이 `comment on ...` 자동 emit).
- 타입 명시 (ReflectMetadataProvider 는 추론 못 함): 긴 문자열/URL `type: 'text'`, 경계 있으면 `length: N`(varchar), 날짜 `type: 'date'`, 정수 `type: 'integer'`, 배열 `type: ArrayType`(text[], 검색 시 `@Index({ type: 'gin' })`), 페이로드 `type: 'json'`(jsonb), 시각은 timestamptz(기본).
- **금액·중량·비율에 `double`·`float` 금지.** `columnType: 'numeric(p,s)'` + TS `string` 으로 두고 Decimal 로 계산한다. 부동소수 오차가 곧 금액 오차이기 때문이며, 값 상한은 DTO 검증과 `@Check` 제약 **양쪽에** 넣는다.
- 공통 타임스탬프: `createdAt`·`updatedAt`(`defaultRaw: 'now()'`, updatedAt 은 `onUpdate: () => new Date()`). 도메인 적재/생성 시각은 `fetchedAt`/`generatedAt`.
- dedup/자연키에 `@Unique`, 조회 패턴에 `@Index`. nullable 유니크는 sentinel 값으로 회피(postgres NULL-distinct 방지).
- **도메인 간 FK 미사용**(느슨한 결합) — 도메인 경계를 넘는 참조는 uuid 컬럼만 둔다. 같은 애그리게이트 안(`Product`↔`Sku`, `SyncRun`↔`SyncJob`↔`SyncJobItem`)도 현재는 uuid 컬럼으로 두고 있으므로, 참조 무결성이 필요해지면 그 범위에서만 FK 를 도입한다. 파생/AI/해석 데이터는 사실 테이블과 **별도 테이블**로 분리.

---

## 13. 캐시 & 분산 락 — Redis via ioredis

- `libs/redis` — `RedisService` 가 얇은 pass-through.
- **캐시는 전부 best-effort**: Redis 장애 시 `get`→miss(null), `set`/`del`→skip 으로 degrade(호출부가 라이브 fetch 로 폴백). 부팅 시 ping 실패도 경고만.
- **분산 락 `withLock(key, ttlMs, fn)`** 은 예외를 **전파**(락 미획득 시 `null` 반환 → 호출부가 임계구역 skip). SET NX PX + 소유 토큰 Lua 해제. 멀티 replica·cron 중복 방지.
  - ⚠️ `ttlMs` 는 `fn` 최대 실행 시간보다 길게. 장시간 작업은 배치 축소 또는 락 갱신.
- **캐시 정책 단일 소스** `libs/config/cache-policy.ts` — Redis 키 빌더 + TTL(초)을 한 곳에 모음. 각 서비스는 이 값을 참조(키/TTL 변경은 여기서만), Redis 접근·판단 로직은 서비스에 둠.
- **캐시 키 컨벤션**: `{domain}:{type}:{식별자}` — 예: `orders:detail:{id}`, `report:daily:{date}`.

```ts
// libs/config/cache-policy.ts (골격)
const SECOND = 1, MINUTE = 60, HOUR = 3600, DAY = 86400;
export const CACHE = {
  orderDetail: { ttl: 5 * MINUTE, key: (id: string) => `orders:detail:${id}` },
  reportDaily: { ttl: 8 * DAY,   key: (date: string) => `report:daily:${date}` },
} as const;
```

---

## 14. 스케줄 잡 — in-process cron + 트리거 레이어

- `ScheduleModule.forRoot()` 를 `AppModule` 에서 등록.
- **스케줄 단일 소스** `libs/config/schedules.ts` — 이름·크론식·타임존·설명을 한 곳에 모음. 타임존 KST 통일. 각 잡의 `@Cron` 이 이 값을 참조(스케줄 변경은 여기서만).
- **트리거 레이어** `libs/cron-work/<name>.cron-work.ts` — `@Cron` 은 **"언제"만** 담당하고 실제 일은 도메인 service 에 위임. 한 소스 실패가 나머지를 막지 않도록 개별 try. EM 컨텍스트·로직은 service 가 보유.
- `libs/cron-work/cron-work.module.ts` 가 도메인 모듈들을 import + cron-work provider 등록.

```ts
// libs/config/schedules.ts (골격)
const KST = 'Asia/Seoul';
const dailyAt = (h: number, m = 0) => `${m} ${h} * * *`;
export const CRON = {
  reportDaily: { name: 'report-daily', expression: dailyAt(7), timeZone: KST, description: '일일 리포트 생성' },
} satisfies Record<string, { name: string; expression: string; timeZone: string; description: string }>;
```

```ts
// libs/cron-work/<name>.cron-work.ts (골격)
@Injectable()
export class ReportCronWork {
  private readonly logger = new Logger(ReportCronWork.name);
  constructor(private readonly report: ReportService) {}

  @Cron(CRON.reportDaily.expression, { name: CRON.reportDaily.name, timeZone: CRON.reportDaily.timeZone })
  async run(): Promise<void> {
    try { await this.report.generate(); }
    catch (err) { this.logger.warn(`report failed: ${String(err)}`); }
  }
}
```

> 단일 replica 가 아니면 잡 본문을 `redis.withLock(...)` 으로 감싸 중복 발사 방지.

---

## 15. API 응답 envelope + 에러 처리

모든 HTTP 응답은 `libs/api-response` 의 글로벌 `ResponseInterceptor`(`APP_INTERCEPTOR`) + `GlobalExceptionFilter`(`APP_FILTER`) 가 일관 envelope 으로 변환. `ApiResponseModule` 을 `AppModule` 에 import 하면 끝.

**성공 (2xx):**
```json
{ "data": <controller return>, "meta": { "timestamp": "...", "path": "/orders/123" } }
```

**에러 (4xx / 5xx):**
```json
{ "error": { "statusCode": 503, "code": "SERVICE_UNAVAILABLE", "message": "...",
             "details": null, "path": "/orders", "timestamp": "..." } }
```

`code` 는 HTTP status 기반 SCREAMING_SNAKE (`NOT_FOUND`·`BAD_GATEWAY`·`SERVICE_UNAVAILABLE`·`INTERNAL_SERVER_ERROR` 등).

**에러 처리 원칙**
- NestJS `HttpException` 계층 활용: 404 `NotFoundException`, 502 `BadGatewayException`(외부 API 비정상), 503 `ServiceUnavailableException`(키 누락·인프라 부재).
- 외부 API 호출은 **try-catch → 도메인 의미 있는 NestJS 예외로 변환**. 원인 보존(`(err as Error).message` / `cause`).
- uncaught Error 는 `GlobalExceptionFilter` 가 500 으로 변환 + pino `logger.error` 풀 스택·req 컨텍스트.
- ValidationPipe 의 배열 메시지는 `details` 로 보존, `message` 는 `"Validation failed"`.
- 도메인 에러 클래스(비즈니스 규칙 위반)는 HTTP 매핑 예외와 구분.

**Envelope opt-out** — raw 응답이 필요한 핸들러(예: terminus health)는 `@SkipResponseWrap()` 부착.

---

## 16. 로깅

- nestjs-pino (`libs/logger`, `forRootAsync` 로 ConfigService 주입) — production: 표준 JSON, development: `pino-pretty`(singleLine·colorize).
- `console.log` **금지**. 컨텍스트 있는 곳: `Logger` 주입 → `logger.log(payload, ContextName)`.
- `redact` 로 민감 필드 마스킹(`req.headers.authorization`·`cookie`, `req.body.password`·`token`).
- `autoLogging.ignore` 로 `/health`·`/favicon.ico` 는 액세스 로그 제외.

---

## 17. 헬스체크

- `libs/health` (`@nestjs/terminus`) — `MemoryHealthIndicator`(heap/rss 임계) 등.
- `GET /health` 노출(`@SkipResponseWrap()` 로 terminus 표준 `{status, info, error, details}` 보존).
- 컨테이너·오케스트레이터 헬스체크 경로로 사용(Dockerfile HEALTHCHECK, Railway `healthcheckPath`).

---

## 18. 레이트리밋 / 보안

- `@nestjs/throttler` — IP당 글로벌 레이트리밋(예: `{ ttl: 60_000, limit: 120 }`), `APP_GUARD` 로 `ThrottlerGuard` 등록. 비싼 엔드포인트는 `@Throttle` 로 강화.
  - 단일 replica 는 인메모리로 충분. 다중 replica 확장 시 Redis 스토리지로 교체.
- helmet 기본 적용. CORS 는 prod 기본 deny + CSV 허용 목록(§10).
- 관리자 전용 엔드포인트는 `ADMIN_TOKEN`(미설정 시 비활성/404) 같은 토큰 게이트.

---

## 19. 테스트

- **Jest** (`*.spec.ts` 단위, `*.e2e-spec.ts` e2e). e2e config: `apps/api/test/jest-e2e.json`, setupFiles 로 env 기본값 주입.
- 패턴: Arrange / Act / Assert. 외부 의존(HTTP·FS·time)은 mock, 비즈니스 로직은 실제 객체.
- 의미 없는 테스트 금지(`toBeDefined`, getter/setter 단순 위임).

---

## 20. TypeScript

- `tsconfig.json` strict 전부 on (`strict`, `strictNullChecks`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitAny`, `noFallthroughCasesInSwitch` 등).
- **모듈 시스템: CommonJS** (`module`·`moduleResolution: nodenext`, `sourceType: commonjs`). 내부 import 에 `.js` 확장자 불필요.
- `any` **금지** — `unknown` + 타입 가드 또는 명시적 타입. (ESLint 는 `no-explicit-any` off 지만 컨벤션상 금지.)
- public 함수는 명시적 반환 타입.
- **제어문 본문은 항상 `{}` 블록** — `if`/`else`/`while`/`for`/`do-while` 단일 문장이라도. `switch` case/default 안 `let`/`const` 는 `{}` 로. ESLint `curly: ['error', 'all']` + `no-case-declarations: 'error'` 로 자동 강제 (Apple `goto fail` 류 함정 차단, diff 깨끗).

```ts
// ❌ if (cached) return cached;
// ✅
if (cached) {
  return cached;
}
```

---

## 21. 네이밍

- 변수/함수 `camelCase` · 클래스/인터페이스/타입 `PascalCase` · 상수 `UPPER_SNAKE_CASE` · 파일 `kebab-case`(`order.service.ts`, `stripe.client.ts`).
- DI Token: Symbol — `export const REDIS_CLIENT = Symbol('REDIS_CLIENT')`.
- boolean 은 `is/has/should/can/will` 접두사.
- **금지 모호 이름**: `data`, `result`, `temp`, `helper`, `manager`, `util`, `process`, `info`, `item`.

---

## 22. 주석

- "왜(why)" 만. "무엇을(what)"은 코드가 말하게. 자명한 주석 금지.
- JSDoc 은 public API 의 비자명한 동작만.
- 한국어 주석 허용(도메인 맥락). 한 파일 내 언어 일관성 유지.

---

## 23. 린트 / 포맷

- **ESLint flat config**(`eslint.config.mjs`) — `recommendedTypeChecked` + `eslint-plugin-prettier` + `eslint-plugin-import`(`import/order`, external→internal 그룹·alphabetize).
  - 핵심 규칙: `curly: ['error','all']`, `no-case-declarations: 'error'`, `consistent-type-imports`(inline type import), `no-floating-promises: warn`.
- **Prettier**(`.prettierrc`): `singleQuote`, `trailingComma: all`, `printWidth: 100`, `tabWidth: 2`, `semi: true`, `arrowParens: always`, `endOfLine: lf`.
- 스크립트: `pnpm lint`(fix) / `pnpm lint:check` / `pnpm format` / `pnpm format:check`.

---

## 24. 패키지 관리

- **pnpm 전용.** `pnpm install`, `pnpm-lock.yaml`. npm/yarn 금지.
- Node.js `>= 20` (`.nvmrc`: 24).
- 의존성 추가: `pnpm add <pkg>` / `pnpm add -D <pkg>`.
- postinstall 훅 필요한 패키지는 `pnpm.onlyBuiltDependencies` 에 등록.

---

## 25. Docker / 배포

- `docker-compose.yml` = **로컬 데이터 서비스만**(postgres / redis). 앱은 로컬 Node 로 직접(`pnpm start:dev`). DB 는 UTC 운영(`-c timezone=UTC`), 헬스체크 포함. `pnpm infra:up`/`:down`/`:logs`/`:reset`.
- **Dockerfile 멀티스테이지**(`node:24-alpine`): builder 에서 `pnpm install --frozen-lockfile`(매니페스트만 먼저 복사해 레이어 캐시) → `pnpm build && pnpm prune --prod` → runner 는 `node_modules`·`dist`·`package.json` 만 복사, **비루트 `node` 유저**, `HEALTHCHECK` 로 `/health` wget. `CMD ["node", "dist/apps/api/src/main.js"]`.
- **Railway**(`railway.json`): `DOCKERFILE` 빌더, `numReplicas: 1`(스케줄 잡 중복 방지), `healthcheckPath: /health`, `restartPolicyType: ON_FAILURE`, **`preDeployCommand: node dist/libs/database/migrate.js`**(배포 시 마이그레이션 1회).

---

## 26. 금지 사항

- `console.log` (→ `Logger` 주입) · `any` 타입 · TODO/FIXME 주석(지금 해결하거나 외부 추적).
- 사용 안 하는 import/변수/함수(ESLint 차단).
- 이모지(코드/주석/문서 — 사용자 명시 README/주석 예외).
- 자동 생성된 듯한 장황한 주석.
- `apps/<name>/src/modules/<name>/` 패턴으로 도메인 모듈 만들기 — 도메인 모듈은 `libs/<name>/` 로.
- libs 안에 HTTP controller 추가하기.
- `apps/api/src/<name>/` 서브폴더에 `<name>.module.ts`/`<name>.service.ts` 만들기 — controller 만.
- 도메인 간 FK · MikroORM glob 엔티티 탐색 · `index.ts` barrel.

---

## 27. 새 lib 추가 절차 (체크리스트)

1. `mkdir libs/<name>` — **외부 API client 면 `mkdir libs/clients/<name>`**.
2. `<name>.module.ts` 작성 (`providers`, `exports`).
3. 기능 파일 추가 — service 에는 흐름만. 타입 `types/<name>.types.ts`, 상수·정적맵 `constants/<name>.constants.ts`, 순수 로직은 도메인 폴더로 분리(§3).
4. 사용하는 앱/모듈의 `imports: [<Name>Module]` 한 줄 추가.
5. HTTP 노출이 필요하면 `apps/api/src/<name>/<name>.controller.ts` 생성(도메인 서브폴더 + controller 한 파일) + `AppModule` controllers 에 등록.
6. 스케줄이 필요하면 `libs/config/schedules.ts` 에 항목 추가 + `libs/cron-work/<name>.cron-work.ts`.
7. 캐시가 필요하면 `libs/config/cache-policy.ts` 에 키·TTL 추가.

> 설정 파일(tsconfig / nest-cli / jest mapper) 수정 **0건**.

---

## 28. 새 서비스 부트스트랩 순서 (from scratch)

1. `pnpm init` → Node/pnpm 고정(`.nvmrc`, `engines`, `packageManager`).
2. NestJS 모노레포 스캐폴드: `apps/api`, `nest-cli.json`(monorepo), 루트 `tsconfig.json`(§8 alias) + `tsconfig.build.json`.
3. 인프라 lib 복사·이식: `libs/config`, `libs/logger`, `libs/database`, `libs/redis`, `libs/api-response`, `libs/health`.
4. `AppModule` 조립: `ConfigModule`, `LoggerModule`, `DatabaseModule`, `RedisModule`, `ScheduleModule.forRoot()`, `ThrottlerModule.forRoot(...)`, `ApiResponseModule`, `HealthModule` + 도메인 모듈.
5. `main.ts` 표준 부트스트랩(§10).
6. `docker-compose.yml`(postgres/redis) + `.env.example` + `Dockerfile` + `railway.json`(§25).
7. 첫 도메인 lib 을 §27 체크리스트로 추가.
8. `pnpm migration:create` → `migration:up` 으로 스키마 시작.
