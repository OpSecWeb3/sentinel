# Bug Report

Generated 2026-03-28 during documentation pass. Each finding was discovered while reading source files to write accurate documentation. Findings represent places where the code does not match its apparent logical intent.

> **Note:** These findings were identified by documentation agents reading source code. Verify each issue before acting on it -- context may exist that is not visible from the files reviewed.

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 3 |
| HIGH     | 10 |
| MEDIUM   | 30 |
| LOW      | 32 |
| **Total**| **75** |

## Critical

- **[CRITICAL]** `modules/registry/src/router.ts:228-249` -- **Timing oracle on webhook signature verification**: Fallback path iterates all organizations attempting HMAC verification, leaking organization count via timing. Each org's secret is decrypted sequentially with observable side effects.

- **[CRITICAL]** `modules/registry/src/router.ts:484-498` -- **Race condition: image creation uses random UUID without DB insert**: `POST /images` generates a UUID for the artifact but never inserts it into `rcArtifacts`. The poll job receives an artifact ID that does not exist in the database. If the worker is down or the job fails, the image is lost with no record.

- **[CRITICAL]** `apps/api/src/routes/events.ts:174` -- **SQL injection via dot-notation path**: The payload-search endpoint constructs a PostgreSQL path array from user-supplied `field` via string interpolation `{${query.field.split('.').join(',')}}`. A field like `}; DROP TABLE events; --` would produce malformed SQL. The field should be validated to safe characters only.

## High

- **[HIGH]** `apps/api/src/middleware/session.ts:140-158` -- **Full table scan for session deletion**: `deleteSessionsByUserId`, `deleteSessionsByOrgId`, and `deleteSessionsByUserIdExcept` select ALL session rows, decrypt each in application code, and filter in memory. O(n) on total sessions. Degrades on every password change, role change, or org deletion. (Reported by 4 agents independently.)

- **[HIGH]** `packages/shared/src/correlation-engine.ts:419-446` -- **TOCTOU race in sequence instance creation**: Between `loadInstance()` check and `saveInstance()`, another worker could create an instance for the same key. `saveInstance` lacks NX flag for new instances, so the second write silently overwrites the first, losing the first matched step.

- **[HIGH]** `packages/shared/src/correlation-engine.ts:628-629` -- **Non-atomic absence trigger guard**: GET followed by conditional SET is not atomic. Two workers processing the same trigger could both see `existing = null` and both create instances, with non-deterministic trigger event ID.

- **[HIGH]** `packages/shared/src/correlation-engine.ts:1050` -- **Actor extraction treats sender object as string**: `payload.sender` is cast to `string` but is typically an object `{ login: string }` for GitHub events. Produces `"[object Object]"` in matched steps and correlated alert actors.

- **[HIGH]** `packages/shared/src/correlation-engine.ts:413` -- **Instance window expiry deletes based on stale stepIndex**: After advancement, the delete uses locally-mutated `currentStepIndex` which could delete freshly saved instance index keys in a narrow race.

- **[HIGH]** `scripts/deploy.sh:22` -- **Migrations run outside containers with host Node.js**: The deploy script runs `npx drizzle-kit migrate` on the VPS host, not inside a container. Node.js version drift between host and container could cause migration behavior differences.

- **[HIGH]** `modules/chain/src/rpc.ts:243-246` -- **SSRF validation does not block HTTP in production**: `validateRpcUrl` logs a warning for `http:` URLs but does not reject them. A user-supplied HTTP URL enables MITM of RPC responses.

- **[HIGH]** `modules/chain/src/rpc.ts:200` -- **Incomplete SSRF protection for IPv6**: Private IP patterns only cover IPv4. IPv6 loopback (`::1`), link-local (`fe80::`), and IPv4-mapped IPv6 (`::ffff:127.0.0.1`) bypass the filter.

- **[HIGH]** `modules/registry/src/handlers.ts:637-651` -- **Unbounded query for CI notification matching**: Queries up to 50 events without ordering, then scans in memory. May miss the actual matching event on high-volume orgs.

