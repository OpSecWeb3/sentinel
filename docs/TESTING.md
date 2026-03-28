# Sentinel Testing Philosophy

> Tests exist to catch bugs before production. If a class of bug keeps shipping, the test suite has a structural gap — not a coverage gap.

---

## The Six Rules

These emerged from a security audit that found 67 bugs our 196-test suite missed. Every rule maps to a class of bug that was structurally invisible to the tests we had.

### 1. Every Zod schema touching SQL or an external call gets adversarial input tests

**What it catches:** SQL injection, SSRF bypass, path traversal, command injection.

The happy path tests send `{ field: "sender.login", value: "octocat" }`. Nobody sends `{ field: "}; DROP TABLE events; --" }`. But attackers do.

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

**Rule of thumb:** If the validated value ends up in a SQL query, a Redis key, an HTTP URL, or a shell command, add 3-5 adversarial cases inline with the endpoint tests.

### 2. Every Redis GET→SET pattern gets a `Promise.all` concurrency test

**What it catches:** TOCTOU races, lost updates, double-firing.

A synchronous mock Redis makes `get()` + `set()` appear atomic because there's no async gap. Real Redis has network round-trips where another worker can interleave.

```typescript
it('does not create duplicate instances under concurrent load', async () => {
  const [r1, r2] = await Promise.all([
    engine1.evaluate(event),
    engine2.evaluate(event),
  ]);

  const keys = await redis.keys('sentinel:corr:seq:*');
  expect(keys).toHaveLength(1); // SET NX ensures exactly one wins
});
```

**Rule of thumb:** Any code that does `GET` → conditional `SET` (cooldowns, correlation instances, aggregation counters, dedup locks) needs a `Promise.all` test with the real test Redis.

### 3. Every GET endpoint gets a second-org isolation test

**What it catches:** Cross-tenant data leakage, missing WHERE clauses, unscoped subqueries.

Single-org tests can't detect `SELECT * FROM alerts` (missing `WHERE org_id = ?`). You need two orgs in the same database and a query from the wrong one.

```typescript
it('org B cannot see org A alerts', async () => {
  await createAlert({ orgId: orgA.id });

  const res = await appRequest(app, 'GET', '/api/alerts', {
    cookie: orgB.cookie,
  });
  expect((await res.json()).data).toHaveLength(0);
});
```

**Rule of thumb:** The two-org fixture goes in every route's test file, not a standalone multi-tenancy suite. If the endpoint returns data, test that the wrong org gets empty results.

### 4. Every worker handler gets a direct unit test

**What it catches:** Handler logic bugs — SQL injection in dynamic queries, missing batch loops, unsafe type casts, dead code branches.

Worker handlers are tested only through their effects (event → evaluator → alert) in the scenario tests. The handler's own branching logic — retry semantics, batch size limits, allowlist validation — is invisible.

```typescript
it('rejects unknown table names in retention policy', async () => {
  const job = makeJob({
    policies: [{ table: 'pg_shadow', timestampColumn: 'created_at', retentionDays: 7 }],
  });
  await dataRetentionHandler.process(job);
  // Should skip silently, not execute SQL against pg_shadow
});
```

**Rule of thumb:** Every file in `apps/worker/src/handlers/` has a corresponding test that calls the handler with a mock `Job`. Test the edges: null inputs, empty arrays, boundary values, invalid configs.

### 5. Any unbounded query gets a >1000 row timing test

**What it catches:** Full table scans, N+1 queries, unbounded sorted set reads, missing indexes.

Functional tests pass with 3 rows. They also pass with 10,000 rows — just 100x slower. The bug is invisible until production.

```typescript
it('loads rules with a single JOIN, not N+1 queries', async () => {
  // Seed 20 detections × 2 rules = 40 rows
  const start = Date.now();
  const rows = await sql`
    SELECT r.id FROM rules r
    INNER JOIN detections d ON d.id = r.detection_id
    WHERE r.org_id = ${orgId} AND r.status = 'active'
  `;
  expect(Date.now() - start).toBeLessThan(500);
  expect(rows.length).toBe(40);
});
```

For Redis, assert on the operation used:

```typescript
it('uses ZRANGEBYSCORE with bounds, not unbounded ZRANGE', async () => {
  // Add 100 members
  const results = await redis.zrangebyscore(key, windowStart, '+inf');
  expect(results.length).toBeLessThanOrEqual(11); // not all 100
});
```

**Rule of thumb:** Seed enough data that a scan would be noticeably slow (500+ rows, 1000+ sorted set members). Assert on wall-clock time or operation type.

### 6. Every module branch gets explicit coverage

**What it catches:** Missing module registrations, dead dynamic imports, template resolution failures for specific modules.

If a route has a switch/`Map.get(moduleId)` that branches by module, and you only test `github`, the `aws` branch could be broken and you'd never know.

```typescript
const modules = ['github', 'registry', 'chain', 'infra', 'aws'];

it.each(modules)('resolves templates for %s module', async (moduleId) => {
  const res = await appRequest(app, 'GET', '/api/detections/resolve-template', {
    cookie, query: { moduleId },
  });
  expect(res.status).toBeLessThan(500);
});
```

**Rule of thumb:** If there are N modules and the code branches per module, `it.each(modules)` is the right pattern.

### 7. Every periodic handler has a matching scheduler in worker startup

