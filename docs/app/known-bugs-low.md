# Known Low-Severity Bugs

Findings from the 2026-03-29 production readiness audit. These are code smells, minor
inconsistencies, defensive hardening opportunities, or edge cases unlikely to cause
production incidents. Listed roughly by impact.

---

## Worth fixing soon

### L1. Webhook secret lost on channel update

**File:** `apps/api/src/routes/channels.ts:237-239`

When updating a webhook notification channel, if the request body includes a new `config`
object that omits `secret`, the existing encrypted secret in the database is replaced with
a config that has no secret. There is no logic to preserve the existing encrypted secret
when the field is not provided.

**Impact:** Updating a webhook channel's name (with config that omits secret) silently
removes the webhook signing secret. Subsequent webhook deliveries will be unsigned.

**Fix:** When `config.secret` is not provided in the update body, merge the existing
`config.secret` from the database before writing.

---

### L2. Lazy env() validation — server starts with invalid config

**File:** `packages/shared/src/env.ts:74-79`

The `env()` function parses `process.env` on first call, not at startup. If `ENCRYPTION_KEY`
is missing, the server starts successfully but crashes on the first request that touches
crypto.

**Impact:** Delayed failure on misconfigured deployments; harder to debug in production
because the process appears healthy until the first request.

**Fix:** Call `env()` eagerly during module initialization (e.g., at the top of
`apps/api/src/index.ts` and `apps/worker/src/index.ts`).

---

### L3. Registry poll trigger after image update sends wrong data shape

**File:** `modules/registry/src/router.ts:620-621`

When updating an image, the code enqueues `registry.poll` with
`{ artifactId: updated.id, orgId }` but the poll handler at
`modules/registry/src/handlers.ts:297` expects `job.data.artifact` (the full artifact
object). The poll triggered after an image update has `artifact = undefined`, causing the
handler to skip with "artifact not found or disabled."

**Impact:** Manual poll trigger after image update silently does nothing. The artifact
will be polled on the next scheduled sweep (typically within 60 seconds), so this is a
UX issue rather than a data loss bug.

**Fix:** Pass the full artifact object in the job data, or change the handler to accept
`artifactId` and load the artifact from the database.

---

### L4. No timeout on OCI registry fetches

**File:** `modules/registry/src/verification.ts:167-197`

The `getRegistryToken`, `fetchOciManifest`, and `fetchOciBlob` functions use bare `fetch()`
without `AbortSignal.timeout()`. If the Docker registry is slow or unresponsive, these calls
hang indefinitely within the BullMQ job until the job-level timeout kills the worker.

**Impact:** Worker thread starvation if Docker registry is slow. One hung verification
blocks a worker slot for the entire job timeout duration.

**Fix:** Add `signal: AbortSignal.timeout(15_000)` to each `fetch()` call.

---

### L5. Slack disconnect does not use a transaction

**File:** `apps/api/src/routes/integrations.ts:222-237`

The `DELETE /integrations/slack` handler performs three separate DB operations (delete
installation, update detections, update correlation rules) without a transaction. If the
process crashes between operations, Slack references in detections/rules may be cleared
while the installation still exists, or vice versa.

**Impact:** Inconsistent state on crash during disconnect. Low probability since the
operations complete in milliseconds.

**Fix:** Wrap all three operations in `db.transaction()`.

---

### L6. Request ID accepted from client without sanitization

**File:** `apps/api/src/middleware/request-context.ts:16`

`const requestId = c.req.header('X-Request-Id') ?? crypto.randomUUID()` — the client can
inject an arbitrary string as the request ID. This value is logged and returned in response
headers. An attacker could inject log-forging content (newlines, control characters) that
corrupt structured logs.

**Impact:** Log injection / log forging if the logging library does not escape values. Pino
(the logger used) does JSON-serialize values, which mitigates newlines but not all control
characters.

**Fix:** Validate the format (e.g., must be a UUID or alphanumeric string up to 64 chars)
before accepting. Fall back to `crypto.randomUUID()` if invalid.

---

## Minor — fix when touching these files

### L7. `closeAllQueues()` does not close shared Redis connection

**File:** `packages/shared/src/queue.ts:162-176`

The function closes queues, workers, and the flow producer, but does not close or
disconnect the shared Redis connection (`_connection`). Depending on shutdown sequence,
the shared connection may stay open.

**Impact:** Potential connection leak on graceful shutdown; may cause a timeout before
process exits. Mitigated by the force-exit timeout added in the medium-severity fixes.

**Fix:** Add `if (_connection) { await _connection.quit(); _connection = null; }` to
`closeAllQueues()`.

---

### L8. Auth write limiter applied to read-only routes

**File:** `apps/api/src/routes/auth.ts:39-45`

`auth.use('*', apiWriteLimiter)` applies the write limiter to ALL routes including GETs.
Hono stacks middleware, so GET `/auth/me` runs BOTH the write limiter and the read limiter,
consuming from both rate-limit buckets.

**Impact:** Read endpoints count against the write budget (30/min). Dashboard polling may
trigger write rate limits under heavy use.

**Fix:** Replace `auth.use('*', apiWriteLimiter)` with explicit `.use()` on POST/PUT/DELETE
routes only, or use Hono's method-specific middleware registration.

---

### L9. `poll-sweep` serializes entire storedVersions Map into job payload

**File:** `apps/worker/src/handlers/poll-sweep.ts:72-98`

For artifacts with many tracked versions, the job payload can become very large. BullMQ
stores job data in Redis, so this inflates Redis memory usage. A high-version-count Docker
Hub image (e.g., `nginx` with hundreds of tags) could produce job payloads of 100KB+.

**Impact:** Redis memory inflation. No correctness issue.

