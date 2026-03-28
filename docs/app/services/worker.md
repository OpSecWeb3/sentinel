# Worker Service

The Sentinel worker service processes asynchronous jobs for rule evaluation, alert dispatch,
correlation analysis, and platform maintenance. It is built on
[BullMQ 5](https://docs.bullmq.io/) backed by Redis 7 and runs as a standalone Node.js process
separate from the API server.

## Architecture overview

On startup, the worker:

1. Connects to Redis using a shared `IORedis` connection for Queue instances (producers) and
   registers a connection factory that gives each BullMQ Worker its own dedicated Redis
   connection, preventing head-of-line blocking on the blocking `BRPOPLPUSH` command.
2. Initializes the Sigstore trust material for registry artifact signature verification.
3. Registers all module evaluators (GitHub, Registry, Chain, Infra, AWS) plus the platform-level
   compound evaluator.
4. Registers module-specific Slack formatters for alert dispatch.
5. Groups all job handlers by their declared `queueName`.
6. Starts one BullMQ `Worker` per queue with per-queue concurrency settings.
7. Schedules recurring jobs (data retention, session cleanup, key rotation, correlation expiry,
   RPC usage flush, registry poll sweep, AWS poll sweep).

The worker initializes its PostgreSQL connection pool with `maxConnections: 20` to support
the high aggregate concurrency across all queues (15 + 15 + 10 + 5 = 45 concurrent job slots).

The worker registers a `SIGTERM` and `SIGINT` handler that drains in-flight jobs, closes all
queue connections, and disconnects from Redis and PostgreSQL before exiting.

## Queue names and concurrency

All queue names are declared in `packages/shared/src/queue.ts` as the `QUEUE_NAMES` constant and
are the single source of truth consumed by both the API and the worker.

| Queue name    | Constant              | Concurrency | Primary purpose                                              |
|---------------|-----------------------|-------------|--------------------------------------------------------------|
| `events`      | `QUEUE_NAMES.EVENTS`  | 15          | Normalized event processing and correlation evaluation       |
| `alerts`      | `QUEUE_NAMES.ALERTS`  | 15          | Alert notification dispatch                                  |
| `module-jobs` | `QUEUE_NAMES.MODULE_JOBS` | 10      | Module-specific work: polling, webhook processing, state     |
| `deferred`    | `QUEUE_NAMES.DEFERRED` | 5          | Scheduled/deferred jobs: retention, cleanup, key rotation    |

The `events` and `alerts` queues use the highest concurrency (15) because event evaluation
involves CPU-bound rule matching with Redis lookups, while alert dispatch jobs make outbound
HTTP calls to Slack and SMTP servers and spend the majority of their time waiting for network
I/O. The `module-jobs` queue runs at concurrency 10 to support parallel polling across
multiple integrations.

## Job handlers

The following table lists every core job handler registered by the worker process. Module handlers
(for GitHub, Chain, Registry, Infra, and AWS) are registered separately by each module and are
not listed here.

| Handler name                | Job name                   | Queue         | Schedule / trigger                      | Default retries | Backoff        |
|-----------------------------|----------------------------|---------------|-----------------------------------------|-----------------|----------------|
| `event-processing`          | `event.evaluate`           | `events`      | Enqueued by API on event receipt        | 3               | Exponential 2s |
| `correlation-evaluate`      | `correlation.evaluate`     | `events`      | Enqueued by `event.evaluate` handler    | 3               | Exponential 2s |
| `correlation-expiry`        | `correlation.expiry`       | `deferred`    | Repeating, every 5 minutes              | 3               | Exponential 2s |
| `alert-dispatch`            | `alert.dispatch`           | `alerts`      | Enqueued by event and correlation handlers | 3            | Exponential 2s |
| `data-retention`            | `platform.data.retention`  | `deferred`    | Repeating, every 24 hours               | 3               | Exponential 2s |
| `poll-sweep`                | `registry.poll-sweep`      | `module-jobs` | Repeating, every 60 seconds             | 3               | Exponential 2s |
| `aws-poll-sweep`            | `aws.poll-sweep`           | `module-jobs` | Repeating, every 60 seconds             | 3               | Exponential 2s |
| `rpc-usage-flush`           | `chain.rpc-usage.flush`    | `module-jobs` | Repeating, every 5 minutes              | 3               | Exponential 2s |
| `session-cleanup`           | `platform.session.cleanup` | `deferred`    | Repeating, every 1 hour                 | 3               | Exponential 2s |
| `key-rotation`              | `platform.key.rotation`    | `deferred`    | Repeating, every 5 minutes              | 3               | Exponential 2s |

Retry configuration and default job options are set on the queue factory in
`packages/shared/src/queue.ts`:

```typescript
defaultJobOptions: {
  removeOnComplete: { count: 200 },
  removeOnFail:     { count: 500 },
  attempts: 3,
  backoff:  { type: 'exponential', delay: 2000 },
}
```

## Handler details

### event-processing (`event.evaluate`)

**Source:** `apps/worker/src/handlers/event-processing.ts`

This handler performs the core detection pipeline for a single event:

1. Loads the normalized event row from PostgreSQL by `eventId`.
2. Constructs a `NormalizedEvent` struct and passes it to the `RuleEngine`.
3. The `RuleEngine` evaluates all active detection rules against the event using the registered
   evaluator map. Evaluators that use windowed counters (count, spike, sum) read and update state
   in Redis.
4. For each `AlertCandidate` returned by the engine:
   - Inserts a new row into the `alerts` table.
   - Updates `detections.lastTriggeredAt` to keep the database in sync, which serves as a
     fallback if Redis state is lost.
   - Enqueues an `alert.dispatch` job on the `alerts` queue.
5. Checks whether the organization has at least one active correlation rule. If so, enqueues a
   `correlation.evaluate` job for the same event ID. This guard prevents unnecessary queue
   churn for organizations that have no correlation rules configured.

All alert inserts for a single event are wrapped in a database transaction. If any insert fails,
the entire batch rolls back so that a retry does not see a partially committed set of alerts.
Alert dispatch jobs are enqueued outside the transaction to avoid rolling back queue writes.
The `onConflictDoNothing` clause on the insert relies on the `uq_alerts_event_detection_rule`
unique constraint for deduplication, replacing the previous racy SELECT-before-INSERT pattern.

### correlation-evaluate (`correlation.evaluate`)

**Source:** `apps/worker/src/handlers/correlation-evaluate.ts`

This handler runs correlation rule evaluation after an event has been ingested:

1. Loads the event from PostgreSQL.
2. Constructs a `NormalizedEvent` and passes it to the `CorrelationEngine`.
3. The `CorrelationEngine` evaluates all active correlation rules. Rule state (sequence progress,
   aggregation counters, absence timers) is maintained in Redis using keys prefixed
   `sentinel:corr:*`.
4. For each `CorrelatedAlertCandidate` produced:
   - Inserts an alert row with `triggerType = 'correlated'`. The `detectionId` and `ruleId`
     columns are `null` for correlated alerts; the correlation rule ID is stored in
     `triggerData.correlationRuleId`.
   - Updates `correlationRules.lastTriggeredAt`.
   - Enqueues an `alert.dispatch` job.

This handler runs on the same `events` queue as `event.evaluate`, so it shares the same
concurrency pool and Redis connection.

### correlation-expiry (`correlation.expiry`)

**Source:** `apps/worker/src/handlers/correlation-expiry.ts`

This handler finds expired absence-pattern correlation instances and fires alerts when the
expected follow-up event was never observed within the grace period. It uses a two-tier
lookup strategy:

**Primary path (sorted set index):** The handler calls `ZRANGEBYSCORE` on the
`sentinel:corr:absence:index` sorted set to retrieve up to 500 keys whose `expiresAt`
timestamp is at or before the current time. This is O(log N + M) and handles the
steady-state case efficiently.

**Fallback path (SCAN):** Every 30 minutes, the handler runs a `SCAN` over keys matching
`sentinel:corr:absence:*` to catch any keys written before the sorted set index was deployed.
Found keys are re-indexed into the sorted set for future sweeps. The SCAN is capped at 1,000
iterations to prevent monopolizing the deferred queue.

For each expired key:

1. Acquires a per-key processing lock (30 s TTL) to prevent duplicate processing across
   worker replicas.
2. Deserializes the `CorrelationInstance` payload and skips instances not yet expired.
3. Loads the correlation rule from PostgreSQL. If the rule has been deleted or paused, deletes
   the Redis key and index entry.
4. Constructs a human-readable absence alert with the expected event description and observed
   trigger details.
5. Inserts the absence alert into PostgreSQL first. Only after a successful insert does it
   delete the Redis key and index entry. If the insert fails, the key survives for the next
   sweep, and a `retryCount` is incremented inside the serialized instance for monitoring.
6. Updates `correlationRules.lastTriggeredAt` and enqueues `alert.dispatch`.

This job runs every 5 minutes on the `deferred` queue with job ID `correlation-expiry-sweep`.

### alert-dispatch (`alert.dispatch`)

**Source:** `apps/worker/src/handlers/alert-dispatch.ts`

This handler delivers notifications for a triggered alert to all configured channels:

1. Loads the alert and its associated detection from PostgreSQL.
2. Reads `detection.channelIds` (an array of `notification_channels` row IDs) and queries
   the enabled, non-deleted channel rows.
3. If the detection has a `slackChannelId`, looks up the Slack bot token from
   `slack_installations` and decrypts it with AES-256-GCM.
4. Checks `notification_deliveries` for channels already marked `sent` on a previous attempt
   (idempotent retry: already-sent channels are skipped).
5. Resolves the module-specific `formatSlackBlocks` formatter if the source module registered
   one at startup via `setModuleFormatters`.
6. Calls `dispatchAlert` from `@sentinel/notifications`, which routes the payload to the
   appropriate delivery function (Slack, email, or webhook).
7. Updates `alerts.notificationStatus` (`sent`, `partial`, `failed`, or `no_channels`) and
   writes per-channel `notification_deliveries` rows with response time and any error details.

If **all** channels fail, `dispatchAlert` throws an error, which causes BullMQ to retry the job
according to the configured backoff policy. Partially successful dispatches do not trigger a
retry; the `partial` status is recorded and the successfully-sent channels are not re-attempted.

### data-retention (`platform.data.retention`)

**Source:** `apps/worker/src/handlers/data-retention.ts`

This handler purges old records from platform tables according to configurable retention
policies. It runs daily at 00:00 (relative to when the worker started) via the `deferred` queue.

Default policies:

| Table                     | Timestamp column | Retention |
|---------------------------|------------------|-----------|
| `events`                  | `received_at`    | 90 days   |
| `alerts`                  | `created_at`     | 365 days  |
| `notification_deliveries` | `created_at`     | 30 days   |

Module-specific policies (for example, the AWS module retains `aws_raw_events` for 7 days and
platform events from the AWS module for 14 days) are appended to the default list at startup.

Each policy is executed in batches of 1,000 rows in a loop until fewer than 1,000 rows are
deleted in a single batch, preventing long-held locks. Optional `filter` expressions on policies
are validated against an allowlist at execution time to prevent SQL injection if the Redis-backed
job payload is ever tampered with.

### poll-sweep (`registry.poll-sweep`)

**Source:** `apps/worker/src/handlers/poll-sweep.ts`

This handler queries all enabled registry artifacts whose `lastPolledAt` is either `NULL` or
has exceeded the artifact's configured `pollIntervalSeconds`. For each due artifact, it enqueues
a `registry.poll` job on the `module-jobs` queue with `jobId: poll-${artifact.id}`. BullMQ
deduplicates by `jobId`, so a slow-running poll does not queue a second concurrent poll for the
same artifact.

The poll-sweep runs every 60 seconds and acts as the dispatch layer for the registry polling
subsystem. The actual polling (fetching tags from Docker Hub or npm) is performed by the
`registry.poll` handler registered by `@sentinel/module-registry`.

### session-cleanup (`platform.session.cleanup`)

**Source:** `apps/worker/src/handlers/session-cleanup.ts`

This handler issues a batched SQL statement that deletes up to 1,000 expired sessions per
execution:

```sql
DELETE FROM sessions WHERE sid IN (
  SELECT sid FROM sessions WHERE expire < now() LIMIT 1000
)
```

It runs every hour on the `deferred` queue and removes expired server-side sessions from
PostgreSQL. The row count is logged when at least one row is deleted. If the full 1,000-row
limit is hit, a warning is logged indicating that additional expired rows may remain until
the next scheduled run.

### key-rotation (`platform.key.rotation`)

**Source:** `apps/worker/src/handlers/key-rotation.ts`

This handler re-encrypts database rows that carry stale ciphertext when an `ENCRYPTION_KEY`
rotation is in progress. It runs every 5 minutes.

The handler iterates over a fixed list of encrypted columns:

| Table                        | Column                      |
|------------------------------|-----------------------------|
| `organizations`              | `inviteSecretEncrypted`     |
| `organizations`              | `webhookSecretEncrypted`    |
| `slack_installations`        | `botToken`                  |
| `github_installations`       | `webhookSecretEncrypted`    |
| `rc_artifacts`               | `credentialsEncrypted`      |
| `infra_cdn_provider_configs` | `encryptedCredentials`      |
| `aws_integrations`           | `credentialsEncrypted`      |

For each column, it selects up to 100 rows where the column is non-null and calls
`needsReEncrypt` (which inspects the ciphertext version prefix). Rows that are already
current-key ciphertext are skipped. Rows that need re-encryption are decrypted with the
previous key (from `ENCRYPTION_KEY_PREV`) and re-encrypted with `ENCRYPTION_KEY`.

Sessions are handled separately: the handler also re-encrypts `sessions.sess` rows, including
migrating any legacy plaintext session payloads to the encrypted format.

If a single row fails to decrypt (for example, due to key mismatch), the error is logged at
`warn` level and that row is skipped. The job does not fail for partial rotation errors.

## Worker scaling

The worker process is stateless with respect to job routing. All coordination state is stored
in Redis (BullMQ queue metadata) and PostgreSQL (event, alert, and correlation rule data).

- **Horizontal scaling**: Multiple worker replicas can run simultaneously. BullMQ distributes
  jobs across all workers listening on the same queue, providing horizontal throughput scaling.
  The Docker Compose configuration runs 2 worker replicas by default.
- **Scheduled jobs**: BullMQ repeatable jobs are stored in Redis and deduped by `jobId`. If
  multiple worker replicas are running, only one worker will pick up each scheduled job
  execution. No additional coordination is required. On startup, the worker removes and
  re-adds the `daily-retention` repeatable job to ensure that updated retention policies
  (which may include newly registered or removed module policies) take effect after each
  deploy. BullMQ does not update an existing repeatable job's payload on re-add.
- **Redis dependency**: All workers must share the same Redis instance. Windowed evaluators
  (windowed count, spike, sum) store their counters in Redis; running workers against separate
  Redis instances would produce incorrect evaluation results.

## Graceful shutdown

The worker listens for `SIGTERM` and `SIGINT`. On receipt:

1. Calls `worker.close()` on all active BullMQ workers, which waits for in-progress jobs to
   complete before stopping acceptance of new jobs.
2. Closes all BullMQ queue handles with `closeAllQueues()`.
3. Disconnects from Redis with `redis.quit()`.
4. Closes the PostgreSQL connection pool with `closeDb()`.

This ensures that Kubernetes rolling deploys and Docker Compose restarts do not interrupt
in-flight job processing.
