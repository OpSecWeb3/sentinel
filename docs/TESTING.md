# Testing guide

This guide covers everything you need to run Sentinel's test suite, create the test database, write new tests, and understand the Continuous Integration (CI) test pipeline.

---

## Testing philosophy

Tests exist to catch bugs before production. Sentinel's test suite is organized around seven rules that emerged from a security audit. Each rule targets a class of bug that is structurally invisible to typical happy-path tests:

1. Every Zod schema touching SQL or an external call gets adversarial input tests.
2. Every Redis `GET` then `SET` pattern gets a `Promise.all` concurrency test.
3. Every `GET` endpoint gets a second-organization isolation test.
4. Every worker handler gets a direct unit test.
5. Any unbounded query gets a large-data timing test.
6. Every module branch gets explicit coverage.
7. Every periodic handler has a matching scheduler in worker startup.

See the "Writing new tests" section below for patterns that implement these rules.

---

## Prerequisites

### PostgreSQL

Integration tests require a PostgreSQL 16 instance with a database named `sentinel_test`. The default connection parameters are:

| Parameter | Value |
|-----------|-------|
| Host | `localhost` |
| Port | `5434` |
| User | `sentinel` |
| Password | `sentinel` |
| Database | `sentinel_test` |

The test suite applies migrations automatically, but it does **not** create the database itself. You must create it once on a fresh container.

### Redis

Integration tests require a Redis 7 instance. The default connection parameters are:

| Parameter | Value |
|-----------|-------|
| Host | `localhost` |
| Port | `6380` |
| Database index | `1` |

The test suite flushes the Redis database between tests and uses database index `1` to avoid interfering with the development instance on index `0`.

### Starting infrastructure

If you use the development Docker Compose file, PostgreSQL and Redis are already running on the correct ports:

```bash
docker compose -f docker-compose.dev.yml up -d postgres redis
```

---

## Creating the test database

The development Docker Compose creates the `sentinel` database but not `sentinel_test`. Create it once:

```bash
psql "postgresql://sentinel:sentinel@localhost:5434/postgres" -c "CREATE DATABASE sentinel_test OWNER sentinel;"
```

If you use the Docker-based test runner (`pnpm test:docker`), the CI service container handles this automatically.

> **Note:** You only need to run this command once per Docker volume. If you destroy and recreate the PostgreSQL volume, run it again.

---

## Test environment variables

The root `vitest.config.ts` provides sensible defaults for all test environment variables. You can override them by setting environment variables before running tests.

| Variable | Default (local) | Default (CI) | Purpose |
|----------|-----------------|--------------|---------|
| `DATABASE_URL` | `postgresql://sentinel:sentinel@localhost:5434/sentinel_test` | `postgresql://sentinel:sentinel@localhost:5432/sentinel_test` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6380/1` | `redis://localhost:6379/1` | Redis connection string |
| `SESSION_SECRET` | `test-session-secret-at-least-32-chars-long!!` | Same | Session signing key |
| `ENCRYPTION_KEY` | `0123456789abcdef...` (64 hex chars) | Same | AES-256-GCM encryption key |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Same | CORS (Cross-Origin Resource Sharing) allowlist |
| `SMTP_FROM` | `test@sentinel.dev` | Same | Email sender address |
| `SMTP_URL` | `smtp://localhost:1025` | Same | SMTP server for test emails |
| `DISABLE_RATE_LIMIT` | `true` | `true` | Disables rate limiting during tests |
| `NODE_ENV` | `test` | `test` | Runtime environment identifier |

> **Note:** Local tests default to port 5434 (PostgreSQL) and 6380 (Redis) to match the development Docker Compose. CI uses standard ports 5432 and 6379 from GitHub Actions service containers.

---

## Running tests

### All tests

```bash
pnpm test
```

This runs Vitest against all test files matching the patterns in the root `vitest.config.ts`:

- `packages/*/src/**/__tests__/**/*.test.ts`
- `modules/*/src/**/__tests__/**/*.test.ts`
- `apps/*/src/**/__tests__/**/*.test.ts`
- `test/**/*.test.ts`

### Unit tests only

```bash
pnpm test:unit
```

Runs tests in `packages/` and `modules/` directories. Unit tests cover pure functions (cryptography utilities, condition evaluation, environment variable validation) and do not require PostgreSQL or Redis.

