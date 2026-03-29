# Known Limitations

This document describes the architectural constraints, operational trade-offs, and known
performance characteristics of the Sentinel platform as of the current release. Understanding
these limitations helps operators plan capacity, configure integrations, and set appropriate
expectations for deployment.

---

## No horizontal database scaling

Sentinel uses a single PostgreSQL instance for all reads and writes. The application does not
support read replicas, connection routing to a follower, or sharding.

**Impact**: Under high alert volumes, all queries -- including read-heavy dashboard queries and
write-heavy event ingestion -- compete for the same database connection pool. The worker
process sizes its pool to match total BullMQ concurrency across queues (`maxConnections: 50` in
`apps/worker/src/index.ts`); the API server uses the `postgres` client default (`max: 10` in
`packages/db/index.ts` unless overridden). Long-running analytical queries (such as exporting
large alert histories) can cause contention with the write path.

**Mitigation**: Use PostgreSQL connection pooling (PgBouncer or the equivalent managed service
offering from your cloud provider). Schedule bulk exports and reporting queries during
off-peak periods. Consider using a read replica at the infrastructure level (outside Sentinel's
application layer) for analytics workloads, with the understanding that Sentinel itself will
not use it automatically.

---

## Redis is required

Redis is a hard dependency for both the API server and the worker service. The following
subsystems store state exclusively in Redis and cannot operate without it:

| Subsystem | Redis key namespace | Impact of Redis loss |
|-----------|--------------------|-----------------------|
| BullMQ job queues | Queues named `events`, `alerts`, `module-jobs`, `deferred` (`packages/shared/src/queue.ts`); BullMQ stores jobs/metadata under its Redis key prefix (default `bull:`) | All async processing stops while Redis is unavailable: no events evaluated, no alerts dispatched, no maintenance jobs run |
| Windowed evaluators (chain module) | Module-specific keys | Sliding-window counters reset; threshold-based rules miss alerts for the duration of the window |
| Correlation engine | `sentinel:corr:seq:*`, `sentinel:corr:idx:*`, `sentinel:corr:agg:*`, `sentinel:corr:absence:*`, `sentinel:corr:cooldown:*` | In-flight correlation instances lost; absence-condition alerts may fire incorrectly |
| Rate limiter | `sentinel:rl:*` | Rate limiting non-functional (API requests succeed without throttling) |
| crt.sh concurrency limiter | `slot:crtsh` | Concurrency control for CT log queries non-functional |

### Correlation engine state and Redis durability

Correlation state lives in Redis (`sentinel:corr:*` prefixes in `packages/shared/src/correlation-engine.ts`). What happens depends on **how** Redis loses data:

| Scenario | Typical outcome |
|----------|-----------------|
| **Process restart with AOF/RDB persistence** (common production setup) | Keys are replayed from disk after restart; in-flight correlation, BullMQ jobs, and rate-limit counters generally survive the same way as any other Redis data. This is an **operations** choice (e.g. shared ChainAlert/Redis with durable config), not something Sentinel re-implements. |
| **`FLUSHALL`, failed deployment, or eviction under `allkeys-*`** | In-flight state is lost. Effects below apply. |

When correlation state is **actually** wiped:

- **Sequence instances**: Multi-step rules in progress are discarded; the sequence starts over.
- **Aggregation counters**: Window counters reset; count thresholds must be reached again.
- **Absence timers**: Pending timers keyed under `sentinel:corr:absence:*` and indexed in `sentinel:corr:absence:index` are lost, so absence alerts that should have fired may not.
- **Cooldown locks**: Redis cooldown keys may be lost; the engine can fall back to PostgreSQL (`lastTriggeredAt`), which may allow a duplicate if the DB row is stale.

**Mitigation**: Run Redis with persistence and `noeviction` (or equivalent) for production. Monitor memory. There is no application-level rebuild of correlation state from PostgreSQL alone.

### Event processing during Redis outage

