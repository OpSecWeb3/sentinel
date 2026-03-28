# Log locations and diagnostic reference

This page describes where to find logs for each Sentinel service, how to interpret log output, and how to use logs to diagnose issues.

---

## Service log commands

Run these commands on the host where your Sentinel Docker Compose stack is deployed. All commands tail the log in real time; press **Ctrl+C** to stop.

### API service

The API service handles all HTTP requests from the web frontend, external integrations, and programmatic API clients. In production, the API runs on port 4100 inside the container.

```
docker compose -f docker-compose.prod.yml logs api --tail=100 -f
```

Use the API logs to investigate:

- Login failures and authentication errors
- Webhook signature verification failures
- RBAC permission denials (`401` and `403` responses)
- CSRF header enforcement (`Missing CSRF defense header: X-Sentinel-Request`)
- Rate limit rejections (`429` responses)
- Request-level errors and unexpected `500` responses

### Worker service

The worker service processes background jobs: event evaluation, alert dispatch, data retention, session cleanup, encryption key rotation, correlation expiry sweeps, and all module-specific polling tasks. In production, 2 worker replicas run by default.

```
docker compose -f docker-compose.prod.yml logs worker --tail=100 -f
```

To view logs from a specific worker replica:

```
docker compose -f docker-compose.prod.yml logs worker --tail=100 -f --index=1
```

Use the worker logs to investigate:

- Detection evaluation failures (`queue: "events"`, `jobName: "event.process"`)
- Alert notification dispatch errors (`queue: "alerts"`, `jobName: "alert.dispatch"`)
- Correlation engine errors (`component: "correlation-engine"`)
- Data retention job results (`jobName: "platform.data.retention"`)
- Session cleanup results (`jobName: "platform.session.cleanup"`)
- Key rotation activity (`jobName: "platform.key.rotation"`)
- Module polling errors (Registry, AWS, Chain)
- Sigstore verification failures (Registry module)
- Stalled or failed job retries

### Web service

The web service serves the Sentinel Next.js frontend. In production, the web service runs on port 3100 inside the container.

```
docker compose -f docker-compose.prod.yml logs web --tail=100 -f
```

The web service logs are typically less diagnostic than the API and worker logs. Check them if the frontend is not loading, returns build errors, or shows Next.js server-side rendering errors.

### PostgreSQL

```
docker compose logs postgres --tail=50
```

Use the PostgreSQL logs to investigate:

- Database connection issues and connection limit exhaustion
- Migration errors
- Query timeouts or lock contention
- Replication or disk space issues

### Redis

```
docker compose logs redis --tail=50
```

Use the Redis logs to investigate:

- Redis startup and initialization errors
- Memory pressure warnings (`OOM` errors, eviction events)
- Connection limit exhaustion
- Persistence (RDB/AOF) errors

---

## Log format