### Integration tests only

```bash
pnpm test:integration
```

Runs tests in `apps/` and `test/` directories. Integration tests hit real PostgreSQL and Redis instances. They test the full middleware, validation, and SQL pipeline through Hono's `app.request()` -- no running HTTP server is needed.

### Watch mode

```bash
pnpm test:watch
```

Vitest re-runs affected tests on file changes.

### Running a specific test file

```bash
npx vitest run test/chunks/056-crypto.test.ts
```

### Running a subset by directory

```bash
npx vitest run test/chunks/
npx vitest run test/chunks/gap
npx vitest run test/scenarios/
```

### Docker-based test runner

Run the full suite inside Docker with infrastructure provisioned automatically:

```bash
pnpm test:docker
```

This starts PostgreSQL and Redis containers, applies migrations, and runs Vitest. The test service is defined in `docker-compose.dev.yml` under the `test` profile.

---

## Test layers

The test suite is organized into four layers, each targeting a different scope.

### Layer 1: Unit tests

- **Location:** `packages/*/src/__tests__/`, `modules/*/src/__tests__/`
- **Scope:** Pure functions -- cryptography, condition evaluation, environment variable parsing.
- **Infrastructure:** None. No database or Redis required.
- **Speed:** Under 1 second total.
- **Parallelism:** File-level parallelism enabled (`fileParallelism: true` in `packages/shared/vitest.config.ts`).

### Layer 2: Integration tests

- **Location:** `test/chunks/006-*.ts` through `test/chunks/145-*.ts`, `apps/api/src/**/__tests__/**/*.test.ts`
- **Scope:** HTTP-layer tests via Hono's `app.request()` -- no running server. Tests the full middleware, Zod validation, and SQL pipeline.
- **Infrastructure:** PostgreSQL (`sentinel_test` on port 5434) and Redis (port 6380).
- **Speed:** Approximately 15 seconds total.
- **Parallelism:** Sequential (`fileParallelism: false` in root config). Integration tests share a database and clean tables between suites.

### Layer 3: Scenario tests

- **Location:** `test/scenarios/*.e2e.test.ts`
- **Scope:** End-to-end business logic: event ingestion, rule engine evaluation, alert generation, notification dispatch.
- **Infrastructure:** PostgreSQL and Redis.
- **Speed:** Approximately 30 seconds total.

### Layer 4: Audit gap tests

- **Location:** `test/chunks/gap*.test.ts`
- **Scope:** Adversarial inputs, concurrency races, multi-organization isolation, performance assertions, worker handler edge cases, and worker wiring verification.
- **Infrastructure:** PostgreSQL and Redis.

---

## Vitest configuration

### Root configuration (`vitest.config.ts`)

The root configuration applies to all test files. Key settings:

| Setting | Value | Reason |
|---------|-------|--------|
| `pool` | `forks` | Process isolation between test files |
| `fileParallelism` | `false` | Integration tests share a database |
| `testTimeout` | 15,000 ms | Account for database round-trips |
| `hookTimeout` | 30,000 ms | Allow time for migration application in `beforeAll` |
| `coverage.provider` | `v8` | Native V8 coverage instrumentation |

### Package-level configuration (`packages/shared/vitest.config.ts`)

The shared package has its own configuration optimized for pure-logic tests:

| Setting | Value | Reason |
|---------|-------|--------|
| `fileParallelism` | `true` | No shared state between test files |
| `testTimeout` | 5,000 ms | Pure functions run fast |

### API-level configuration (`apps/api/vitest.config.ts`)

The API package configures a setup file that bootstraps the test database:

| Setting | Value | Reason |
|---------|-------|--------|
| `setupFiles` | `./src/__tests__/setup.ts` | Re-exports shared test helpers |
| `fileParallelism` | `false` | Tests share a database |
| `PORT` env | `0` | Let the OS pick an available port |

---

## Test infrastructure

### Global setup (`test/helpers/setup.ts`)

The shared setup file is loaded as a Vitest `setupFile`. It handles:

1. **Database reset:** Drops and recreates the `public` schema, then applies all Drizzle ORM migrations from `packages/db/migrations/`.
2. **Connection management:** Creates a shared `postgres.js` client (max 5 connections) and a Drizzle ORM instance.
3. **Redis connection:** Connects to the test Redis instance and flushes the database.
4. **Advisory locking:** Uses PostgreSQL advisory locks (`pg_advisory_lock`) to serialize schema reset across concurrent test processes.

