# Common issues

This page covers frequently encountered problems in Sentinel and the steps to resolve them. Each issue follows a problem, cause, solution format.

---

## Cannot log in

### Account locked out

**Problem:** You see the message "Account temporarily locked. Try again later." when attempting to sign in.

**Cause:** Sentinel locks an account after five consecutive failed login attempts. The lockout lasts 15 minutes and protects against brute-force credential attacks.

**Solution:** Wait 15 minutes and try again. After a successful login, the failed attempt counter resets automatically. If you continue to be locked out, confirm you are using the correct username or email address and password. Passwords are case-sensitive.

### Session expired

**Problem:** You were previously signed in but are now redirected to the login page.

**Cause:** Sentinel sessions have a maximum age of 7 days. Sessions are stored in PostgreSQL with an expiration timestamp. When the session expires, the API no longer recognizes your cookie and redirects you to sign in again.

**Solution:** Sign in again to create a new session. This is expected behavior. If sessions expire sooner than expected, see the "Session expired unexpectedly" section later on this page.

### Wrong credentials

**Problem:** You enter your username and password but receive an "Invalid credentials" error.

**Cause:** Either the username, email address, or password you entered does not match what is stored in Sentinel.

**Solution:** Sentinel accepts either your username or your email address in the login field. Confirm you are using the correct identifier. If you have forgotten your password, ask an organization administrator to reset it. Check that your keyboard is not in a different input mode (for example, Caps Lock enabled).

### API service not running

**Problem:** The login page shows a network error or the request times out.

**Cause:** The Sentinel API service is not running or is unreachable from your browser.

**Solution:** On the Sentinel host, run:

```
docker compose ps
```

The `api` service should show a status of `Up`. If it is stopped or restarting, check the API logs:

```
docker compose logs api --tail=50
```