Sentinel does not queue events in an alternative store during a Redis outage. Producers insert
rows into PostgreSQL and then call `queue.add` (or `safeEnqueue` in the registry module, which
logs and continues if enqueue fails). If Redis is down after the insert, the event row can exist
without a corresponding `event.evaluate` job. There is **no** built-in sweep that finds those
rows and re-enqueues them; recovery is operational (replay, manual fix, or future tooling).

---

## Single Redis instance architecture

Sentinel uses a single Redis instance for all subsystems (BullMQ, rate limiting, windowed
evaluators, correlation engine, concurrency slots). There is no support for:

- Redis Cluster (BullMQ requires a non-clustered connection)
- Redis Sentinel (automatic failover) at the application level
- Separate Redis instances for different subsystems

**Impact**: The single Redis instance is a single point of failure for all async processing and
stateful evaluation. Memory pressure from one subsystem (e.g., a large number of correlation
instances) affects all others.

**Resource guidance**: For a deployment with 5 monitored modules, 50 active detection rules,
and 10 active correlation rules, Redis memory usage is typically 50-200 MB. Monitor with
`INFO memory` and set `maxmemory` with an appropriate eviction policy (`noeviction` is
recommended to prevent silent data loss in BullMQ).

---

## Rate limiting precision

The API rate limiter uses a Redis-backed counter with a Lua script for atomic
increment-and-expire. This approach has the following precision characteristics:

| Characteristic | Detail |
|---------------|--------|
| Algorithm | Fixed window counter (not sliding window) |
| Window alignment | Per-key, based on first request in the window |
| Boundary behavior | A client can make up to 2x the limit at a window boundary (e.g., 100 requests at the end of window 1 and 100 at the start of window 2) |
| Clock source | Redis server clock (TTL-based) |
| Key isolation | Rate limit keys are scoped by user ID, API key prefix, or client IP (in that priority order) |

**Configured limits:**

| Limiter | Window | Limit | Scope |
|---------|--------|-------|-------|
| `authLimiter` | 15 minutes | 10 requests | Login/register endpoints |
| `apiReadLimiter` | 1 minute | 100 requests | `GET /api/*` |
| `apiWriteLimiter` | 1 minute | 30 requests | `POST/PUT/PATCH/DELETE /api/*` |

**Mitigation for boundary burst**: For most API use cases, the fixed-window approach is
sufficient. If strict sliding-window rate limiting is required, the implementation must be
replaced with a sliding-window algorithm (e.g., sliding window log or sliding window counter).

---

## No built-in alert deduplication beyond cooldown TTL

Sentinel does not deduplicate alerts beyond the per-detection cooldown period. If the same
detection rule triggers twice within the cooldown window, the second alert is suppressed. Once
the cooldown expires, a new alert is created even if the underlying condition has not changed.

**There is no fingerprinting, grouping, or suppression of semantically duplicate alerts
across cooldown periods.** Operators monitoring high-frequency event sources (such as
blockchain event logs with frequent matches) may see repeated alerts for the same logical
condition if the cooldown is shorter than the re-trigger interval.

**Mitigation**: Set detection cooldown periods appropriate to the expected trigger frequency
of the underlying event. For detections on high-volume sources (chain windowed evaluators,
AWS CloudTrail), use threshold-based evaluators or aggregation-type correlation rules to
reduce alert noise.

---

## EVM monitoring relies on RPC node availability and rate limits

The chain module polls EVM blockchain nodes directly via JSON-RPC. All of the following
detection capabilities depend on a live, responsive RPC endpoint:

- Block polling and transaction decoding
- Smart contract event log fetching
- Contract view function calls
- Balance and storage slot polling

**If the configured RPC nodes are unavailable or rate-limited**, the worker retries each RPC
call up to 3 times with exponential backoff (1 s, 2 s, 4 s) before failing over to the next
URL. If all URLs and retries are exhausted, the BullMQ job fails and is retried up to 3 more
times by the queue. After exhausting all retries, the job moves to the `failed` state.