- **[HIGH]** `apps/api/src/routes/channels.ts:322` -- **Slack test uses process.env instead of org's installed token**: `process.env.SLACK_BOT_TOKEN` bypasses the encrypted bot token in `slackInstallations`. Test may fail or use wrong token in multi-org deployments.

## Medium

- **[MEDIUM]** `apps/api/src/routes/detections.ts:207-211` -- **Missing AWS module in resolve-template**: Only imports GitHub, Registry, Chain, and Infra modules. AWS templates return 404. Same omission at lines 237-239, 359-363, and 517-519.

- **[MEDIUM]** `apps/api/src/routes/detections.ts:662` -- **Redis connection leak in test endpoint**: Creates a new Redis connection per request instead of using the shared pool. If `redis.quit()` fails, connections leak.

- **[MEDIUM]** `apps/api/src/routes/detections.ts:480-493` -- **findUnresolvedPlaceholders returns raw `{{key}}` tokens**: Error messages show brace-wrapped tokens instead of clean key names.

- **[MEDIUM]** `apps/api/src/routes/channels.ts:137` -- **SMTP check uses process.env directly**: Bypasses the Zod-validated `env()` helper from `@sentinel/shared/env`.

- **[MEDIUM]** `apps/api/src/routes/chain-analytics.ts:121-138` -- **network-status not scoped to org**: Returns all block cursor positions globally without org filtering. Cross-org data exposure.

- **[MEDIUM]** `apps/api/src/middleware/validate.ts:42` -- **Mixed response patterns**: Validation errors return `c.json()` directly instead of throwing `HTTPException`, bypassing Sentry and global error handler.

- **[MEDIUM]** `apps/api/src/middleware/notify-key.ts:47` -- **Fire-and-forget without await loses errors**: `db.update()` for `notifyKeyLastUsedAt` uses `.catch()` on non-awaited promise. Under load, leaked connections could starve the pool.

- **[MEDIUM]** `apps/api/src/index.ts:113` -- **CSRF bypass for paths containing `/callback`**: Any path with substring `/callback` skips CSRF. A future route could accidentally bypass protection.

- **[MEDIUM]** `apps/api/src/routes/alerts.ts:87-92` -- **Correlated subqueries in list endpoint**: Per-row SELECT subqueries without orgId guard. JOINs would be more efficient and safer.

- **[MEDIUM]** `apps/api/src/routes/auth.ts:309` -- **Possibly missing `requireAuth` on invite secret endpoint**: Uses `requireScope` and `requireRole` but not explicit `requireAuth`. Depends on `requireScope` implementation.

- **[MEDIUM]** `apps/worker/src/index.ts:65` -- **Undersized connection pool**: PostgreSQL pool at 20 connections vs 45 total queue concurrency. Workers will contend under sustained load.

- **[MEDIUM]** `apps/worker/src/index.ts:140-146` -- **Repeatable job removal race on multi-instance deploy**: Two replicas could both remove and re-add the same repeatable job. BullMQ idempotency mitigates most harm.

- **[MEDIUM]** `apps/worker/src/index.ts:200-201` -- **closeAllQueues double-closes workers**: `shutdown` calls `worker.close()` twice (local array + shared queue module).

- **[MEDIUM]** `apps/worker/src/handlers/data-retention.ts:78-79` -- **SQL identifier injection via job payload**: `table` and `timestampColumn` from Redis job payload passed to `sql.identifier()` without validation. Exploitable if Redis is compromised.

- **[MEDIUM]** `apps/worker/src/handlers/correlation-expiry.ts:53` -- **Mutable module-level state**: `lastScanFallbackAt` resets on every restart, causing unnecessary SCAN fallback.

- **[MEDIUM]** `packages/shared/src/env.ts:11` -- **Missing validation for runtime env vars**: `ETHERSCAN_API_KEY`, `GITHUB_TOKEN`, `TRUSTED_PROXY_COUNT`, `DISABLE_RATE_LIMIT` bypass Zod validation. Malformed `TRUSTED_PROXY_COUNT` would silently break rate limiting.

- **[MEDIUM]** `packages/shared/src/rule-engine.ts:107` -- **acquiredRedisKeys map key collision**: Multi-rule detections overwrite earlier rules' Redis keys in the cleanup map. Earlier cooldown locks never cleaned up (persist until TTL).