**What it catches:** Handlers that are registered and functional but never triggered because nobody called `upsertJobScheduler`.

This is the bug that killed infra scans. The handler existed. The evaluator worked. The API created scan schedules. But scans never ran because the worker startup never scheduled the `infra.schedule.load` job. Every layer looked correct in isolation — the wiring between them was broken.

The test reads the worker source code statically and verifies:
1. Every module's `jobHandlers` array is collected via `modules.flatMap`
2. Every periodic handler (sweep, poll, schedule, flush) has a `name: 'xxx'` in a `upsertJobScheduler` call
3. Every scheduled job name matches a real handler's `jobName`
4. All 5 modules are in the worker's module list

```typescript
for (const jobName of periodicJobs) {
  it(`should schedule "${jobName}" via upsertJobScheduler`, () => {
    expect(workerSource).toContain(`name: '${jobName}'`);
  });
}
```

**Rule of thumb:** When adding a new module with periodic handlers, the test fails immediately if you forget the scheduler. No more silent scan failures.

---

## Test Layers

### Layer 1: Unit tests (`test/chunks/056-*.ts`, `packages/*/src/__tests__/`)
- Pure functions: crypto, conditions, env validation
- No DB or Redis required
- Fast: <1s total

### Layer 2: Integration tests (`test/chunks/006-*.ts` through `test/chunks/145-*.ts`)
- HTTP-layer tests via Hono's `app.request()` — no running server
- Real Postgres (localhost:5434) and real Redis (localhost:6380)
- Test the full middleware → validation → SQL pipeline
- ~15s total

### Layer 3: Scenario tests (`test/scenarios/*.e2e.test.ts`)
- End-to-end business logic: event → rule engine → alert → notification
- Cross-module compound evaluators, correlation sequences
- ~30s total

### Layer 4: Audit gap tests (`test/chunks/gap*.test.ts`)
- Adversarial inputs, concurrency races, multi-org isolation
- Performance assertions, worker handler edge cases
- Worker wiring verification (every periodic handler has a scheduler)
- These are the tests that catch the bugs the other layers miss

---

## Conventions

### File naming
```
test/chunks/{number}-{slug}.test.ts     # chunk tests (006-150)
test/chunks/gap{N}-{slug}.test.ts       # audit gap tests
test/scenarios/{name}.e2e.test.ts       # scenario tests
```

### Setup pattern
```typescript
let app: Hono<any>;
beforeAll(async () => { app = await getApp(); });
beforeEach(async () => { await cleanTables(); resetCounters(); });
```

### Entity creation
Use helpers from `test/helpers/setup.ts`:
- `createTestUser()`, `createTestOrg()`, `addMembership()`
- `createTestDetection()`, `createTestRule()`, `createTestEvent()`
- `createTestSession()` — for direct DB session creation
- `createTestApiKey()` — returns raw key for auth testing

Use helpers from `apps/api/src/__tests__/helpers.ts`:
- `setupAdmin()` — register + login, returns cookie + orgId
- `registerViewer()` — join via invite secret
- `appRequest()` — authenticated JSON request with CSRF header
- `createApiKey()` — via API endpoint

### External API mocking
No real API keys. Mock at the fetch level:
```typescript
vi.spyOn(globalThis, 'fetch').mockResolvedValue(
  new Response(JSON.stringify({ ok: true }), { status: 200 })
);
```

### Two-org fixture
```typescript
const userA = await createTestUser({ username: 'adminA' });
const orgA = await createTestOrg({ slug: 'org-a' });
await addMembership(orgA.id, userA.id, 'admin');
const sessA = await createTestSession(userA.id, orgA.id, 'admin');

// Repeat for org B — completely separate admin + org
```

---

## What NOT to test

- **Framework behavior.** Don't test that Hono returns 404 for unknown routes or that Zod rejects the wrong type. Test that *your* validation schema rejects *your* dangerous inputs.
- **Database constraints in isolation.** If the schema has a UNIQUE constraint, trust it. Test the application behavior when the constraint fires (e.g., ON CONFLICT DO NOTHING returns no rows).
- **Third-party library internals.** Don't test that bcrypt hashes correctly. Test that your login flow rejects wrong passwords and locks accounts.
- **CSS/layout.** Frontend tests validate data contracts and routing, not visual rendering. Use Playwright for that (separate repo concern).

---

## Running tests

```bash
# All tests (chunks + scenarios)
pnpm test

# Just chunk tests
npx vitest run test/chunks/

# Just gap tests
npx vitest run test/chunks/gap

# Single file
npx vitest run test/chunks/056-crypto.test.ts

# Watch mode
npx vitest test/chunks/ --watch
```

---

## When to add a test

1. **Before fixing a bug.** Write the test that would have caught it, verify it fails, then fix. This is the only way to know the fix actually works and the class of bug is now covered.

2. **When adding a new route.** Copy the structure from the nearest chunk test. Add adversarial inputs and a second-org isolation case.

3. **When adding a new worker handler.** Write direct handler tests with mock Jobs. Include allowlist/boundary testing.

4. **When touching Redis state management.** Add a `Promise.all` concurrency test.

5. **When adding a new module.** Add it to every `it.each(modules)` block in `gap6-module-route-branches.test.ts`. If the module has periodic handlers, `gap7-worker-wiring.test.ts` will fail automatically if you forget the scheduler.