**Block gaps and catch-up**: The chain block poller (`modules/chain/src/block-poller.ts`) compares
the stored cursor to the chain tip and fetches logs for the gap in batches (`MAX_BLOCKS_PER_TICK`,
default 50 blocks per tick). If the gap exceeds `MAX_CATCH_UP_BLOCKS` (1000), it **fast-forwards**
the cursor to near the chain tip (keeping a small lookback), intentionally **skipping** history
— operator-visible "missed" blocks in extreme catch-up scenarios. Very fast chains can still be
constrained by BullMQ repeatable-job timing; see the header comment in `block-poller.ts`.

**Rate limits**: Public RPC providers (Infura, Alchemy, QuickNode) enforce per-second and
daily request limits. High-frequency polling of multiple contracts or chains on the same
provider may exhaust these limits. Configure multiple RPC URLs per chain to distribute load.

---

## GitHub App: multiple installations per organization (data model)

The schema (`github_installations.orgId`) and API (`GET/POST /modules/github/installations`) allow **more than one** GitHub App installation per Sentinel organization. Webhooks resolve the installation and store events against the correct installation record. Product UX may still assume a single install; the platform is not hard-limited to one row per org in code.

---

## Session storage in PostgreSQL

User sessions are stored in the PostgreSQL `sessions` table, not in Redis. This is a
deliberate architectural decision with the following trade-offs:

**Advantages:**
- Sessions persist across Redis restarts and flushes without logging users out.
- Session data is subject to the same backup and recovery guarantees as all other PostgreSQL
  data.
- No additional Redis memory allocation for session data is required.

**Disadvantages:**
- Instantaneous session invalidation (for example, on logout or privilege revocation) requires
  a database write followed by a read on the next request to confirm invalidation. There is no
  Redis-backed invalidation mechanism that can propagate a revocation in sub-millisecond time
  across multiple API server replicas.
- Under high concurrent user loads, session reads and writes consume PostgreSQL connection
  pool slots alongside application queries.
- Session data cannot be shared across application tiers without a database query.

The `platform.session.cleanup` job (running every hour) deletes rows from the `sessions`
table where `expire < now()`. Sessions are encrypted at rest using AES-256-GCM and are
subject to key rotation by the `platform.key.rotation` job.

---

## Encryption key rotation requires ENCRYPTION_KEY_PREV until completion

The `platform.key.rotation` job re-encrypts rows in batches of 100 across all encrypted
columns (org secrets, Slack/GitHub/AWS credentials, CDN configs, registry artifacts, and
sessions). The `decrypt()` function falls back to `ENCRYPTION_KEY_PREV` when the current
key fails, so rows not yet re-encrypted remain readable throughout the rotation.

**If `ENCRYPTION_KEY_PREV` is removed before all rows have been re-encrypted**, any row
still holding ciphertext from the old key will fail to decrypt. For sessions this means an
immediate forced logout for affected users; for integration credentials it means those
integrations stop functioning until the row is manually re-encrypted or the old key is
restored.

**There is no completion indicator.** The schema stores no key-version column
(`key-rotation.ts` comment, line 109), so the job cannot confirm that rotation is 100%
complete — it detects remaining work by calling `needsReEncrypt()` on each row at read time.

**Operational guidance:**
- Keep `ENCRYPTION_KEY_PREV` set for at least one full rotation cycle after all workers have
  been restarted with the new `ENCRYPTION_KEY`. The job runs every 5 minutes; allow at least
  30 minutes (six cycles) on a quiescent system before removing the previous key.
- On a system with large row counts, monitor worker logs for `Re-encrypted rows` messages
  and wait until the job logs `totalRotated: 0` for several consecutive cycles before
  unsetting `ENCRYPTION_KEY_PREV`.
- Do not restart workers with the old key removed mid-rotation. Restart order matters:
  deploy with both keys set → wait for rotation to complete → remove the old key → redeploy.

---

## Multi-tenancy: organization-level isolation only

