# Manually run AWS retention

The `daily-retention` scheduler fires once every 24h; first post-deploy
fire is `deploy_time + 24h`. To force a run immediately — e.g. to verify
the predicate after shipping `feat(retention): value-driven pruning for
AWS events` (commit `7e0ff37`) — enqueue a one-shot
`platform.data.retention` job via the worker's installed `bullmq`.

## Containers

- Redis: `shared-redis-1` (external, in `chainalert` compose, project `-p shared`)
- Worker: `sentinel-worker-1` / `sentinel-worker-2` (two replicas, no
  `container_name`, from `docker-compose.prod.yml`)
- Postgres: `shared-postgres-1`

## 0. Bootstrap — capture Redis password

`docker exec` does not inherit host env vars. Source the password
once from the worker's `REDIS_URL` and keep it in a host shell var
`PW`. Re-inject it into every redis-cli call with `-e PW="$PW"`.

```bash
export PW=$(docker exec sentinel-worker-1 sh -lc '
  node -e "const u=new URL(process.env.REDIS_URL); \
           process.stdout.write(decodeURIComponent(u.password||\"\"))"')
echo "password length: ${#PW}"   # sanity: non-zero

# Sentinel's Postgres db + user (shared-postgres-1 hosts multiple DBs;
# POSTGRES_DB inside the container defaults to chainalert, not ours)
export DB_NAME=$(docker exec sentinel-worker-1 sh -lc '
  node -e "const u=new URL(process.env.DATABASE_URL); \
           process.stdout.write(u.pathname.replace(/^\//,\"\"))"')
export DB_USER=$(docker exec sentinel-worker-1 sh -lc '
  node -e "const u=new URL(process.env.DATABASE_URL); \
           process.stdout.write(decodeURIComponent(u.username||\"\"))"')
echo "db: $DB_NAME  user: $DB_USER"
```

Sanity ping:

```bash
docker exec -e PW="$PW" shared-redis-1 sh -lc \
  'redis-cli -a "$PW" --no-auth-warning PING'
```

Must print `PONG`. If it prints `WRONGPASS`, the worker's `REDIS_URL`
and the redis container's `--requirepass` disagree — fix deployment
before going further.

## 1. Dry-run (counts rows, deletes nothing)

> **Why `-w /app/apps/worker`?** The prod image uses pnpm, which does
> not hoist `bullmq` to `/app/node_modules`. It lives at
> `/app/apps/worker/node_modules/bullmq`. Running `node` from the
> worker package directory puts that path on Node's resolution chain.

```bash
docker exec -w /app/apps/worker sentinel-worker-1 node -e '
const { Queue } = require("bullmq");
const u = new URL(process.env.REDIS_URL);
const q = new Queue("deferred", { connection: {
  host: u.hostname,
  port: Number(u.port) || 6379,
  username: u.username || undefined,
  password: decodeURIComponent(u.password || "") || undefined,
  tls: u.protocol === "rediss:" ? {} : undefined,
}});
q.add("platform.data.retention", {
  policies: [{
    table: "events",
    timestampColumn: "received_at",
    retentionDays: 1,
    filter: "module_id = \x27aws\x27",
    preserveIf: [
      { kind: "referenced_by", table: "alerts", column: "event_id" },
      { kind: "within_correlation_window" }
    ],
    dryRun: true
  }]
}, { removeOnComplete: true, removeOnFail: 100 })
  .then(j => { console.log("enqueued", j.id); return q.close(); })
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
'
```

Tail both replicas:

```bash
docker logs sentinel-worker-1 --since 2m -f 2>&1 | grep -iE 'retention|wouldDelete'
docker logs sentinel-worker-2 --since 2m -f 2>&1 | grep -iE 'retention|wouldDelete'
```

## 2. Real run

Same command as §1 with the `dryRun: true` line removed. On success
the handler emits `Retention cleanup complete` with `deleted: N` —
**only if N > 0** (`data-retention.ts:317`).

## 3. Tailing the real run

```bash
docker logs sentinel-worker-1 --since 10m -f 2>&1 | grep -iE 'retention|data-retention'
docker logs sentinel-worker-2 --since 10m -f 2>&1 | grep -iE 'retention|data-retention'
```

Success line:

```
{"level":30,"component":"data-retention","table":"events","deleted":<N>,"retentionDays":1,"msg":"Retention cleanup complete"}
```

Widen grep if nothing shows:

```bash
docker logs sentinel-worker-1 --since 10m 2>&1 | grep -iE 'retention|failed|error'
docker logs sentinel-worker-2 --since 10m 2>&1 | grep -iE 'retention|failed|error'
```

## 4. Is the job being processed?

Run `§0` first to set `$PW`. Then the full triage block — paste
verbatim:

```bash
echo '== queue state =='
docker exec -e PW="$PW" shared-redis-1 sh -lc '
  for s in wait active; do
    echo -n "$s: "; redis-cli -a "$PW" --no-auth-warning LLEN bull:deferred:$s
  done
  for s in completed failed delayed; do
    echo -n "$s: "; redis-cli -a "$PW" --no-auth-warning ZCARD bull:deferred:$s
  done'

echo
echo '== job id counter (last enqueued) =='
docker exec -e PW="$PW" shared-redis-1 sh -lc \
  'redis-cli -a "$PW" --no-auth-warning GET bull:deferred:id'

echo
echo '== active job ids =='
docker exec -e PW="$PW" shared-redis-1 sh -lc \
  'redis-cli -a "$PW" --no-auth-warning LRANGE bull:deferred:active 0 -1'

echo
echo '== recent failures (id + ts) =='
docker exec -e PW="$PW" shared-redis-1 sh -lc \
  'redis-cli -a "$PW" --no-auth-warning ZRANGE bull:deferred:failed 0 -1 WITHSCORES'
```

To inspect a specific job (substitute `<ID>`):

```bash
docker exec -e PW="$PW" shared-redis-1 sh -lc \
  'redis-cli -a "$PW" --no-auth-warning HGETALL bull:deferred:<ID>'
```

Interpretation:

- `wait > 0` → enqueued, no worker has pulled it.
- `active > 0` → running now. `HGETALL` on the id shows `processedOn`.
- all zero and counter advanced past the dry-run id → completed and
  auto-removed (`removeOnComplete: true`).
- all zero and counter **unchanged** → `q.add` never executed. Re-run
  §1/§2 and confirm stdout prints `enqueued <N>`.
- `failed > 0` → `HGETALL bull:deferred:<ID>` and read `failedReason`.

### Postgres side

Live DELETEs in flight:

```bash
docker exec -e DB="$DB_NAME" -e DBU="$DB_USER" shared-postgres-1 sh -lc \
  'psql -U "$DBU" -d "$DB" -c "
     SELECT pid, state, now() - query_start AS age, left(query, 120) AS q
     FROM pg_stat_activity
     WHERE query ILIKE '\''%DELETE FROM%events%'\''
        OR query ILIKE '\''%events%module_id%aws%'\''
     ORDER BY query_start;"'
```

Row count sanity:

```bash
docker exec shared-postgres-1 sh -lc \
  'psql -U $POSTGRES_USER -d $POSTGRES_DB -c "
     SELECT count(*) FROM events WHERE module_id='\''aws'\'';"'
```

### Worker-level pickup

```bash
docker logs sentinel-worker-1 --since 15m 2>&1 | grep -iE 'deferred|job|platform\.data'
docker logs sentinel-worker-2 --since 15m 2>&1 | grep -iE 'deferred|job|platform\.data'
```

## 5. Atomic re-run + observe

`removeOnComplete: true` erases a succeeded job on finish, so if we
enqueue, look away, and then check state, a silent deleted-zero run
looks identical to "never enqueued". Swap `removeOnComplete` off for
this run so the completed entry sticks around for inspection.

Run §0 first (exports `PW`). Then paste this block whole:

```bash
echo '== before: row count =='
docker exec -e DB="$DB_NAME" -e DBU="$DB_USER" shared-postgres-1 sh -lc \
  'psql -U "$DBU" -d "$DB" -tAc "
     SELECT count(*) FROM events WHERE module_id='\''aws'\'';"'

echo '== before: counter =='
docker exec -e PW="$PW" shared-redis-1 sh -lc \
  'redis-cli -a "$PW" --no-auth-warning GET bull:deferred:id'

echo '== enqueue real job =='
ENQ_OUT=$(docker exec -w /app/apps/worker sentinel-worker-1 node -e '
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
    table: "events",
    timestampColumn: "received_at",
    retentionDays: 1,
    filter: "module_id = \x27aws\x27",
    preserveIf: [
      { kind: "referenced_by", table: "alerts", column: "event_id" },
      { kind: "within_correlation_window" }
    ]
  }]
}, { removeOnComplete: false, removeOnFail: false })
  .then(j => { console.log(j.id); return q.close(); })
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
' 2>&1)
echo "enqueue output: $ENQ_OUT"
JOB_ID=$(echo "$ENQ_OUT" | tail -1)

echo
echo "== waiting 30s for processing =="
sleep 30

echo '== queue state =='
docker exec -e PW="$PW" shared-redis-1 sh -lc '
  for s in wait active; do
    echo -n "$s: "; redis-cli -a "$PW" --no-auth-warning LLEN bull:deferred:$s
  done
  for s in completed failed delayed; do
    echo -n "$s: "; redis-cli -a "$PW" --no-auth-warning ZCARD bull:deferred:$s
  done'

echo
echo "== job $JOB_ID full state =="
docker exec -e PW="$PW" shared-redis-1 sh -lc \
  "redis-cli -a \"\$PW\" --no-auth-warning HGETALL bull:deferred:$JOB_ID"

echo
echo '== after: row count =='
docker exec -e DB="$DB_NAME" -e DBU="$DB_USER" shared-postgres-1 sh -lc \
  'psql -U "$DBU" -d "$DB" -tAc "
     SELECT count(*) FROM events WHERE module_id='\''aws'\'';"'

echo
echo '== worker logs for this job =='
docker logs sentinel-worker-1 --since 2m 2>&1 | grep -iE "retention|data-retention|$JOB_ID"
docker logs sentinel-worker-2 --since 2m 2>&1 | grep -iE "retention|data-retention|$JOB_ID"
```

Interpreting `HGETALL bull:deferred:<id>`:

- `processedOn` present, `finishedOn` present, `returnvalue` set,
  `failedReason` absent → job completed successfully. If row count
  didn't drop, the handler ran the DELETE and matched zero rows —
  that's a real divergence from dry-run, dig into the predicate.
- `failedReason` present → the error message is the whole story.
- `processedOn` absent → worker never picked it up. Check
  `docker ps` that both workers are healthy and that the `deferred`
  Worker in `apps/worker/src/index.ts` is registered.

## 6. Drain loop — keep firing until row count stabilises

Symptom: handler terminates after one batch (~959 rows) despite
dry-run reporting 784k eligible. Likely cause: the `while
(batchDeleted >= 1000)` loop condition in `data-retention.ts:315`
is sensitive to any batch that returns fewer than 1000 rows (driver
`rowCount` quirks with `DELETE…WHERE id IN (…)` under postgres-js, or
MVCC visibility on concurrent inserts). Easy workaround while you
investigate the handler: fire the job repeatedly from the host side
until the row count stops dropping.

Run §0 first (sets `PW`, `DB_NAME`, `DB_USER`). Then:

```bash
PREV=-1
for i in $(seq 1 700); do
  NOW=$(docker exec -e DB="$DB_NAME" -e DBU="$DB_USER" shared-postgres-1 sh -lc \
    'psql -U "$DBU" -d "$DB" -tAc "SELECT count(*) FROM events WHERE module_id='\''aws'\'';"')
  echo "iter $i rows=$NOW"
  if [ "$NOW" = "$PREV" ]; then
    echo "stable — stopping"
    break
  fi
  PREV=$NOW

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
  .then(() => q.close()).then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1); });
' >/dev/null
  sleep 2
done
```

Each iteration enqueues one retention job, waits 2s for it to
process, then re-counts. Stops when the count stops dropping (or hits
200 iterations). If each iteration deletes ~959 you've confirmed the
per-batch termination bug — fix in the handler afterwards (simplest:
cap by a fixed iteration count, or re-query eligible count and loop
while it's > 0).

## Inspecting the scheduler

```bash
docker exec -e PW="$PW" shared-redis-1 sh -lc \
  'redis-cli -a "$PW" --no-auth-warning ZRANGE bull:deferred:repeat 0 -1 WITHSCORES'
```

Score = next-fire epoch-ms. Stale
`bull:deferred:repeat:daily-retention:<ts>` keys predating commit
`7e0ff37` are orphan payload entries from the old scheduler template
and safe to `DEL`.

## Notes

- **Single-policy payload.** The scheduled job carries ~14 policies;
  this manual job runs only the AWS-events policy.
- **Filter escaping.** `\x27` is `'`; avoids nested-quote issues in
  `-e '…'`.
- **`removeOnComplete: true`** keeps the diagnostic out of the
  completed list.
- **No total row cap.** 1000-row batches in a tight `do…while` loop
  until drained — holds the `deferred` slot the whole time.