### Lifecycle hooks

| Hook | Action |
|------|--------|
| `beforeAll` | Acquire advisory lock, drop/recreate schema, run migrations, connect Redis, flush Redis |
| `afterEach` | Flush Redis |
| `afterAll` | Flush Redis, disconnect Redis, close PostgreSQL connections, release advisory lock |

### Exported helpers

The setup file exports factory functions for creating test data:

| Helper | Purpose |
|--------|---------|
| `getTestDb()` | Return the shared Drizzle ORM instance |
| `getTestSql()` | Return the raw `postgres.js` tagged-template client |
| `getTestRedis()` | Return the shared Redis instance |
| `cleanTables()` | Truncate all tables (call in `beforeEach` when tests need a pristine slate) |
| `cleanSpecificTables()` | Truncate specific tables by name |
| `resetCounters()` | Reset auto-increment counters |
| `createTestUser()` | Insert a user with a hashed password |
| `createTestOrg()` | Insert an organization |
| `addMembership()` | Associate a user with an organization at a given role |
| `createTestUserWithOrg()` | Create a user and organization in one call |
| `createTestApiKey()` | Create an API key and return the raw key for authentication tests |
| `createTestDetection()` | Insert a detection rule |
| `createTestRule()` | Insert a rule under a detection |
| `createTestEvent()` | Insert a normalized event |
| `createTestNotificationChannel()` | Insert a notification channel |
| `createTestSession()` | Insert a session record directly in the database |
| `createTestArtifact()` | Insert a registry artifact |
| `createTestArtifactVersion()` | Insert a version for a registry artifact |
| `createTestGithubInstallation()` | Insert a GitHub App installation record |
| `createTestGithubRepo()` | Insert a GitHub repository record |
| `signWebhookPayload()` | Generate an HMAC signature for webhook payload testing |

### API test helpers (`apps/api/src/__tests__/helpers.ts`)

Higher-level helpers for testing API routes:

| Helper | Purpose |
|--------|---------|
| `setupAdmin()` | Register a user, log in, return the session cookie and organization ID |
| `registerViewer()` | Join an organization via invite secret |
| `appRequest()` | Send an authenticated JSON request with the CSRF header |
| `createApiKey()` | Create an API key through the API endpoint |

---

## Writing new tests

### File naming conventions

```text
test/chunks/{number}-{slug}.test.ts       # Chunk tests (006-150)
test/chunks/gap{N}-{slug}.test.ts         # Audit gap tests
test/scenarios/{name}.e2e.test.ts          # Scenario tests
packages/*/src/__tests__/{name}.test.ts    # Package unit tests
modules/*/src/__tests__/{name}.test.ts     # Module unit tests
```

### Standard test setup

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

let app: Hono<any>;
beforeAll(async () => { app = await getApp(); });
beforeEach(async () => { await cleanTables(); resetCounters(); });
```

### Pattern: adversarial input testing

Test every Zod schema that touches SQL or an external call with injection payloads:

```typescript
describe('rejects malicious input', () => {
  it.each([
    '}; DROP TABLE events; --',
    '../../../etc/passwd',
    "field' OR '1'='1",
    'payload-->>',
  ])('rejects SQL injection in field param: %s', async (field) => {
    const res = await appRequest(app, 'GET', '/api/events/payload-search', {
      cookie, query: { field, value: 'x' },
    });
    expect(res.status).toBe(400);
  });
});
```

### Pattern: multi-organization isolation

Test every `GET` endpoint with two organizations to verify data isolation:

```typescript
const userA = await createTestUser({ username: 'adminA' });
const orgA = await createTestOrg({ slug: 'org-a' });
await addMembership(orgA.id, userA.id, 'admin');
const sessA = await createTestSession(userA.id, orgA.id, 'admin');

// Repeat for org B -- completely separate admin and organization