Sentinel's data isolation model operates at the organization level. All resources -- detections,
events, alerts, integrations, notification channels -- are scoped to an `orgId` and are
inaccessible to other organizations.

**Within an organization, there is no user-level data isolation.** All members of an
organization can view all events, alerts, and detections that belong to that organization.

| Role | Capabilities (typical routes) |
|------|------------------------------|
| `admin` | Full organization control, integrations, user roles, destructive operations |
| `editor` | Create/update detections, correlation rules, channels |
| `viewer` | Read-only access where enforced by `requireRole` |

Operators who require user-level data isolation within a single deployment should provision
separate Sentinel organizations for each team that requires isolation.

---

## Module-specific limitations

### Chain module

| Limitation | Detail |
|-----------|--------|
| Large block gaps fast-forward | Gaps over 1000 blocks skip to near chain tip (see `MAX_CATCH_UP_BLOCKS`); small/moderate gaps are caught up in batches |
| SSRF protection is hostname-only | DNS rebinding attacks require infrastructure-level egress firewall rules for full mitigation |
| Etherscan dependency for ABI | Unverified contracts cannot be monitored via ABI-decoded events; only raw log topic matching is available |
| RPC URL rotation is optional | URL reordering runs only when `RPC_ROTATION_HOURS` is set; when unset, the configured URL list order is fixed. When rotation is enabled, it is time-synchronized across replicas (same order at the same wall time), so it does not spread load across providers within a single tick |
| View call UDVT handling | User-defined value types in Solidity function signatures are replaced with `uint256`; complex struct-based UDVTs are not supported |

### Registry module

| Limitation | Detail |
|-----------|--------|
| Docker Hub rate limits | High-frequency polling of many artifacts from a single IP can exhaust unauthenticated pull limits (100 per 6 hours) |
| npm abbreviated metadata | Incremental polls use abbreviated metadata that omits `time`, `maintainers`, and `deprecated` fields; full scans are needed for complete metadata |
| GHCR authentication | Requires a personal access token (`GITHUB_TOKEN`); GitHub App installation tokens are not used for GHCR |
| Full scan scheduling is process-local | In-memory poll count maps are per-worker; all workers share authoritative state from the database, but there is a small race window |

### Infra module

| Limitation | Detail |
|-----------|--------|
| WHOIS TLD coverage | 18 common TLDs have hardcoded WHOIS server mappings in `whois.ts`; others fall back to `whois.iana.org` referral, which may not provide full WHOIS data |
| crt.sh availability | crt.sh is a third-party public service with no SLA; CT log queries are best-effort |
| crt.sh concurrency | Limited to 5 concurrent requests to avoid overloading the service |
| No RDAP support | WHOIS uses legacy port-43 protocol; RDAP (the modern replacement) is not implemented |

### GitHub module