**Fix:** Pass only the artifact ID in the job payload and have the poll handler query
versions from the database.

---

### L10. Concurrency ACQUIRE_LUA only sets PEXPIRE on first acquire

**File:** `packages/shared/src/concurrency.ts:26`

The TTL is only set when `current == 1` (first acquire). If a job holds a slot longer than
the 5-minute default TTL, the key expires and subsequent acquires reset to 1, allowing
over-limit concurrency.

**Impact:** Safety TTL can become the bug for long-running jobs. Currently, the infra
scanner is the only caller, and scans typically complete in under 2 minutes.

**Fix:** Call `redis.call('PEXPIRE', KEYS[1], ARGV[2])` on every successful acquire, not
just the first. This refreshes the TTL as long as slots are actively held.

---

### L11. Notify-key middleware `.catch()` swallows errors with contradictory comment

**File:** `apps/api/src/middleware/notify-key.ts:48-51`

The code does `await db.update(...).catch(...)`. The comment says "awaited so errors
propagate" but the `.catch()` swallows them. The `lastUsedAt` update silently fails.

**Impact:** `lastUsedAt` may not be updated for notify keys if the DB write fails. This
is a best-effort field for auditing, so the impact is low.

**Fix:** Either remove the `.catch()` to let errors propagate, or fix the comment to
reflect that failure is intentional.

---

### L12. `uq_infra_cdn_provider_pattern` includes nullable column

**File:** `packages/db/schema/infra.ts:430`

The unique index `(orgId, provider, hostPattern)` includes `hostPattern` which can be
`NULL`. In PostgreSQL, `NULL != NULL`, so multiple rows with the same org+provider and
a `NULL` hostPattern can coexist, defeating the intended uniqueness for catch-all configs.

**Impact:** Multiple catch-all CDN configs for the same org+provider. The UI/API may
return inconsistent results.

**Fix:** Add a partial index `WHERE host_pattern IS NULL` for the catch-all case, or use
a sentinel value (e.g., `'*'`) instead of NULL.

---

## Cosmetic / code quality

### L13. `detections.ts:817` body parsed twice

**File:** `apps/api/src/routes/detections.ts:802-819`

The `POST /:id/test` handler uses `validate('param', ...)` middleware but manually parses
the body with `c.req.json()` + `safeParse()` instead of `validate('json', ...)`. Works
because Hono caches the parsed JSON, but inconsistent with the rest of the codebase.

---

### L14. `auth.ts:198` compares `failedLoginAttempts` with `>` on possibly null field

**File:** `apps/api/src/routes/auth.ts:198`

`if (user.failedLoginAttempts > 0 || user.lockedUntil)` — if `failedLoginAttempts` is
`null`, `null > 0` is `false` in JS. Safe today but fragile under refactoring.

---

### L15. `compare()` function has no default case in switch statements

**File:** `packages/shared/src/conditions.ts:31-134`

The function returns `boolean` but switch statements have no `default` case. Currently safe
due to TypeScript exhaustiveness checking but could return `undefined` if a cast bypasses
the type system.

---

### L16. `getDb()` called at module scope in event-processing and correlation handlers

**Files:** `apps/worker/src/handlers/event-processing.ts:28`,
`apps/worker/src/handlers/correlation-evaluate.ts:24`

`getDb()` is called at handler-creation time, not at job-processing time. If the DB
connection is reset after startup, handlers hold a stale reference. In practice, `closeDb()`
is only called during shutdown, so this is safe.

---

### L17. `slackInstallations.botToken` naming inconsistency

**File:** `packages/db/schema/core.ts:205`

The column stores AES-encrypted ciphertext but is named `bot_token` instead of following
the `_encrypted` suffix convention used by other encrypted columns (`webhookSecretEncrypted`,
`credentialsEncrypted`). Risk of accidentally logging or exposing the value thinking it's
plaintext.

---

### L18. `evaluateConditions` returns `true` for empty conditions array

**File:** `packages/shared/src/conditions.ts:142-143`

By design (no conditions = always match), but means an aggregation rule with an empty
`conditions` array counts ALL events from the matching module. Could cause noisy false
positives on misconfiguration.

---

### L19. Chain block poller emits jobs for empty blocks

**File:** `modules/chain/src/block-poller.ts:352-370`

The poller emits a `BlockData` job for every block in a catch-up range, even blocks with
zero logs and zero transactions. Creates unnecessary job processing overhead.

---

### L20. N+1 query in infra `saveScanResult`

**File:** `modules/infra/src/handlers.ts:110-112`

Step results are inserted one at a time in a `for` loop (8 separate INSERTs for a full
scan). Should use a batch insert.

---

### L21. AWS handler uses `require('node:crypto')` instead of static import

**File:** `modules/aws/src/handlers.ts:377`

Mixes CommonJS `require()` with ES modules. Style inconsistency; minor bundling concern.

---

### L22. npm-registry search scope filter has dead code

**File:** `modules/registry/src/npm-registry.ts:38-40`

`obj.package.name === scope` can never match a valid npm package name. The condition is
dead code after the `startsWith(scopePrefix)` check.

---

### L23. Infra normalizer consecutive failure count — potential parallel probe race

**File:** `modules/infra/src/normalizer.ts:282-299`

If parallel probes run for the same host, the DB query for recent check history could
include the other in-flight probe's result, causing a double-count. Low probability since
probes are serialized per host by the scan scheduler.

---

### L24. `BigInt(id)` conversion without error handling

**Files:** `apps/api/src/routes/alerts.ts:190`,
`apps/api/src/routes/notification-deliveries.ts:54,168`

Zod validates the format as a numeric string, but extremely large numbers could still throw.
Unlikely to be triggered in practice.
