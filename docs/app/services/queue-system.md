# Queue System

Sentinel uses [BullMQ 5](https://docs.bullmq.io/) as its job queue layer, backed by Redis 7.
All queue and job-type definitions live in `packages/shared/src/queue.ts`, which is the single
source of truth consumed by the API, the worker, and all feature modules.

## Queue names

```typescript
// packages/shared/src/queue.ts
export const QUEUE_NAMES = {
  EVENTS:      'events',       // normalized events → rule evaluation
  ALERTS:      'alerts',       // alert candidates → notification dispatch
  MODULE_JOBS: 'module-jobs',  // module-specific work (webhook processing, polling, etc.)
  DEFERRED:    'deferred',     // deferred/scheduled evaluation
} as const;
```

| Queue name    | Constant                  | Purpose                                                                 |
|---------------|---------------------------|-------------------------------------------------------------------------|
| `events`      | `QUEUE_NAMES.EVENTS`      | Accepts normalized platform events for rule evaluation and correlation  |
| `alerts`      | `QUEUE_NAMES.ALERTS`      | Routes triggered alert candidates to notification channels              |
| `module-jobs` | `QUEUE_NAMES.MODULE_JOBS` | Module-specific processing: blockchain polling, registry polling, AWS SQS polling, webhook handling |
| `deferred`    | `QUEUE_NAMES.DEFERRED`    | Scheduled platform maintenance jobs: retention, session cleanup, key rotation, correlation expiry |

## Job type definitions

All job types use the `JobHandler` interface:

```typescript
export interface JobHandler {
  /** Job name — used as queue.add(jobName, data) */
  readonly jobName: string;

  /** Which queue this handler listens on */
  readonly queueName: string;

  /** Process the job */
  process(job: Job): Promise<void>;
}
```

The worker dispatches incoming jobs to handlers by matching `job.name` against the `jobName`
of all handlers registered for that queue. If no handler is found, the job fails immediately
with an unhandled error.

### Core job types by queue

**`events` queue**

| Job name               | Payload fields | Description                                    |
|------------------------|----------------|------------------------------------------------|
| `event.evaluate`       | `eventId: string` | Load event, run RuleEngine, create alerts   |
| `correlation.evaluate` | `eventId: string` | Load event, run CorrelationEngine          |

**`alerts` queue**

| Job name         | Payload fields   | Description                                              |
|------------------|------------------|----------------------------------------------------------|
| `alert.dispatch` | `alertId: string` | Load alert, dispatch to Slack/email/webhook channels    |

**`module-jobs` queue**

| Job name                   | Source module | Description                                                 |
|----------------------------|---------------|-------------------------------------------------------------|
| `registry.poll-sweep`      | Core worker   | Query due registry artifacts and enqueue `registry.poll`    |
| `registry.poll`            | Registry      | Fetch artifact tags from Docker Hub / npm registry          |
| `registry.verify`          | Registry      | Verify Sigstore signatures and provenance for an artifact version |
| `chain.block-poll`         | Chain         | Fetch new blocks from the EVM RPC node                      |
| `chain.block-process`      | Chain         | Decode block transactions and emit normalized events        |
| `chain.state-poll`         | Chain         | Poll contract state variables                               |
| `chain.rule-sync`          | Chain         | Sync active chain detection rules                           |
| `chain.contract-verify`    | Chain         | Verify contract source via Etherscan                        |
| `chain.rpc-usage.flush`    | Chain         | Flush RPC call usage counters to persistent storage         |
| `chain.block-aggregate`    | Chain         | Aggregate block-level metrics                               |
| `aws.poll-sweep`           | AWS           | Query due AWS integrations and enqueue `aws.sqs.poll`       |
| `aws.sqs.poll`             | AWS           | Poll an SQS queue for CloudTrail event notifications        |
| `aws.event.process`        | AWS           | Parse raw CloudTrail event and promote to platform events   |

**`deferred` queue**

| Job name                      | Payload fields                     | Schedule           |
|-------------------------------|------------------------------------|--------------------|
| `platform.data.retention`     | `policies: RetentionPolicy[]`      | Every 24 hours     |
| `platform.session.cleanup`    | `{}`                               | Every 1 hour       |
| `platform.key.rotation`       | `{}`                               | Every 5 minutes    |
| `correlation.expiry`          | `{}`                               | Every 5 minutes    |

## Job lifecycle

BullMQ jobs move through the following states:

```
added → waiting → active → completed
                         ↘ failed → (retry) → waiting
                                  ↘ (max attempts reached) → failed (permanent)
```

1. **waiting**: The job is in the queue and has not been picked up by a worker.
2. **active**: A worker has dequeued the job and its `process()` function is executing.
3. **completed**: The `process()` function resolved without throwing.
4. **failed**: The `process()` function threw an error. BullMQ decrements the remaining
   attempt count. If attempts remain, the job moves to a delayed state before re-entering
   `waiting`. If no attempts remain, the job stays in the `failed` state.
5. **delayed**: The job is scheduled to become `waiting` after a backoff period.
6. **paused**: The queue has been administratively paused; jobs wait until the queue is resumed.

## Retry configuration

Default job options are applied at queue creation time:

```typescript
defaultJobOptions: {
  removeOnComplete: { count: 200 },   // retain last 200 completed jobs per queue
  removeOnFail:     { count: 500 },   // retain last 500 failed jobs per queue
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
}
```

The exponential backoff schedule for 3 attempts is:

| Attempt | Delay before retry |
|---------|--------------------|
| 1 → 2   | 2 seconds          |
| 2 → 3   | 4 seconds          |
| 3       | Job moves to failed state (no further retries) |

Individual handlers may override these defaults by passing custom options when calling
`queue.add()`. For example, scheduled repeatable jobs include a `jobId` to prevent duplicate
schedule registrations on worker restart.

## Dead-letter queue and failed job handling

BullMQ does not implement a dedicated dead-letter queue in the traditional sense. Jobs that
exhaust all retry attempts are retained in the `failed` state within the same queue, up to the
`removeOnFail.count` limit (500 by default). Once the limit is reached, the oldest failed jobs
are automatically pruned.

### Inspecting failed jobs

Use the BullMQ API directly or a dashboard tool (see [Monitoring](#monitoring)):

```typescript
import { Queue } from 'bullmq';

const queue = new Queue('events', { connection: redis });
const failedJobs = await queue.getFailed(0, 49); // first 50 failed jobs
for (const job of failedJobs) {
  console.log(job.name, job.data, job.failedReason, job.attemptsMade);
}
```

### Retrying failed jobs

To retry all failed jobs on a queue:

```typescript
const failedJobs = await queue.getFailed();
for (const job of failedJobs) {
  await job.retry();
}
```

To retry a specific job by ID:

```typescript
const job = await queue.getJob(jobId);
await job?.retry();
```

**Important**: Before retrying a failed `alert.dispatch` job, verify that the root cause
(for example, invalid Slack credentials or unreachable SMTP server) has been resolved. The
handler implements idempotent delivery using the `notification_deliveries` table, so channels
that already succeeded on a previous attempt are skipped automatically on retry.

## Queue ordering guarantees

BullMQ uses a Redis `ZSET` for the waiting list, ordered by a monotonically increasing
timestamp. By default, jobs are consumed in FIFO order within a given queue. There is no
global ordering across queues.

Jobs with an explicit `priority` value (lower number = higher priority) are sorted ahead of
unprioritized jobs within the same queue. Sentinel does not currently assign custom priorities
to any job type; all jobs use the default priority (0).

## FlowProducer

`packages/shared/src/queue.ts` exports a `getFlowProducer()` factory that returns a shared
`FlowProducer` instance. This enables fan-out/fan-in pipelines where a parent job can spawn
child jobs and wait for their completion before being marked complete. The Chain module uses
this for block aggregation workflows.

## Monitoring

Sentinel does not bundle a BullMQ dashboard, but the following open-source tools are compatible
with BullMQ 5 and can connect to the same Redis instance:

| Tool             | Notes                                                          |
|------------------|----------------------------------------------------------------|
| [Bull Board](https://github.com/felixmosh/bull-board) | Express/Hono middleware; supports BullMQ |
| [Taskforce.sh](https://taskforce.sh) | Hosted SaaS dashboard for BullMQ       |
| Redis CLI        | Use `LLEN`, `ZCARD`, and `XLEN` commands to check queue depths |

To add Bull Board to the API server, install `@bull-board/hono` and mount the router on a
protected internal route. Do not expose the dashboard publicly without authentication.

## Redis connection configuration

The worker uses two connection strategies:

**Shared connection (Queue instances / producers):** A single `IORedis` connection is created
at startup and registered via `setSharedConnection()`. All `Queue` instances (used for
enqueuing jobs) share this connection.

```typescript
const redis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,   // required by BullMQ
  enableReadyCheck: false,      // allows connection before Redis is fully ready
});
setSharedConnection(redis);
```

**Connection factory (Worker instances / consumers):** Each BullMQ `Worker` receives its own
dedicated Redis connection, created by the factory registered via `setConnectionFactory()`.
This prevents head-of-line blocking: BullMQ workers use blocking commands like `BRPOPLPUSH`
to listen for jobs, and a slow consumer on one queue would stall job delivery to all other
queues if they shared a single connection.

```typescript
setConnectionFactory(() => new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
}));
```

The `maxRetriesPerRequest: null` setting is required by BullMQ — it disables the per-request
retry limit so that blocking commands can wait indefinitely without triggering an error.

All created `Worker` instances are tracked in a `Set` within the queue module so that
`closeAllQueues()` can close them and release their Redis connections during graceful shutdown.

For production deployments that use Redis Sentinel or Redis Cluster, replace `REDIS_URL` with
the appropriate connection string and ensure that the BullMQ `connection` option receives a
compatible `IORedis` instance. Redis Cluster support in BullMQ requires additional
configuration; refer to the [BullMQ documentation](https://docs.bullmq.io/bull/patterns/redis-cluster).
