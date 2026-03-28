# Running Tests

## Test stack

Sentinel uses [Vitest](https://vitest.dev/) 3.x as its test runner throughout the monorepo. Integration tests run against a real PostgreSQL instance and a real Redis instance — there are no in-memory fakes for the database or cache. This approach catches SQL query regressions, Drizzle ORM edge cases, and BullMQ integration issues that mocks would miss.

The root `vitest.config.ts` file configures the test environment:

- **Environment:** Node.js (not jsdom).
- **Pool:** `forks` — each test file runs in a separate process to avoid state leakage between test suites.
- **File parallelism:** disabled — integration tests share the same database and Redis instance, so serial execution prevents data races.
- **Timeout:** 15 seconds per test, 30 seconds per hook (to accommodate database setup and migration time).

## Setting up the test database

Integration tests expect a PostgreSQL database named `sentinel_test` and a Redis database at index 1. The root `vitest.config.ts` injects these environment variables automatically:

- `DATABASE_URL`: `postgresql://sentinel:sentinel@localhost:5434/sentinel_test`
- `REDIS_URL`: `redis://localhost:6380/1`

These default ports (5434 for PostgreSQL, 6380 for Redis) match the dev Docker Compose file, which remaps ports to avoid conflicts with any host-level PostgreSQL or Redis instance.

### Using Docker Compose

Start the infrastructure services:

```bash
docker compose up postgres redis -d
```

Wait for both services to become healthy, then create the test database:

```bash
docker exec -it sentinel-postgres-1 psql -U sentinel -c "CREATE DATABASE sentinel_test;"
```

The test setup (`test/helpers/setup.ts`) handles schema creation automatically. It drops and recreates the `public` schema, then pushes all Drizzle table definitions directly -- you do not need to run migrations before running tests.

### Using custom ports

If your Docker Compose file maps PostgreSQL and Redis to different ports, override the connection strings when running tests:

```bash
DATABASE_URL=postgresql://sentinel:sentinel@localhost:5432/sentinel_test \
REDIS_URL=redis://localhost:6379/1 \
pnpm test
```

## Running all tests

From the repository root:

```bash
pnpm test
```

This runs `vitest run` which executes every test file matching the glob patterns in `vitest.config.ts` once (non-watch mode). The test discovery patterns are:

```
packages/*/src/**/__tests__/**/*.test.ts
modules/*/src/**/__tests__/**/*.test.ts
apps/*/src/**/__tests__/**/*.test.ts
test/**/*.test.ts
```

## Running tests for a specific package or scope

Use pnpm's `--filter` flag to scope execution to a single workspace:

```bash
# Run only the shared package tests
pnpm --filter @sentinel/shared test

# Run only the API integration tests
pnpm --filter @sentinel/api test
```

Alternatively, use Vitest project names defined in the root config:

```bash
# Unit tests for packages/shared only
pnpm test:unit

# Integration tests for apps/api only
pnpm test:integration
```

To run a single test file:

```bash
pnpm exec vitest run packages/shared/src/__tests__/correlation-engine.test.ts
```

To run tests matching a name pattern:

```bash
pnpm exec vitest run --reporter=verbose -t "rate limit"
```

## Watch mode

Use watch mode during active development. Vitest re-runs affected tests whenever you save a file:

```bash
pnpm test:watch
```

## Replicating the CI environment locally

The CI pipeline runs tests against freshly provisioned PostgreSQL and Redis containers (without TLS, with well-known credentials matching the defaults in `vitest.config.ts`). The rate-limit middleware is disabled in tests via the `DISABLE_RATE_LIMIT=true` environment variable, which is set by default in the test environment.

To replicate the exact CI conditions:

```bash
# Ensure Docker containers match the dev port configuration
docker compose up postgres redis -d

# Drop and recreate the test database for a clean slate
docker exec -it sentinel-postgres-1 psql -U sentinel -c "DROP DATABASE IF EXISTS sentinel_test;"
docker exec -it sentinel-postgres-1 psql -U sentinel -c "CREATE DATABASE sentinel_test;"

# Run the full test suite (rate limiting is disabled via DISABLE_RATE_LIMIT in test env)
DISABLE_RATE_LIMIT=true pnpm test
```

The test setup file (`test/helpers/setup.ts`) handles schema creation by pushing the Drizzle schema definitions directly. It also provisions test Redis (database index 1) and flushes it between tests to prevent state leakage.

## Test environment variables

The root `vitest.config.ts` injects the following environment variables for all test runs:

| Variable | Value | Purpose |
|---|---|---|
| `NODE_ENV` | `test` | Disables production-only behaviors (HSTS, secure cookies). |
| `DATABASE_URL` | `postgresql://sentinel:sentinel@localhost:5434/sentinel_test` | Test database connection. |
| `REDIS_URL` | `redis://localhost:6380/1` | Test Redis on database index 1. |
| `SESSION_SECRET` | `test-session-secret-at-least-32-chars-long!!` | Fixed test session secret (44 characters). |
| `ENCRYPTION_KEY` | `0123456789abcdef...` (64 hex chars) | Fixed test encryption key for AES-256-GCM. |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | CORS origin for test requests. |
| `SMTP_FROM` | `test@sentinel.dev` | Sender address for email test assertions. |

These values are injected automatically. You do not need to set them in your `.env` file or export them manually.

## Code coverage

Generate an HTML coverage report using V8's native coverage instrumentation:

```bash
pnpm exec vitest run --coverage
```

The report is written to `coverage/` at the repository root. Open `coverage/index.html` in a browser to inspect per-file coverage.

## Writing new tests

### File location convention

Place test files in a `__tests__/` directory adjacent to the source code they test. Name each file `<subject>.test.ts`.

```
packages/shared/src/
  crypto.ts
  __tests__/
    crypto.test.ts
```

For integration tests that span multiple modules (for example, an end-to-end flow from API request to alert dispatch), place them in the top-level `test/` directory:

```
test/
  alert-dispatch.test.ts
  correlation-evaluate.test.ts
```

### Factory patterns

Test files that insert rows into the database should use factory helpers rather than constructing raw SQL. The `test/` directory contains shared factory functions:

```typescript
import { createOrg, createUser, createDetection } from '../test/factories.js';

const { org } = await createOrg();
const { user } = await createUser({ orgId: org.id, role: 'editor' });
const detection = await createDetection({ orgId: org.id, createdBy: user.id });
```

Factories encapsulate default values and handle foreign-key relationships so that each test only specifies the fields relevant to the scenario being tested.

### Test isolation

Each test file runs in its own process (due to `pool: 'forks'`). However, because all test files share the same PostgreSQL database, tests must clean up after themselves. Use `beforeEach` or `afterEach` hooks to truncate tables or delete the specific rows created during the test:

```typescript
import { getDb } from '@sentinel/db';
import { detections } from '@sentinel/db/schema/core';

afterEach(async () => {
  const db = getDb();
  await db.delete(detections).where(eq(detections.orgId, testOrgId));
});
```

Alternatively, wrap each test in a database transaction that is rolled back at the end. Consult the existing integration tests in `apps/api/src/__tests__/` for examples of both patterns.

### CSRF header in test HTTP requests

API integration tests that simulate session-authenticated requests must include the `X-Sentinel-Request` header, just as the real browser client does. The test helper in `test/helpers.ts` exports a pre-configured `fetch` wrapper that includes this header automatically:

```typescript
import { sessionFetch } from '../test/helpers.js';

const res = await sessionFetch('/api/detections', {
  method: 'POST',
  body: JSON.stringify({ name: 'Test Detection' }),
});
```

### Testing module evaluators

Module rule evaluators are pure functions that receive a normalized event and return a list of alert candidates. Test them without BullMQ or database dependencies:

```typescript
import { myEvaluator } from '../evaluators/my-evaluator.js';
import { buildEvent } from '../__tests__/fixtures.js';

it('fires when condition is met', async () => {
  const event = buildEvent({ type: 'some.event', payload: { field: 'value' } });
  const candidates = await myEvaluator.evaluate(event, [myRule]);
  expect(candidates).toHaveLength(1);
  expect(candidates[0].severity).toBe('high');
});
```