- **[MEDIUM]** `packages/shared/src/correlation-engine.ts:956` -- **New instance SET lacks NX flag**: Unconditional SET for step 0 instances. TOCTOU race with concurrent workers creating the same instance.

- **[MEDIUM]** `packages/db/schema/core.ts:157-168` -- **Schema/migration mismatch on expression index**: Drizzle schema defines a simple unique index, but migration 0001 uses an expression index. Regenerating migrations loses the expression index.

- **[MEDIUM]** `packages/db/schema/aws.ts:47` -- **Type mismatch**: `pollIntervalSeconds` declared as `text` but semantically an integer. Consumers must parse with `parseInt()`.

- **[MEDIUM]** `modules/chain/src/rpc.ts:302` -- **URL rotation computed once at client creation**: Long-lived RPC clients never rotate providers.

- **[MEDIUM]** `modules/chain/src/block-poller.ts:306-310` -- **Inefficient per-block getLogs calls**: Issues one RPC call per block instead of batching with `fromBlock/toBlock` range.

- **[MEDIUM]** `modules/chain/src/block-poller.ts:306-349` -- **Serial block processing**: getLogs + getBlock calls execute sequentially per block during catch-up.

- **[MEDIUM]** `modules/chain/src/evaluators/windowed-sum.ts:89-100` -- **Full member scan for sum**: Fetches ALL sorted set members on every event. Scales linearly with window size.

- **[MEDIUM]** `modules/chain/src/etherscan.ts:117-119` -- **AbortSignal.timeout shared across retries**: 15s timer starts at first call; later retries get progressively less time.

- **[MEDIUM]** `modules/aws/src/normalizer.ts:77-78` -- **Unknown EventBridge detail-types silently dropped**: Only 3 EventBridge event types mapped. All others discarded with no error indication.

- **[MEDIUM]** `modules/aws/src/handlers.ts:329` -- **Non-deterministic fallback eventId**: `eb-${Date.now()}-${Math.random()}` means duplicate processing inserts multiple rows.

- **[MEDIUM]** `modules/github/src/router.ts:43-48` -- **In-memory rate limiter not shared across workers**: Process-local Map. Multi-worker deployment multiplies effective limit.

- **[MEDIUM]** `modules/github/src/router.ts:72` -- **Hardcoded fallback URL**: `?? 'http://localhost:3000'` for ALLOWED_ORIGINS. Could leak OAuth state in misconfigured deployments.

- **[MEDIUM]** `test/helpers/setup.ts:94-97` -- **Hardcoded fallback credentials differ from vitest.config.ts**: Falls back to port 5432/6379 while vitest injects 5434/6380. Could silently connect to wrong database.

## Low