| Limitation | Detail |
|-----------|--------|
| Webhook response time | GitHub expects a successful HTTP response within a short window (documented as 10 seconds on GitHub's side); exceed it and deliveries may be marked failed |

### AWS module

| Limitation | Detail |
|-----------|--------|
| SQS polling only | Does not support SNS push or EventBridge as event sources; requires a customer-managed SQS queue |
| Short retention | Raw AWS events are retained for only 7 days due to expected high volumes |

---

## Resource requirements

### Container resource limits (production Docker Compose)

| Service | Memory limit | CPU limit | Replicas |
|---------|-------------|-----------|----------|
| `sentinel-api` | 384 MB | 1.0 CPU | 1 |
| `sentinel-worker` | 384 MB | 1.0 CPU | 2 |
| `sentinel-web` | 384 MB | 0.5 CPU | 1 |

### Worker memory considerations

The worker process is the most memory-intensive component due to:

- BullMQ job processing across 4 queues with varying concurrency levels
- Multiple Redis connections (1 shared + 1 per Worker instance)
- PostgreSQL connection pool of 50 connections per worker process
- In-memory module evaluator registry
- Sigstore TUF trust material cache

Under heavy load with high-concurrency queues (`events: 15`, `alerts: 15`, `module-jobs: 10`,
`deferred: 5`), a single worker replica may approach the 384 MB limit. Monitor container
memory usage and increase the limit if OOM kills occur.

### Worker concurrency configuration

| Queue | Concurrency | Purpose |
|-------|-------------|---------|
| `events` | 15 | Event processing and rule evaluation |
| `alerts` | 15 | Alert notification dispatch |
| `module-jobs` | 10 | Module-specific work (webhook processing, polling, RPC usage flush) |
| `deferred` | 5 | Scheduled jobs (data retention, session cleanup, key rotation, correlation expiry) |

### PostgreSQL sizing

For a deployment with 5 active modules and moderate event volumes (~10,000 events/day):

| Metric | Estimate |
|--------|----------|
| Database size (6-month retention) | 2-5 GB |
| Connection pool (API) | Default 10 per API process (`packages/db/index.ts`) |
| Connection pool (worker) | 50 per worker process |
| Order-of-magnitude total (1 API + 2 workers) | ~110 DB connections from app tier before PgBouncer |

### Redis sizing

| Metric | Estimate |
|--------|----------|
| Base memory (BullMQ queues, empty) | 10-20 MB |
| Per active correlation instance | ~1-5 KB |
| Windowed evaluator counters | ~100 bytes per counter per window |
| Rate limiter keys | ~100 bytes per active key |
| Typical total (moderate load) | 50-200 MB |

---

## Known performance characteristics

### Alert volume vs. worker throughput

The `alerts` queue processes notification dispatch jobs at a concurrency of 15. Each
`alert.dispatch` job makes one or more outbound HTTP calls (Slack, email SMTP, or webhook).
Throughput is bounded by the latency of external notification endpoints.

Under normal conditions (Slack API responding in ~200 ms, SMTP in ~500 ms), a single worker
replica can process approximately 30-50 dispatch jobs per second. Under a burst scenario
(a single detection triggering hundreds of alerts in a short window), the queue depth grows
until the burst subsides.

The `events` queue processes rule evaluation at a concurrency of 15. Rule evaluation is
CPU-bound for simple conditions and Redis-bound for windowed evaluators. Typical throughput
on a single worker replica is 100-500 evaluations per second, depending on the number of
active detection rules and evaluator complexity.

### Retention cleanup under high event volumes

The `platform.data.retention` job runs daily, deleting expired rows in batches of 1,000. Under
high event volumes (tens of thousands of events per day), a single daily retention run may take
several minutes and issue many DELETE batches. This is by design to avoid long-held locks. If
retention cannot keep up with ingest volume, reduce the retention window for high-volume
modules.

### Correlation engine state growth

The correlation engine stores in-flight instances in Redis. Under high event volumes with
broadly-matching correlation rules (sequence rules with no narrow filter conditions), the
number of live instances can grow significantly. Each instance occupies Redis memory for the
duration of the correlation window. Monitor Redis memory when deploying correlation rules with
large windows (greater than 60 minutes) against high-frequency event sources.

### Scheduled job intervals

| Job | Queue | Interval | Purpose |
|-----|-------|----------|---------|
| `platform.data.retention` | `deferred` | 24 hours | Delete expired events, alerts, and module-specific data |
| `platform.session.cleanup` | `deferred` | 1 hour | Delete expired session rows |
| `platform.key.rotation` | `deferred` | 5 minutes | Re-encrypt rows using the current encryption key |
| `correlation.expiry` | `deferred` | 5 minutes | Fire alerts for expired absence conditions |
| `chain.rpc-usage.flush` | `module-jobs` | 5 minutes | Persist RPC call metrics to the database |
| `registry.poll-sweep` | `module-jobs` | 60 seconds | Check for artifacts due for a poll cycle |
| `aws.poll-sweep` | `module-jobs` | 60 seconds | Poll SQS queues for new CloudTrail events |