Sentinel uses [Pino](https://getpino.io/) for structured JSON logging across the API and worker services. Each log line is a single JSON object on one line.

Example API log line:

```json
{"level":30,"time":1711619200000,"service":"sentinel-api","requestId":"a1b2c3d4","msg":"POST /auth/login 200","method":"POST","path":"/auth/login","status":200,"durationMs":212}
```

Example worker log line:

```json
{"level":30,"time":1711619200000,"service":"sentinel-worker","queue":"events","jobName":"event.process","jobId":"42","msg":"Job completed"}
```

### Key fields

| Field | Description |
|---|---|
| `level` | Numeric log level: `10` = trace, `20` = debug, `30` = info, `40` = warn, `50` = error, `60` = fatal |
| `time` | Unix timestamp in milliseconds |
| `service` | The service that emitted the log: `sentinel-api` or `sentinel-worker` |
| `msg` | The human-readable log message |
| `requestId` | (API only) A unique identifier for the HTTP request. Use this to correlate all log lines from a single request. |
| `err` | Present on error logs. Contains `message`, `stack`, and sometimes additional error context. |
| `queue` | (Worker only) The BullMQ queue name: `events`, `alerts`, `module-jobs`, or `deferred`. |
| `jobName` | (Worker only) The specific job type being processed (for example, `event.process`, `alert.dispatch`, `platform.data.retention`). |
| `jobId` | (Worker only) The BullMQ job ID. |
| `component` | Present on some logs. The internal component that emitted the log (for example, `rule-engine`, `correlation-engine`, `data-retention`, `alert-dispatch`). |

---

## Log levels and what they mean

The `LOG_LEVEL` environment variable controls the minimum log level emitted by both the API and worker services. Set it in your `.env` file or deployment configuration.

| Value | Numeric | Description |
|---|---|---|
| `trace` | 10 | All log output including internal trace events. Extremely verbose; use only for deep debugging of specific issues. |
| `debug` | 20 | Debug-level messages including request details, job lifecycle events, cooldown checks, Redis operations, and cache hits/misses. |
| `info` | 30 | Standard operational messages: service startup, worker registration, job completion, scheduled task execution. **This is the recommended default for production.** |
| `warn` | 40 | Warnings and recoverable errors: legacy plaintext session detected, best-effort cleanup failure, stale cache entry. |
| `error` | 50 | Errors that indicate a failure: unhandled exceptions, job failures, evaluation errors, external API errors. |
| `fatal` | 60 | Fatal errors that cause the process to exit: missing required environment variables, database connection failure at startup. |

To change the log level without redeploying:

1. Update `LOG_LEVEL` in your environment configuration.
2. Restart the affected service:

   ```
   docker compose -f docker-compose.prod.yml restart api
   docker compose -f docker-compose.prod.yml restart worker
   ```

For temporary investigation, you can override the environment variable inline:

```
LOG_LEVEL=debug docker compose -f docker-compose.prod.yml up api
```

**Important:** Running at `debug` or `trace` in production generates high log volume and may affect performance. Use these levels only for targeted troubleshooting and revert to `info` afterward.

---

## Sentry error tracking

If your Sentinel deployment is configured with a Sentry DSN, unhandled errors in the API and worker services are automatically captured and sent to Sentry.

Set the Sentry DSN in your deployment environment:

```
SENTRY_DSN=https://your-key@sentry.io/project-id
SENTRY_ENVIRONMENT=production
```

Both the API and worker services initialize Sentry at startup using `initSentry()`. When an unhandled error occurs, it is captured with:

- A full stack trace
- The service name (`sentinel-api` or `sentinel-worker`)
- The environment name from `SENTRY_ENVIRONMENT` (falls back to `NODE_ENV` if not set)
- The request ID (for API errors)

The API's global error handler calls `captureException(err, { requestId })` for all non-HTTP errors, ensuring that Sentry captures the request context.

If `SENTRY_DSN` is not set, Sentry initialization is skipped and errors appear only in the local logs. Both services also call `setupGlobalHandlers(log)` to catch unhandled promise rejections and uncaught exceptions, logging them before the process exits.

---

## Health check endpoints

### API health check

The API exposes a `GET /health` endpoint that checks the liveness of both PostgreSQL and Redis.

```
curl http://localhost:4100/health
```

**Healthy response** (HTTP 200):

```json
{"status": "ok", "db": "ok", "redis": "ok", "timestamp": "2026-03-28T12:00:00.000Z"}
```

**Degraded response** (HTTP 503):

```json
{"status": "degraded", "db": "ok", "redis": "error", "timestamp": "2026-03-28T12:00:00.000Z"}
```

The health check performs:

1. A `SELECT 1` query against PostgreSQL to verify the database connection is alive.
2. A `PING` command against the shared Redis connection to verify Redis is responsive.

If either check fails, the endpoint returns HTTP 503 with the failing component marked as `"error"`.

The Docker health check for the API container is configured to probe this endpoint every 15 seconds with a 5-second timeout, 3 retries, and a 10-second start period:

```yaml
healthcheck:
  test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:4100/health"]
  interval: 15s
  timeout: 5s
  retries: 3
  start_period: 10s
```

### Web health check

The web service health check probes the root URL (`http://localhost:3100/`) with the same interval and retry configuration.

---

## Common log patterns and what they indicate

### Startup patterns

| Pattern | Service | Meaning |
|---|---|---|
| `Starting Sentinel API` with `port` field | API | The API service has started and is listening on the configured port. |
| `Starting Sentinel workers` | Worker | The worker service is initializing. |
| `Registered evaluator` with `evaluator` field | Worker | A module evaluator has been registered. One line appears per evaluator. |
| `Started worker` with `queue`, `concurrency`, `handlers` fields | Worker | A BullMQ worker has started consuming jobs from a queue. |
| `Removed stale daily-retention repeatable job` | Worker | The worker detected a stale repeatable job definition in Redis and replaced it with current configuration. This is normal after a deploy. |
| `Fatal error` | Worker | The worker encountered an unrecoverable error during startup and is exiting. Check the `err` field for the root cause. |

### Runtime patterns

| Pattern | Service | Meaning |
|---|---|---|
| `Job completed` with `queue` and `jobName` | Worker | A job was processed successfully. |
| `Job failed` with `queue`, `jobName`, and `err` | Worker | A job failed. BullMQ will retry up to 3 times with exponential backoff. |
| `Error evaluating rule` with `ruleId` | Worker | A specific rule evaluation threw an error. The detection continues evaluating other rules. |
| `Redis cooldown unavailable, using DB fallback` | Worker | The Redis cooldown check failed and the rule engine is falling back to the PostgreSQL-based cooldown. This typically indicates a transient Redis issue. |
| `session: decrypted legacy plaintext session` | API | A session was found that uses the old plaintext format instead of AES-256 encryption. This session will continue to work but should be re-encrypted by the key rotation job. |
| `Corrupted absence instance in Redis` | Worker | A correlation absence timer entry in Redis could not be parsed. The entry is deleted to prevent it from permanently blocking the rule. |
| `Absence timer cancelled` | Worker | An expected event arrived within the grace period, cancelling an absence alert. |
| `Health check: DB unreachable` / `Health check: Redis unreachable` | API | The `/health` endpoint detected a connectivity issue. Logged at `debug` level. |
| `Unhandled error` | API | An unexpected error occurred during request processing. The error is captured by Sentry (if configured) and the request receives a `500` response. |

### Shutdown patterns

| Pattern | Service | Meaning |
|---|---|---|
| `Shutting down` with `signal` field | Worker | The worker received a termination signal (SIGTERM or SIGINT) and is closing workers and connections. |
| `Shutdown complete` | Worker | All workers, queues, Redis connections, and database connections have been closed. |
| `Worker failed to close cleanly` with `err` | Worker | A BullMQ worker did not close within the expected time. In-flight jobs on that worker may need to be retried after restart. |

---

## Finding a specific request in the logs

Every HTTP request processed by the API is assigned a unique `requestId`. This ID appears in every log line emitted during that request, making it straightforward to trace the full lifecycle of a request across concurrent activity.

**To trace a specific request:**

1. Reproduce the failing request or note the approximate time it occurred.
2. Stream the API logs and filter by the request path or error message to identify the `requestId`:

   ```
   docker compose -f docker-compose.prod.yml logs api --tail=500 | grep "/auth/login"
   ```

3. Once you have the `requestId`, filter all log lines for that value:

   ```
   docker compose -f docker-compose.prod.yml logs api --tail=500 | grep "a1b2c3d4"
   ```

   Replace `a1b2c3d4` with the actual `requestId` value.

This shows the full sequence of operations for that request, including middleware processing, database queries, and any errors.

---

## Finding a specific job in the worker logs

Worker logs include `queue`, `jobName`, and `jobId` fields for every job-related entry.

**To trace a specific job:**

1. Filter by queue name to see all activity on a specific queue:

   ```
   docker compose -f docker-compose.prod.yml logs worker --tail=500 | grep '"queue":"events"'
   ```

2. Filter by job name to see a specific type of job:

   ```
   docker compose -f docker-compose.prod.yml logs worker --tail=500 | grep '"jobName":"alert.dispatch"'
   ```

3. If you have a specific job ID, filter directly:

   ```
   docker compose -f docker-compose.prod.yml logs worker --tail=500 | grep '"jobId":"42"'
   ```

---

## Quick diagnostic checklist

When investigating an issue, work through this checklist:

1. Check that all services are running: `docker compose -f docker-compose.prod.yml ps`
2. Check the API health endpoint: `curl http://localhost:4100/health`
3. Check the API logs for request-level errors: `docker compose -f docker-compose.prod.yml logs api --tail=100`
4. Check the worker logs for job failures: `docker compose -f docker-compose.prod.yml logs worker --tail=100`
5. Check Redis connectivity: `docker compose logs redis --tail=20`
6. Check PostgreSQL connectivity: `docker compose logs postgres --tail=20`
7. If errors are ambiguous, increase `LOG_LEVEL` to `debug` and reproduce the issue.
8. If Sentry is configured, check the Sentry dashboard for captured exceptions with full stack traces.
9. Revert `LOG_LEVEL` to `info` after investigation.