Common causes include a missing environment variable (`DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, or `ENCRYPTION_KEY`) or a database that is unreachable. Resolve the underlying error and restart the service with `docker compose up -d api`.

---

## Detections not firing

### Detection is paused or disabled

**Problem:** An event occurred that should have triggered a detection, but no alert was created.

**Cause:** The detection or one of its rules has a status other than `active`. The rule engine only loads rules where both the detection and the rule have `status = 'active'`.

**Solution:** Open the detection in the Sentinel dashboard and confirm its status is **Active**. If it is **Paused**, click **Activate** to re-enable it. Also check that each rule within the detection has an active status.

### Detection is in cooldown

**Problem:** The detection triggered previously but is not triggering again for matching events.

**Cause:** The detection has a cooldown period configured. After a detection fires, a cooldown lock is set in Redis (with a database fallback) for the configured number of minutes. During this period, subsequent matching events are received but do not generate new alerts. The cooldown is scoped per rule and optionally per resource ID, so one rule firing does not block a different rule under the same detection.

**Solution:** Check the detection detail page for the **Cooldown** setting and the **Last triggered** timestamp. Wait for the cooldown period to elapse, or reduce the cooldown value if the current setting is too aggressive. A cooldown of 0 disables the feature entirely.

### No matching events

**Problem:** You expect the detection to fire, but no events of the relevant type have been ingested.

**Cause:** The detection evaluates events that arrive in the system. If no events match the detection's module and event type, the detection has nothing to evaluate.

**Solution:** Navigate to the **Events** view for the relevant module and search for events around the expected time. If no events are present, the issue is with event ingestion rather than detection evaluation. See the "Events not appearing" section on this page.

### Resource filter too narrow

**Problem:** Events are arriving and the detection is active, but the detection does not trigger for events you expect it to match.

**Cause:** The detection or its rules have a resource filter or host scope configured that excludes the resource in question. The rule engine checks two filter layers:

1. **Detection-level host scope** (`config.hostScope`): a list of glob patterns that the event's `resourceId` must match.
2. **Rule-level resource filter** (`config.resourceFilter`): include and exclude glob patterns. Exclude patterns take precedence over include patterns.

If the event's resource ID does not match the include patterns, or matches an exclude pattern, the rule is skipped.

**Solution:** Open the detection and examine the host scope and resource filter settings. Confirm that the `resourceId` value on the incoming event (visible in the event payload in the Events view) matches the configured patterns. Use wildcard patterns such as `*` or `org/*` to broaden the scope. Remove overly specific patterns that unintentionally exclude legitimate events.

### Evaluator not registered

**Problem:** The worker logs contain entries with the message `No handler for job` or the rule is silently skipped during evaluation.

**Cause:** The rule references a `moduleId:ruleType` combination for which no evaluator is registered in the worker. This can happen if a module was removed from the worker configuration or if a rule was created with an invalid rule type.

**Solution:** Check the worker startup logs for `Registered evaluator` entries and confirm that the expected evaluator key (for example, `github:branch-protection` or `registry:digest-change`) appears in the list. If the evaluator is missing, verify that the module is included in the worker's module array and that the module exports the evaluator.

---

## Alerts not being delivered

### Notification channel misconfigured

**Problem:** Alerts are created (visible in the dashboard) but no notifications are sent to the expected channel.

**Cause:** The detection's notification channel configuration is incorrect. The detection may reference a channel ID that no longer exists, or the channel may not have the required configuration (for example, a Slack channel name or a webhook URL).

**Solution:** Open the detection and confirm it has at least one notification channel assigned. Then navigate to **Settings** and verify that the channel exists and has valid configuration. For Slack channels, confirm the channel name matches an existing Slack channel. For webhook channels, confirm the URL is reachable.

### Slack bot token expired or revoked

**Problem:** Slack notifications were working previously but have stopped. The worker logs show errors such as `token_revoked` or `invalid_auth`.

**Cause:** The Slack OAuth token that Sentinel uses to post messages has been revoked or expired. This can happen when a Slack workspace administrator removes the Sentinel app from Slack, or when the OAuth token is rotated.

**Solution:** In Sentinel, navigate to **Settings > Slack**. If the integration shows as disconnected, click **Connect to Slack** and complete the OAuth flow to issue a new bot token. In Slack, confirm the Sentinel app is still installed under **Settings & administration > Manage apps**.

### Webhook URL unreachable

**Problem:** Notifications to a webhook channel are failing. The notification delivery record shows a connection error or a non-2xx HTTP status code.

**Cause:** The webhook URL configured in the notification channel is unreachable from the Sentinel worker service. This can be caused by a DNS resolution failure, a firewall rule blocking egress, or the target server being down.

**Solution:** Check the `notification_deliveries` table or the **Notification Deliveries** page in the dashboard for the specific error. Test the webhook URL independently:

```
curl -X POST <webhook-url> -H "Content-Type: application/json" -d '{"test": true}'
```

Confirm the URL is correct, the target server is running, and the Sentinel worker container can reach it over the network. If the worker runs on the `shared-infra` Docker network, the target must be reachable from that network.

### Email delivery failing

**Problem:** Email notifications are not arriving. The notification delivery record shows an SMTP error.

**Cause:** The SMTP connection string (`SMTP_URL` environment variable) is not configured, is incorrect, or the SMTP server is rejecting connections.

**Solution:** Confirm that `SMTP_URL` is set in your deployment environment. Verify the SMTP server accepts connections from the Sentinel host. Check the worker logs for SMTP-related errors. The sender address defaults to `alerts@sentinel.dev` and can be changed with the `SMTP_FROM` environment variable.

---

## Rate limited (429 errors)

### Read endpoint rate limited

**Problem:** You receive a `429 Too Many Requests` response when making GET requests to the Sentinel API.

**Cause:** Sentinel enforces a rate limit of 100 GET requests per minute per identity. The identity is determined in the following priority order: authenticated user ID, API key prefix, or client IP address.

**Solution:** Reduce the frequency of your requests. The API returns rate limit headers on every response:

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Maximum requests allowed in the current window |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the window resets |

Wait until `X-RateLimit-Reset` before retrying. If you are making unauthenticated requests from behind a shared NAT or proxy, multiple users may share the same IP-based rate limit. Authenticate with an API key or session to receive a dedicated rate limit bucket.

### Write endpoint rate limited

**Problem:** You receive a `429 Too Many Requests` response when making POST, PUT, PATCH, or DELETE requests.

**Cause:** Sentinel enforces a rate limit of 30 write requests per minute per identity.

**Solution:** Reduce the frequency of write operations. Batch changes where possible. The rate limit headers described above apply to write requests as well.

### Authentication endpoint rate limited

**Problem:** You receive a `429 Too Many Requests` response on the login or registration endpoint.

**Cause:** Sentinel enforces a rate limit of 10 authentication attempts per 15 minutes per identity. This limit is deliberately low to protect against credential stuffing attacks.

**Solution:** Wait 15 minutes for the rate limit window to reset. If you are running automated tests, set the `DISABLE_RATE_LIMIT=true` environment variable in your test environment only. Do not disable rate limiting in production.

---

## Events not appearing

### Webhook not configured in the source system

**Problem:** No events appear in the Sentinel Events view for a module that uses webhook-based delivery (for example, GitHub).

**Cause:** The external system has not been configured to send webhooks to Sentinel. Without inbound webhook requests, Sentinel has no events to process.

**Solution:** Configure the external system to send webhooks to your Sentinel instance. For the GitHub module, navigate to your GitHub App settings and set the webhook URL to `https://<your-sentinel-host>/modules/github/webhooks/events`. Confirm the webhook secret matches the value configured in Sentinel under **Settings > Webhook**.

### Webhook signature mismatch

**Problem:** The external system reports failed webhook deliveries (for example, GitHub shows red X status in Recent Deliveries), and Sentinel returns a `401` response.

**Cause:** The webhook secret configured in Sentinel does not match the secret configured in the external system. Sentinel rejects all payloads with invalid HMAC signatures.

**Solution:** In Sentinel, navigate to **Settings > Webhook** and note the configured secret. In the external system, update the webhook secret to match. After updating, redeliver a recent failed webhook from the external system to confirm the fix.

### Polling delay for polled modules

**Problem:** Events from a polled module (Registry, AWS, Chain) appear with a delay.

**Cause:** Some modules use polling rather than webhooks to ingest events. Polling intervals are:

| Module | Poll interval |
|---|---|
| Registry (npm) | Every 60 seconds |
| AWS (SQS) | Every 60 seconds |
| Chain (block poller) | Configured per network |

Events are not available until the next poll cycle completes.

**Solution:** Wait for the next polling cycle. If events are consistently delayed beyond the expected interval, check the worker logs for polling errors:

```
docker compose logs worker --tail=200 | grep "poll"
```

Confirm the worker service is running and that the module's polling job is scheduled. Polling jobs are registered as BullMQ repeatable jobs at worker startup.

### Module not connected

**Problem:** A module is listed in Sentinel but no events are ingested.

**Cause:** The module's integration credentials are missing or invalid. For example, the GitHub module requires `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_WEBHOOK_SECRET` environment variables. The Chain module requires at least one RPC endpoint configured for a network.

**Solution:** Navigate to **Settings > Integrations** and confirm the module's integration is connected. For modules that require environment variables, check that all required variables are set in your deployment. The API and worker services log a warning at startup if a module's optional credentials are not configured.

---

## Correlation rules not triggering

### Correlation window too short

**Problem:** A sequence or aggregation correlation rule is not triggering, even though matching events are arriving.

**Cause:** The `windowMinutes` setting on the correlation rule is shorter than the time span between the events that should match. For sequence rules, all steps must complete within the window. For aggregation rules, the threshold count must be reached within the window. When the window expires, in-flight correlation state is discarded.

**Solution:** Open the correlation rule and increase the **Window** setting. Review the timestamps on the events you expect to correlate and confirm they fall within the configured window. For aggregation rules, also confirm the event arrival rate is sufficient to reach the threshold before the window expires.

### Correlation key fields not matching

**Problem:** Events are arriving and match the event filters, but the correlation engine does not link them into the same sequence or aggregation bucket.

**Cause:** The correlation engine groups events by computing a SHA-256 hash of the correlation key field values extracted from each event's payload. If any required correlation key field is missing from an event, or if the field values differ between events that should correlate, the events are placed in separate buckets.

**Solution:** Open the correlation rule and check the **Correlation Key** fields. For each field, verify that the corresponding payload path exists in every event you expect to correlate. Navigate to the Events view, open the event detail, and confirm the payload contains the expected field at the expected path. Field paths are case-sensitive and use dot notation (for example, `repository.full_name`).

### Cross-step conditions failing

**Problem:** A sequence correlation rule advances through the first step but does not advance to the next step, even though the expected event type arrives.

**Cause:** The step has `matchConditions` configured that compare fields in the current event against fields captured from a previous step. If these cross-step conditions do not pass, the step is not matched. Common causes include field name typos, type mismatches (for example, comparing a number to a string), and events from different actors.

**Solution:** Open the correlation rule and examine the match conditions on the failing step. Each condition specifies a `field` (on the current event), an `operator` (`==` or `!=`), and a `ref` (a reference to a previous step's captured field). Confirm the field paths and expected values are correct by inspecting the event payloads in the Events view.

### Absence rule not configured correctly

**Problem:** You configured an absence correlation rule, but it never fires.

**Cause:** Absence rules require three components to be configured correctly:

1. A **trigger event filter** that starts the absence timer when a matching event arrives.
2. An **expected event filter** that, when matched, cancels the absence timer.
3. A **grace period** (`graceMinutes`) that defines how long to wait for the expected event.

The rule fires only if the trigger event arrives, the grace period elapses, and no expected event cancels the timer. If the trigger filter does not match incoming events, no timer is started.

**Solution:** Open the correlation rule and verify the trigger event filter matches the event type and conditions you expect. Test by checking the Events view for events that should match the trigger filter. Then confirm the grace period is long enough for real-world conditions but short enough to be meaningful. The absence expiry sweep runs every 5 minutes, so the actual alert may arrive up to 5 minutes after the grace period ends.

### Correlation rule cache stale after edit

**Problem:** You updated a correlation rule, but the old configuration still appears to be in effect.

**Cause:** The correlation engine caches loaded rules in memory for up to 30 seconds per organization. After a rule CRUD operation, the cache is invalidated on the API process that handled the request, but other worker processes may continue to use the cached version until the TTL expires.

**Solution:** Wait up to 30 seconds for the cache to refresh. If the issue persists, restart the worker service:

```
docker compose restart worker
```

---

## High memory usage

### Redis memory pressure

**Problem:** The Redis instance is consuming more memory than expected, or Redis is returning `OOM` errors.

**Cause:** Sentinel stores several types of data in Redis:

- BullMQ job queues and job metadata (completed jobs are retained: 200 per queue for completed, 500 for failed)
- Rate limit counters (one key per identity per rate limit tier, with 1-minute or 15-minute TTLs)
- Cooldown locks (one key per detection/rule/resource combination, TTL matches cooldown period)
- Correlation state (sequence instances, aggregation counters, absence timers)

If many detections have long cooldown periods, or if correlation rules create many in-flight instances, Redis memory usage can grow.

**Solution:** Monitor Redis memory usage with:

```
docker compose exec redis redis-cli INFO memory
```

To reduce memory usage:

1. Reduce the `removeOnComplete` and `removeOnFail` counts in BullMQ job options if you do not need to retain job history.
2. Reduce cooldown periods on detections to lower the number of active cooldown keys.
3. Reduce correlation rule window durations to limit how long in-flight state persists.
4. Configure Redis `maxmemory` and `maxmemory-policy` to cap usage and evict keys if necessary.

### PostgreSQL connection exhaustion

**Problem:** The API or worker logs show errors such as "too many connections" or "connection pool exhausted."

**Cause:** The worker initializes a database connection pool with a maximum of 50 connections to support concurrent BullMQ job processing. The API uses the default pool size. If both the API and multiple worker replicas (the production configuration runs 2 replicas) are running, the total connection count can approach the PostgreSQL `max_connections` limit.

**Solution:** Check the current PostgreSQL connection count:

```
docker compose exec postgres psql -U sentinel -c "SELECT count(*) FROM pg_stat_activity;"
```

If the count is near the limit, either increase `max_connections` in the PostgreSQL configuration or reduce the worker pool size. On a shared Hetzner VPS with limited resources, keep total connections below 80. Each worker replica uses up to 50 connections, and the API uses its default pool.

---

## Worker jobs stuck

### BullMQ stalled jobs

**Problem:** Jobs are visible in the queue but are not being processed. The worker logs show no new `Job completed` entries.

**Cause:** BullMQ marks a job as "stalled" if the worker holding the job does not report progress within the stall interval. This can happen if the worker process crashed without cleanly closing its BullMQ connections, leaving jobs in a claimed-but-unprocessed state. It can also occur if a single job takes an exceptionally long time (for example, a slow external API call during alert dispatch).

**Solution:** BullMQ automatically retries stalled jobs up to the configured attempt limit (3 attempts with exponential backoff starting at 2 seconds). Check the worker logs for `Job failed` entries to see if stalled jobs are being retried. If jobs remain stuck:

1. Restart the worker service to force BullMQ to reclaim stalled jobs:

   ```
   docker compose restart worker
   ```

2. Inspect the queue directly in Redis:

   ```
   docker compose exec redis redis-cli llen bull:events:wait
   docker compose exec redis redis-cli llen bull:events:active
   docker compose exec redis redis-cli llen bull:alerts:wait
   ```

   A non-zero `active` count with no corresponding worker activity indicates stalled jobs.

### Redis connection issues

**Problem:** The worker logs show `Redis connection refused` or `ECONNRESET` errors, and no jobs are being processed.

**Cause:** The worker cannot connect to Redis. Each BullMQ worker creates its own dedicated Redis connection (via the connection factory) to avoid head-of-line blocking. If Redis is down, restarting, or has reached its connection limit, all workers stall.

**Solution:** Check that Redis is running:

```
docker compose ps redis
docker compose logs redis --tail=20
```

If Redis is healthy, check the `REDIS_URL` environment variable in the worker's environment. For production, use `rediss://` (with TLS) and ensure the Redis password is included in the URL. After resolving the connectivity issue, restart the worker:

```
docker compose restart worker
```

### Job retry exhaustion

**Problem:** Jobs fail repeatedly and eventually stop being retried. The worker logs show `Job failed` entries with `attemptsMade: 3`.

**Cause:** Each job is retried up to 3 times with exponential backoff (2 seconds, 4 seconds, 8 seconds). After 3 failed attempts, the job is moved to the failed set and is not retried again. The failed job is retained in Redis (up to 500 per queue) for inspection.

**Solution:** Check the worker logs for the specific error on each attempt. Common causes include:

- A misconfigured detection rule that causes the evaluator to throw an error
- An unreachable external service (Slack API, webhook URL, SMTP server) during alert dispatch
- A database query that fails due to a schema mismatch after a migration

Fix the underlying cause and, if needed, re-enqueue the job. For alert dispatch failures, you can re-trigger the alert from the Sentinel dashboard.

---

## Session expired unexpectedly

### Encryption key rotation

**Problem:** All users are logged out simultaneously and must sign in again.

**Cause:** Sentinel encrypts session data at rest using AES-256 with the `ENCRYPTION_KEY` environment variable. If the encryption key is changed without setting `ENCRYPTION_KEY_PREV` to the old key value, existing sessions cannot be decrypted and are treated as invalid. The session middleware returns `null` from decryption, effectively logging out all users.

**Solution:** When rotating the encryption key:

1. Set `ENCRYPTION_KEY_PREV` to the current (old) key value.
2. Set `ENCRYPTION_KEY` to the new key value.
3. Restart the API and worker services.

The system uses `ENCRYPTION_KEY_PREV` as a decrypt-only fallback, so existing sessions remain valid. The key rotation worker job runs every 5 minutes and re-encrypts sessions with the new key. After all sessions have been re-encrypted, you can remove `ENCRYPTION_KEY_PREV`.

### Session TTL shorter than expected

**Problem:** Your session expires before the expected 7-day maximum age.

**Cause:** The session cookie has a `maxAge` of 7 days, and the database row has an `expire` timestamp set to 7 days from creation. However, the hourly session cleanup job deletes all sessions whose `expire` timestamp is in the past. If the server clock is skewed or if the session was created with a shorter-than-expected TTL due to a code issue, the session may be garbage-collected early.

**Solution:** Check the server clock synchronization:

```
date -u
```

Compare this with the actual UTC time. If the clock is skewed, synchronize it using NTP. Also check the worker logs for `platform.session.cleanup` job completions to verify that the cleanup job is not deleting sessions prematurely.

---

## Health check failures

### API health check returning 503

**Problem:** The API health check endpoint (`GET /health`) returns a `503` status with `"status": "degraded"`.

**Cause:** The health check verifies both the PostgreSQL database (via `SELECT 1`) and Redis (via `PING`). If either check fails, the endpoint returns a `503` with the failing component marked as `"error"` in the response body:

```json
{"status": "degraded", "db": "ok", "redis": "error", "timestamp": "2026-03-28T12:00:00.000Z"}
```

**Solution:** Inspect the response body to identify which component is failing. Then check the corresponding service:

- For `"db": "error"`: Check PostgreSQL connectivity with `docker compose logs postgres --tail=20`.
- For `"redis": "error"`: Check Redis connectivity with `docker compose logs redis --tail=20`.

The Docker health check for the API container uses `wget --spider http://localhost:4100/health` with a 5-second timeout. If the health check fails 3 consecutive times (at 15-second intervals, after a 10-second start period), Docker marks the container as unhealthy and may restart it depending on the restart policy.
