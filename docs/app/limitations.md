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
initializes a pool of 20 connections (`maxConnections: 20`); the API server uses the default
pool size. Long-running analytical queries (such as exporting large alert histories) can cause
contention with the write path.

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
| BullMQ job queues | `bull:events:*`, `bull:alerts:*`, `bull:module-jobs:*`, `bull:deferred:*` | All async processing stops: no events evaluated, no alerts dispatched, no maintenance jobs run |
| Windowed evaluators (chain module) | Module-specific keys | Sliding-window counters reset; threshold-based rules miss alerts for the duration of the window |
| Correlation engine | `sentinel:corr:seq:*`, `sentinel:corr:idx:*`, `sentinel:corr:agg:*`, `sentinel:corr:absence:*`, `sentinel:corr:cooldown:*` | In-flight correlation instances lost; absence-condition alerts may fire incorrectly |
| Rate limiter | `sentinel:rl:*` | Rate limiting non-functional (API requests succeed without throttling) |
| crt.sh concurrency limiter | `slot:crtsh` | Concurrency control for CT log queries non-functional |

### Correlation engine state loss on Redis restart

When Redis restarts or is flushed, the correlation engine loses all in-flight state:

- **Sequence instances**: Multi-step correlation rules in progress (e.g., "step 1 matched,
  waiting for step 2") are discarded. The sequence must start over from step 1.
- **Aggregation counters**: Counters tracking event counts or sums within a correlation window
  reset to zero. Rules that require "5 events in 10 minutes" will not fire until the threshold
  is reached again from zero.
- **Absence timers**: Absence conditions ("alert if event B does NOT occur within 30 minutes
  of event A") are tracked in Redis with a sorted-set index
  (`sentinel:corr:absence:index`). If Redis is flushed, pending absence timers are lost,
  meaning alerts that should fire (because event B never arrived) will not fire.
- **Cooldown locks**: Cooldown state for correlation rules is stored in Redis with a DB
  fallback. After a Redis flush, the engine falls back to `lastTriggeredAt` in PostgreSQL,
  which may allow a duplicate alert if the DB value is stale.

**Mitigation**: Use Redis persistence (AOF with `appendfsync everysec` or RDB snapshots) to
minimize state loss on restart. Monitor Redis memory usage. There is no mechanism to rebuild
correlation state from PostgreSQL.

### Event processing during Redis outage

Sentinel does not queue events in an alternative store during a Redis outage. Events ingested
via the API while Redis is unavailable are stored in PostgreSQL but their BullMQ jobs cannot
be enqueued. These events will not be processed until Redis is restored and jobs are
re-enqueued manually or via a recovery mechanism.

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
| Key isolation | Rate limit keys are scoped by org ID, API key prefix, or client IP (in that priority order) |

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

**Block gap detection**: Sentinel does not implement block-range gap recovery. If the worker
is offline for a period (due to an outage or RPC failure), blocks that occurred during the
outage are not retroactively scanned unless the worker is manually re-triggered for the
missing block range.

**Rate limits**: Public RPC providers (Infura, Alchemy, QuickNode) enforce per-second and
daily request limits. High-frequency polling of multiple contracts or chains on the same
provider may exhaust these limits. Configure multiple RPC URLs per chain to distribute load.

---

## GitHub App: single installation per organization

Each Sentinel organization supports a single GitHub App installation. This means:

- A Sentinel organization can monitor events from exactly one GitHub App installation (one
  GitHub organization or user account).
- Monitoring events across multiple GitHub organizations requires creating separate Sentinel
  organizations for each, with independent GitHub App installations.
- There is no multi-installation fanout within a single Sentinel organization.

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

## Multi-tenancy: organization-level isolation only

Sentinel's data isolation model operates at the organization level. All resources -- detections,
events, alerts, integrations, notification channels -- are scoped to an `orgId` and are
inaccessible to other organizations.

**Within an organization, there is no user-level data isolation.** All members of an
organization can view all events, alerts, and detections that belong to that organization.

| Role | Capabilities |
|------|-------------|
| `admin` | Full read/write access to all organization resources, member management |
| `member` | Read access to events and alerts; write access to detections and channels |

Operators who require user-level data isolation within a single deployment should provision
separate Sentinel organizations for each team that requires isolation.

---

## Module-specific limitations

### Chain module

| Limitation | Detail |
|-----------|--------|
| No block gap recovery | Missed blocks during outages are not retroactively scanned |
| SSRF protection is hostname-only | DNS rebinding attacks require infrastructure-level egress firewall rules for full mitigation |
| Etherscan dependency for ABI | Unverified contracts cannot be monitored via ABI-decoded events; only raw log topic matching is available |
| RPC URL rotation is deterministic | All worker replicas rotate to the same primary URL at the same time, which does not distribute load across replicas |
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
| WHOIS TLD coverage | Only 17 TLDs have hardcoded WHOIS server mappings; other TLDs fall back to IANA referral which may not provide full WHOIS data |
| crt.sh availability | crt.sh is a third-party public service with no SLA; CT log queries are best-effort |
| crt.sh concurrency | Limited to 5 concurrent requests to avoid overloading the service |
| No RDAP support | WHOIS uses legacy port-43 protocol; RDAP (the modern replacement) is not implemented |

### GitHub module

| Limitation | Detail |
|-----------|--------|
| Single installation per org | Cannot monitor multiple GitHub organizations from one Sentinel organization |
| Webhook delivery timeout | Sentinel must respond to GitHub webhooks within 10 seconds or the delivery is considered failed |

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
- PostgreSQL connection pool of 20 connections
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
| Connection pool (API) | Default (~10) |
| Connection pool (worker) | 20 per replica |
| Total connections (2 worker replicas) | ~50 |

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