it('org B cannot see org A alerts', async () => {
  await createAlert({ orgId: orgA.id });

  const res = await appRequest(app, 'GET', '/api/alerts', {
    cookie: orgB.cookie,
  });
  expect((await res.json()).data).toHaveLength(0);
});
```

### Pattern: concurrency testing

Test every Redis `GET` then `SET` pattern with `Promise.all`:

```typescript
it('does not create duplicate instances under concurrent load', async () => {
  const [r1, r2] = await Promise.all([
    engine1.evaluate(event),
    engine2.evaluate(event),
  ]);

  const keys = await redis.keys('sentinel:corr:seq:*');
  expect(keys).toHaveLength(1);
});
```

### Pattern: module branch coverage

Test every code path that branches by module ID:

```typescript
const modules = ['github', 'registry', 'chain', 'infra', 'aws'];

it.each(modules)('resolves templates for %s module', async (moduleId) => {
  const res = await appRequest(app, 'GET', '/api/detections/resolve-template', {
    cookie, query: { moduleId },
  });
  expect(res.status).toBeLessThan(500);
});
```

### Pattern: external API mocking

Do not use real API keys in tests. Mock at the fetch level:

```typescript
vi.spyOn(globalThis, 'fetch').mockResolvedValue(
  new Response(JSON.stringify({ ok: true }), { status: 200 })
);
```

### What not to test

- **Framework behavior:** Do not test that Hono returns 404 for unknown routes or that Zod rejects the wrong type. Test that your validation schema rejects your dangerous inputs.
- **Database constraints in isolation:** Trust PostgreSQL constraints. Test the application behavior when a constraint fires (e.g., `ON CONFLICT DO NOTHING` returns no rows).
- **Third-party library internals:** Do not test that argon2 hashes correctly. Test that the login flow rejects wrong passwords.
- **CSS and layout:** Frontend tests validate data contracts and routing, not visual rendering.

---

## Coverage thresholds

The root `vitest.config.ts` enforces minimum coverage thresholds:

| Metric | Minimum |
|--------|---------|
| Lines | 49% |
| Functions | 62% |
| Branches | 79% |
| Statements | 49% |

Coverage includes source files from:

- `packages/*/src/**/*.ts`
- `modules/*/src/**/*.ts`
- `apps/*/src/**/*.ts`

Coverage excludes:

- Test files (`*.test.ts`, `*.spec.ts`)
- `__tests__/` directories
- `dist/` and `node_modules/`
- `apps/web/src/**` (frontend, tested separately)
- Seed files (`packages/db/src/seed/**`)
- Select shared package barrel files (`packages/shared/src/index.ts`, `packages/shared/src/module.ts`, `packages/shared/src/rules.ts`, `packages/shared/src/hono-types.ts`)

---

## CI test pipeline

The CI workflow (`.github/workflows/ci.yml`) runs the test job on every pull request to `main`. The test job provisions PostgreSQL 16 and Redis 7 as GitHub Actions service containers.

### CI test steps

1. **Checkout:** Clone the repository.
2. **Setup:** Install pnpm 9.15.4 and Node.js 22.
3. **Install dependencies:** `pnpm install --frozen-lockfile`.
4. **Apply migrations:** `pnpm db:migrate` against the `sentinel_test` database.
5. **Unit tests:** `pnpm test:unit -- --coverage`.
6. **Integration tests:** `pnpm test:integration -- --coverage` with all required environment variables set.

### CI environment differences

CI uses standard PostgreSQL and Redis ports (5432 and 6379) instead of the development ports (5434 and 6380). The `vitest.config.ts` reads `DATABASE_URL` and `REDIS_URL` from the environment, falling back to local defaults only when the variables are unset.

### Migration sync check (separate job)

A separate `migrations` job verifies migration integrity:

1. Applies all migrations.
2. Runs a three-way sync check: SQL file count must equal Drizzle journal entries must equal applied database rows.
3. Runs `pnpm db:generate` and fails if uncommitted migration files are detected (schema drift).

---

## When to add a test

1. **Before fixing a bug.** Write the test that would have caught it, verify it fails, then fix. This is the only way to confirm the fix works and the class of bug is now covered.
2. **When adding a new route.** Copy the structure from the nearest chunk test. Add adversarial inputs and a second-organization isolation case.
3. **When adding a new worker handler.** Write direct handler tests with mock `Job` objects. Include allowlist and boundary testing.
4. **When touching Redis state management.** Add a `Promise.all` concurrency test.
5. **When adding a new module.** Add it to every `it.each(modules)` block in `gap6-module-route-branches.test.ts`. If the module has periodic handlers, `gap7-worker-wiring.test.ts` will fail automatically if you forget the scheduler.