- **[LOW]** `apps/api/src/index.ts:44` -- **BigInt prototype mutation is global**: Affects all code in the process including third-party libraries.
- **[LOW]** `apps/api/src/middleware/validate.ts:31` -- **Query parameter multi-value loss**: `Object.fromEntries` drops duplicate params.
- **[LOW]** `apps/api/src/middleware/session.ts:88` -- **Fire-and-forget delete swallows all errors**: `.catch(() => {})` discards connection failures.
- **[LOW]** `apps/api/src/middleware/session.ts:74` -- **Date comparison without timezone awareness**: Relies on JS Date constructor for timestamptz.
- **[LOW]** `apps/api/src/middleware/session.ts:105-106` -- **Empty string orgId/role stored in session**: Semantically incorrect placeholder values.
- **[LOW]** `apps/api/src/middleware/rate-limit.ts:20` -- **API key prefix extraction fragile**: 11-char slice for rate-limit key could collide.
- **[LOW]** `apps/api/src/middleware/notify-key.ts:54-56` -- **Silent fallthrough on non-HTTPException errors**: DB outage causes requests to proceed unauthenticated.
- **[LOW]** `apps/api/src/routes/auth.ts:25` -- **Pre-computed dummy hash blocks event loop**: `bcrypt.hashSync` during import adds ~200ms cold start.
- **[LOW]** `apps/api/src/routes/integrations.ts:42-43` -- **ALLOWED_ORIGINS first element used as web URL**: Wrong order breaks Slack OAuth.
- **[LOW]** `apps/api/src/routes/integrations.ts:137` -- **botUserId defaults to empty string**: Could confuse downstream truthy checks.
- **[LOW]** `apps/api/src/routes/detections.ts:584` -- **Test endpoint does not validate param ID as UUID**.
- **[LOW]** `apps/api/src/routes/alerts.ts:37-38` -- **Alert ID is numeric string, not UUID**: Inconsistent with rest of API.
- **[LOW]** `apps/web/src/app/(dashboard)/dashboard-shell.tsx:311` -- **Blank screen when auth fails**: Returns `null` if redirect fails.
- **[LOW]** `apps/web/src/app/(dashboard)/detections/new/page.tsx:311` -- **Loading state flicker**: Invisible DOM elements occupy layout space.
- **[LOW]** `apps/worker/src/handlers/correlation-expiry.ts:222` -- **Dead JavaScript label statement**: `alertsCreated:` is a no-op label.
- **[LOW]** `apps/worker/src/handlers/session-cleanup.ts:14-18` -- **No looping on batch limit**: 1000-session limit means slow backlog drain.
- **[LOW]** `apps/worker/src/handlers/key-rotation.ts:23` -- **Loose typing on RotationTarget.table**: Resolves to `any`.
- **[LOW]** `apps/worker/src/handlers/alert-dispatch.ts:87` -- **Unsafe double cast for createdAt**.
- **[LOW]** `apps/worker/src/handlers/alert-dispatch.ts:85` -- **Unsafe cast of triggerData**: Falls back to `'unknown'` module.
- **[LOW]** `.github/workflows/deploy.yml:70-73` -- **Leading whitespace in heredoc**: Fragile `sed` stripping.
- **[LOW]** `packages/db/schema/core.ts:92` -- **Default empty object for detections.config**: Could cause TypeError if not validated.
- **[LOW]** `packages/db/schema/core.ts:104` -- **Missing cascade on rules.org_id FK**: Defense-in-depth gap.
- **[LOW]** `packages/db/schema/chain.ts:148-150` -- **orgId/detectionId type mismatch in rpc_usage_hourly**: `text` vs `uuid`.
- **[LOW]** `packages/db/schema/aws.ts:67` -- **Missing FK on awsRawEvents.orgId**: No cascade on org deletion.
- **[LOW]** `packages/db/index.ts:51-62` -- **Singleton prevents multi-URL usage**: Silently ignores second `databaseUrl`.
- **[LOW]** `packages/db/src/seed/chain-networks.ts:7-18` -- **Only Ethereum Mainnet seeded**.
- **[LOW]** `packages/shared/src/queue.ts:78-80` -- **Synchronous in-flight guard is no-op**: `queueCreating` map set and immediately deleted.
- **[LOW]** `packages/shared/src/env.ts:45` -- **RPC_ROTATION_HOURS allows zero**: Potential division-by-zero if unconsumed.
- **[LOW]** `packages/shared/src/correlation-engine.ts:86-96` -- **Aggregation window inconsistency**: simple-count uses fixed windows, distinct-count uses sliding.
- **[LOW]** `packages/shared/src/conditions.ts:94-95` -- **ISO 8601 regex accepts date-only without timezone**.
- **[LOW]** `modules/chain/src/rpc.ts:395` -- **Unsafe BigInt conversion of transaction value**: Non-hex values crash parser.
- **[LOW]** `modules/chain/src/rpc.ts:493-495` -- **KNOWN_ABI_TYPES missing bare uint/int aliases**.

## Files Reviewed

Source files read across all 12 documentation agents:

