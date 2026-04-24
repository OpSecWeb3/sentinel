# AWS retention + aws_raw_events collapse — runbook

Operational runbook for the two-deploy collapse of the AWS raw-events
table into the platform `events` table.

- **PR #1** (commit `cce3d4a`): `rowCount → count` retention bug fix,
  recursive `PayloadTree` on `/events`, `aws_raw_events` TTL 7d → 3d.
- **PR #2a** (commit `e43ecfc`): inlined CloudTrail ingestion straight
  into `events`, `eventProcessHandler` becomes a drain shim, all read
  paths rewired, Migration 0005 adds dedup unique index + GIN on
  `payload->'resources'`. Schema for `aws_raw_events` left in place.
- **PR #2b** (pending): drops the `aws_raw_events` table.

## Containers

- Redis: `shared-redis-1` (external, in `chainalert` compose, project `-p shared`)
- Postgres: `shared-postgres-1` (hosts multiple DBs; `POSTGRES_DB`
  defaults to `chainalert`, NOT sentinel's DB)
- Worker: `sentinel-worker-1` / `sentinel-worker-2` (replicas: 2)

## 0. Bootstrap — capture creds (run once per shell session)

`docker exec` does not inherit host env vars. Source the secrets from
the worker once and keep them in host shell vars; re-inject with
`-e VAR="$VAR"` on each `docker exec`.

```bash
export PW=$(docker exec sentinel-worker-1 sh -lc '
  node -e "const u=new URL(process.env.REDIS_URL); \
           process.stdout.write(decodeURIComponent(u.password||\"\"))"')
export DB_NAME=$(docker exec sentinel-worker-1 sh -lc '
  node -e "const u=new URL(process.env.DATABASE_URL); \
           process.stdout.write(u.pathname.replace(/^\//,\"\"))"')
export DB_USER=$(docker exec sentinel-worker-1 sh -lc '
  node -e "const u=new URL(process.env.DATABASE_URL); \
           process.stdout.write(decodeURIComponent(u.username||\"\"))"')
echo "redis-pw len: ${#PW}  db: $DB_NAME  user: $DB_USER"

# Sanity ping
docker exec -e PW="$PW" shared-redis-1 sh -lc \
  'redis-cli -a "$PW" --no-auth-warning PING'
```

## 1. PR #1 post-deploy verification — retention drains in one job

The handler used to read `rowCount` (pg-driver field) on a
postgres-js result that exposes `count`. `batchDeleted` was always 0,
the loop exited after one iteration, `Retention cleanup complete`
never logged. The fix at `apps/worker/src/handlers/data-retention.ts:313-314`
reads `count` first with a `rowCount` fallback for test compat.

Confirm by enqueueing one job and watching it drain a full backlog:

```bash
BEFORE=$(docker exec -e DB="$DB_NAME" -e DBU="$DB_USER" shared-postgres-1 sh -lc \
  'psql -U "$DBU" -d "$DB" -tAc "SELECT count(*) FROM events WHERE module_id='\''aws'\'';"' | tr -d ' ')
echo "before: $BEFORE"

docker exec -w /app/apps/worker sentinel-worker-1 node -e '
const { Queue } = require("bullmq");
const u = new URL(process.env.REDIS_URL);
const q = new Queue("deferred", { connection: {
  host: u.hostname, port: Number(u.port) || 6379,
  username: u.username || undefined,
  password: decodeURIComponent(u.password || "") || undefined,
  tls: u.protocol === "rediss:" ? {} : undefined,
}});
q.add("platform.data.retention", {
  policies: [{
    table: "events", timestampColumn: "received_at", retentionDays: 1,
    filter: "module_id = \x27aws\x27",
    preserveIf: [
      { kind: "referenced_by", table: "alerts", column: "event_id" },
      { kind: "within_correlation_window" }
    ]
  }]
}, { removeOnComplete: true, removeOnFail: 100 })
  .then(j => { console.log("enqueued", j.id); return q.close(); })
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
'

# Wait for the job to leave `active`, then check both replicas for the
# completion log (only fires when deleted > 0 — pre-fix it never fired).
for i in $(seq 1 60); do
  sleep 10
  ACTIVE=$(docker exec -e PW="$PW" shared-redis-1 sh -lc \
    'redis-cli -a "$PW" --no-auth-warning LLEN bull:deferred:active' | tr -d ' ')
  NOW=$(docker exec -e DB="$DB_NAME" -e DBU="$DB_USER" shared-postgres-1 sh -lc \
    'psql -U "$DBU" -d "$DB" -tAc "SELECT count(*) FROM events WHERE module_id='\''aws'\'';"' | tr -d ' ')
  echo "t+$((i*10))s rows=$NOW active=$ACTIVE"
  [ "$ACTIVE" = "0" ] && break
done

docker logs sentinel-worker-1 --since 10m 2>&1 | grep -i 'Retention cleanup complete'
docker logs sentinel-worker-2 --since 10m 2>&1 | grep -i 'Retention cleanup complete'
```

**Expected:** completion log fires with `deleted: <large N>`, row count
drops by far more than 1000 in a single job. If the log doesn't fire
or only ~1000 rows go, the deploy didn't pick up the handler change —
check `docker inspect -f '{{.Created}}' sentinel-worker-1`.

## 2. PR #2a post-deploy soak — three checks before PR #2b

Soak goal isn't "wait 24h" — it's verifying these three things. ~1-2h
if you actively check; can be done overnight if you'd rather.

### 2.1 No code path still writes to `aws_raw_events`

After the deploy, `received_at` on `aws_raw_events` should never
advance. Sample twice ~30 min apart:

```bash
docker exec -e DB="$DB_NAME" -e DBU="$DB_USER" shared-postgres-1 sh -lc \
  'psql -U "$DBU" -d "$DB" -tAc "
     SELECT MAX(received_at) AS last_write,
            NOW() - MAX(received_at) AS age,
            COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '\''5 minutes'\'') AS recent
     FROM aws_raw_events;"'
```

`recent = 0` and `last_write` not advancing between samples = no
writers. If `recent > 0` after deploy time, something we missed is
still inserting and PR #2b must not ship.

### 2.2 In-flight `aws.event.process` jobs have drained

The new code stops enqueuing them; the drain shim in
`modules/aws/src/handlers.ts:393-403` completes any that were already
in the queue. Watch the `module-jobs` queue empty out:

```bash
docker exec -e PW="$PW" shared-redis-1 sh -lc '
  for s in wait active; do
    echo -n "module-jobs $s: "; redis-cli -a "$PW" --no-auth-warning LLEN bull:module-jobs:$s
  done
  for s in completed failed delayed; do
    echo -n "module-jobs $s: "; redis-cli -a "$PW" --no-auth-warning ZCARD bull:module-jobs:$s
  done'
```

`wait` and `active` near 0 (other modules' jobs may still be there —
check the failed list for any new `aws.event.process` failures with
`ZRANGE bull:module-jobs:failed 0 -1 WITHSCORES`; should be none).

### 2.3 Read paths don't regress

Click through these in the UI (all should return data and respond
fast):

- `/aws/events` — list, filter by integration, search by event name
- `/aws/integrations` — accounts shown per integration
- `/aws/overview` — total events + error counts non-zero
- `/events` (global) — AWS rows render, payload tree expands
- MCP tools (or the analytics endpoints they wrap):
  - `aws-query-events`, `aws-principal-activity`, `aws-resource-history`,
    `aws-error-patterns`, `aws-top-actors`, `aws-account-summary`

```bash
# Check API error rate over the last hour
docker logs sentinel-api --since 1h 2>&1 | grep -iE 'aws.*error|aws.*500|aws-analytics' | head -20
```

## 3. PR #2b — drop the table

After section 2 passes, PR #2b is mechanical:

1. Delete `awsRawEvents` table definition from
   `packages/db/schema/aws.ts:69-112` (the `pgTable` block + indexes).
2. Remove `'aws_raw_events'` from `test/helpers/setup.ts:708`.
3. `pnpm db:generate` → produces a `DROP INDEX … DROP TABLE
   aws_raw_events;` migration.
4. Review the SQL diff (should only touch `aws_raw_events` and its
   indexes, nothing else).
5. Commit. Wait for explicit push instruction.

No code changes needed — handlers/router/analytics already off it as
of PR #2a.

## Pre-PR-#2 duplicate check (already cleared, kept for record)

Before Migration 0005's partial unique index could apply, we
confirmed no existing `(orgId, moduleId, externalId)` duplicates in
`events`. Re-runnable sanity check:

```bash
docker exec -e DB="$DB_NAME" -e DBU="$DB_USER" shared-postgres-1 sh -lc \
  'psql -U "$DBU" -d "$DB" -tAc "
     SELECT COUNT(*) - COUNT(DISTINCT (org_id, module_id, external_id))
     FROM events WHERE external_id IS NOT NULL;"'
```

Returns `0` = no dupes. If non-zero appears later, the new
`onConflictDoNothing()` ingest path is silently dropping a real event
somewhere (or the index is being violated somehow).

## Authentication note for redis-cli

Every `redis-cli` invocation in this doc relies on `$PW` being
exported by §0 and re-injected via `-e PW="$PW"`. `docker exec` does
not inherit host env. Without `-e`, `redis-cli -a "$PW"` sees an
empty/unset password inside the container and fails with
`WRONGPASS`. Same pattern for `$DB_NAME` / `$DB_USER`.