- `apps/api/src/index.ts`
- `apps/api/src/redis.ts`
- `apps/api/src/middleware/session.ts`
- `apps/api/src/middleware/rate-limit.ts`
- `apps/api/src/middleware/validate.ts`
- `apps/api/src/middleware/notify-key.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/routes/detections.ts`
- `apps/api/src/routes/alerts.ts`
- `apps/api/src/routes/channels.ts`
- `apps/api/src/routes/correlation-rules.ts`
- `apps/api/src/routes/events.ts`
- `apps/api/src/routes/integrations.ts`
- `apps/api/src/routes/modules-metadata.ts`
- `apps/api/src/routes/notification-deliveries.ts`
- `apps/api/src/routes/aws-analytics.ts`
- `apps/api/src/routes/chain-analytics.ts`
- `apps/api/src/routes/github-analytics.ts`
- `apps/api/src/routes/infra-analytics.ts`
- `apps/api/src/routes/registry-analytics.ts`
- `apps/web/src/app/(dashboard)/dashboard-shell.tsx`
- `apps/web/src/app/(dashboard)/detections/new/page.tsx`
- `apps/web/src/app/(dashboard)/registry/page.tsx`
- `apps/web/src/app/(dashboard)/registry/events/page.tsx`
- `apps/web/src/app/(dashboard)/registry/templates/page.tsx`
- `apps/worker/src/index.ts`
- `apps/worker/src/handlers/alert-dispatch.ts`
- `apps/worker/src/handlers/correlation-evaluate.ts`
- `apps/worker/src/handlers/correlation-expiry.ts`
- `apps/worker/src/handlers/data-retention.ts`
- `apps/worker/src/handlers/event-processing.ts`
- `apps/worker/src/handlers/key-rotation.ts`
- `apps/worker/src/handlers/poll-sweep.ts`
- `apps/worker/src/handlers/session-cleanup.ts`
- `packages/db/index.ts`
- `packages/db/package.json`
- `packages/db/schema/core.ts`
- `packages/db/schema/correlation.ts`
- `packages/db/schema/chain.ts`
- `packages/db/schema/github.ts`
- `packages/db/schema/registry.ts`
- `packages/db/schema/infra.ts`
- `packages/db/schema/aws.ts`
- `packages/db/migrations/meta/_journal.json`
- `packages/db/src/seed/chain-networks.ts`
- `packages/shared/src/rule-engine.ts`
- `packages/shared/src/correlation-engine.ts`
- `packages/shared/src/correlation-types.ts`
- `packages/shared/src/conditions.ts`
- `packages/shared/src/env.ts`
- `packages/shared/src/queue.ts`
- `packages/shared/src/__tests__/correlation-engine.test.ts`
- `modules/chain/src/handlers.ts`
- `modules/chain/src/rpc.ts`
- `modules/chain/src/block-poller.ts`
- `modules/chain/src/etherscan.ts`
- `modules/chain/src/templates/index.ts`
- `modules/chain/src/evaluators/balance-track.ts`
- `modules/chain/src/evaluators/function-call-match.ts`
- `modules/chain/src/evaluators/state-poll.ts`
- `modules/chain/src/evaluators/windowed-count.ts`
- `modules/chain/src/evaluators/windowed-spike.ts`
- `modules/chain/src/evaluators/windowed-sum.ts`
- `modules/github/src/router.ts`
- `modules/github/src/evaluators/branch-protection.ts`
- `modules/github/src/evaluators/member-change.ts`
- `modules/registry/src/handlers.ts`
- `modules/registry/src/normalizer.ts`
- `modules/registry/src/polling.ts`
- `modules/registry/src/router.ts`
- `modules/registry/src/index.ts`
- `modules/registry/src/evaluators/anomaly-detection.ts`
- `modules/registry/src/evaluators/attribution.ts`
- `modules/registry/src/evaluators/digest-change.ts`
- `modules/registry/src/evaluators/npm-checks.ts`
- `modules/infra/src/evaluators/cert-expiry.ts`
- `modules/infra/src/evaluators/score-degradation.ts`
- `modules/infra/src/evaluators/whois-expiry.ts`
- `modules/aws/src/handlers.ts`
- `modules/aws/src/normalizer.ts`
- `docker-compose.prod.yml`
- `.github/workflows/deploy.yml`
- `.github/workflows/pr-checks.yml`
- `scripts/deploy.sh`
- `scripts/seed-ssm.sh`
- `package.json`
- `vitest.config.ts`
- `test/helpers/setup.ts`
