# Migrations

Sentinel manages database migrations with [Drizzle Kit](https://orm.drizzle.team/docs/kit-overview).
Migration files are plain SQL generated from the TypeScript schema definitions
in `packages/db/schema/`. The workflow is: edit schema, generate SQL, review
SQL, apply to the database.

## Configuration

Drizzle Kit reads `packages/db/drizzle.config.ts`:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './schema/*.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

Key points:

- `schema` -- glob pattern; Drizzle Kit introspects all `*.ts` files under
  `packages/db/schema/` and produces a unified diff.
- `out` -- migration SQL files are written to `packages/db/migrations/`.
- `dialect: 'postgresql'` -- targets PostgreSQL 16 syntax.
- `DATABASE_URL` -- must be set in the environment before running any Drizzle
  Kit command.

## The Cardinal Rule

**Never hand-write SQL migration files.** Always use Drizzle Kit to generate
migrations from schema changes. Hand-written files that lack corresponding
snapshot updates cause Drizzle Kit to produce duplicate statements on the next
`generate` run, leading to migration failures.

The only exception is `drizzle-kit generate --custom` (see
[Custom Migrations](#custom-migrations)), which creates an empty SQL file
**with** a proper snapshot entry, keeping the migration chain intact.

## Commands

All commands are run from the monorepo root.

### Generate a new migration

```bash
pnpm db:generate
```

This runs `drizzle-kit generate` inside the `@sentinel/db` package. Drizzle
Kit compares the current TypeScript schema against the last snapshot stored in
`packages/db/migrations/meta/` and emits a new SQL file if there are
differences. No database connection is required.

The generated file is placed in `packages/db/migrations/` and named with an
incrementing four-digit prefix followed by a short descriptor slug, for
example:

```
0001_add_correlation_window_field.sql
```

**Always review the generated SQL before committing it.** Verify that:

- Columns are added as nullable or have a valid default (adding a `NOT NULL`
  column to a large table without a default will fail or lock the table).
- Destructive changes (column drops, type changes) are intentional.
- Index creation uses `CREATE INDEX CONCURRENTLY` if the table holds
  significant data (see [Production Considerations](#production-considerations)).

### Apply migrations

```bash
pnpm db:migrate
```

This runs `drizzle-kit migrate` inside `@sentinel/db`. It applies all
unapplied migration files in `packages/db/migrations/` to the database
pointed at by `DATABASE_URL`, in numeric order. Drizzle Kit tracks which
migrations have already run in the `__drizzle_migrations` table it manages
automatically.

### Open Drizzle Studio (local development)

```bash
pnpm db:studio
```

Opens the Drizzle Studio browser UI connected to `DATABASE_URL`. Useful for
inspecting data and running ad-hoc queries during development.

## Migration Workflow

### Step-by-step: schema change to applied migration

1. **Edit the TypeScript schema** in the appropriate file under
   `packages/db/schema/` (e.g. `core.ts`, `chain.ts`, `infra.ts`).

2. **Run `pnpm db:generate`** from the monorepo root. Drizzle Kit diffs the
   schema against its snapshot and produces a new SQL file plus an updated
   snapshot in `migrations/meta/`.

3. **Review the generated SQL** for correctness. Check for:
   - `NOT NULL` columns without defaults on populated tables.
   - Unintended drops or renames.
   - Missing `IF NOT EXISTS` guards if idempotency matters.

4. **Run `pnpm db:migrate`** to apply locally against your development database.

5. **Commit both the `.sql` file and the `meta/` snapshot together** in the
   same PR as the schema change. Never commit them separately; keeping them
   together ensures the schema and migrations are always in sync.

### Step-by-step: adding a new table

1. Create or edit the appropriate schema file under `packages/db/schema/`.

2. Export the new table from the schema file.

3. If the file is new, add it to the imports and `schema` object in
   `packages/db/index.ts`.

4. Run `pnpm db:generate` to create the migration file.

5. Review the generated SQL. Commit both the schema change and migration file.

### Step-by-step: adding a column to an existing table

1. Add the column definition to the appropriate table in `packages/db/schema/`.

2. For `NOT NULL` columns on tables that may already contain data, add a
   `default(...)` in the Drizzle definition:
   ```typescript
   newColumn: text('new_column').notNull().default('pending'),
   ```

3. Run `pnpm db:generate` and review the generated SQL (see
   [Production Considerations](#production-considerations) for large-table
   caveats).

4. Commit both files together.

## Custom Migrations

For changes that `drizzle-kit generate` cannot produce -- data backfills,
conditional DDL, expression indexes, or `CONCURRENTLY` operations -- use the
custom migration command:

```bash
pnpm drizzle-kit generate --custom --name=description
```

This creates an empty SQL file **with** a proper snapshot entry in
`migrations/meta/`, keeping the migration chain intact. You then write the SQL
manually in the generated file.

Guidelines for custom migrations:

- Use `IF NOT EXISTS` / `IF EXISTS` guards for idempotency.
- If the migration adds columns or tables, also update the TypeScript schema
  in `packages/db/schema/*.ts` and run `pnpm db:generate` to update the
  snapshot so Drizzle Kit knows the new baseline.
- Always test the migration against a fresh database (via `pnpm test:integration`)
  before merging.

## Migration Files

### Location and naming

```
packages/db/
  drizzle.config.ts
  migrations/
    meta/
      _journal.json                # Drizzle Kit migration journal
      0000_snapshot.json           # Schema snapshot after 0000
    0000_sparkling_callisto.sql    # Full baseline (48 tables)
  schema/
    core.ts
    correlation.ts
    github.ts
    chain.ts
    registry.ts
    infra.ts
    aws.ts
```

The four-digit numeric prefix determines application order. The slug suffix
(generated by Drizzle Kit from a random word pair or manually renamed) is for
human readability only and does not affect ordering.

### Snapshot files and their importance

The `migrations/meta/` directory contains two types of files:

**`_journal.json`** -- the migration journal. Each entry records the migration
index, version, timestamp, tag (filename without `.sql`), and whether
breakpoints are enabled. Drizzle Kit uses this journal to determine which
migrations exist and in what order they should run.

```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1774802352271,
      "tag": "0000_sparkling_callisto",
      "breakpoints": true
    }
  ]
}
```

**`NNNN_snapshot.json`** -- a full snapshot of the schema state after migration
`NNNN` has been applied. Drizzle Kit compares the current TypeScript schema
against the latest snapshot to determine what SQL to generate for the next
migration. If a snapshot is missing or stale, Drizzle Kit generates incorrect
or duplicate SQL statements.

**Never delete or manually edit snapshot files** unless you are performing a
pre-production consolidation (see
[Pre-Production Reset Strategy](#pre-production-reset-strategy)). If the
snapshot gets out of sync with reality, the safest fix is to re-run
`pnpm db:generate` and verify the output.

### What a migration file looks like

```sql
-- Example: creating a table in a migration
CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "alert_id" bigint NOT NULL,
  "channel_id" text NOT NULL,
  "channel_type" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "status_code" integer,
  "response_time_ms" integer,
  "error" text,
  "attempt_count" integer DEFAULT 1 NOT NULL,
  "sent_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_alert_id_alerts_id_fk"
  FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE cascade;

CREATE INDEX "idx_notif_deliveries_alert"
  ON "notification_deliveries" ("alert_id");
CREATE INDEX "idx_notif_deliveries_status"
  ON "notification_deliveries" ("status");
CREATE INDEX "idx_notif_deliveries_created"
  ON "notification_deliveries" ("created_at");
```

## Running Migrations in Production

The `scripts/deploy.sh` deployment script applies migrations automatically as
part of every deploy, before containers are started:

```bash
echo "==> Running database migrations..."
set -a; source .env; set +a
npx drizzle-kit migrate --config packages/db/drizzle.config.ts
```

This runs before `docker compose up`, ensuring the new schema is in place
before any application code that depends on it starts serving traffic.

If the migration step fails, `set -euo pipefail` causes the script to exit
immediately and the container build and start steps do not run. The previous
version of the application continues to run against the pre-migration schema.

### Verifying applied migrations

To check which migrations have been applied:

```bash
DATABASE_URL=<url> npx drizzle-kit migrate --config packages/db/drizzle.config.ts
```

Drizzle Kit prints which files it applies (or reports "No pending migrations"
if the database is current).

To inspect the `__drizzle_migrations` tracking table directly:

```sql
SELECT * FROM __drizzle_migrations ORDER BY created_at;
```

## Three-Way Sync Check

Migrations involve three things that must stay in sync. When anything seems
off, check all three:

```bash
# 1. How many SQL files exist?
ls packages/db/migrations/*.sql | wc -l

# 2. How many journal entries?
grep -c '"tag"' packages/db/migrations/meta/_journal.json

# 3. How many rows in the DB tracking table?
psql $DATABASE_URL -c "SELECT count(*) FROM drizzle.__drizzle_migrations;"
```

All three numbers must match. If they do not:

| Symptom | Cause | Fix |
|---------|-------|-----|
| SQL file exists, not in journal | Hand-written migration without journal entry | Add entry to `_journal.json` |
| In journal, not in DB table | Migration exists but was never applied | Run `pnpm db:migrate` |
| In DB table, file deleted | File removed after being applied | Restore file or accept drift |

**Run this check before every deploy and in CI.** CI runs this check
automatically: it verifies that SQL file count equals journal entries equals
applied DB rows. It also runs `pnpm db:generate` to detect uncommitted schema
drift (if `generate` produces output, the schema and migrations are out of
sync).

## Production Considerations

### Additive-only migration policy

Once Sentinel is deployed to production with real data, all migrations must be
**additive-only**. This means migrations may only:

- Add new tables
- Add new nullable columns (or columns with a `DEFAULT`)
- Add new indexes
- Add new constraints

Migrations must **never** do any of the following in the same deploy as the
code that depends on the change:

- Drop a column or table
- Rename a column or table
- Change a column type
- Remove or tighten a constraint

This policy exists because the deploy script auto-rolls back code-only deploys
on health check failure. If the old code runs against the new schema, additive
changes are invisible to it -- it just ignores the new columns. But destructive
changes (drops, renames) break the old code immediately.

### Two-deploy pattern for destructive changes

If you need to drop a column, rename a table, or change a type, split it across
two deploys:

1. **Deploy 1 -- remove the dependency.** Update application code to stop
   reading/writing the column. Deploy and verify.
2. **Deploy 2 -- remove the column.** Write a migration that drops the now-unused
   column. Deploy.

This ensures there is never a window where running code references a schema
object that no longer exists.

**Example: renaming a column**

```
Deploy 1: Add new_name column (nullable), backfill from old_name, update code to read/write new_name
Deploy 2: Drop old_name column
```

Never rename in place with `ALTER COLUMN ... RENAME TO` -- the old code will
break if the deploy rolls back.

### Adding a NOT NULL column to a large table

Adding a `NOT NULL` column without a `DEFAULT` value to a large table will
fail because existing rows cannot satisfy the constraint. Use one of these
patterns instead:

**Option A -- add nullable, backfill, then constrain:**

```sql
-- Step 1: add as nullable (no table lock)
ALTER TABLE detections ADD COLUMN new_column text;

-- Step 2: backfill existing rows (can run as a separate migration)
UPDATE detections SET new_column = 'default_value' WHERE new_column IS NULL;

-- Step 3: add NOT NULL constraint (step 3 migration)
ALTER TABLE detections ALTER COLUMN new_column SET NOT NULL;
```

**Option B -- add with a DEFAULT:**

```sql
ALTER TABLE detections
  ADD COLUMN new_column text NOT NULL DEFAULT 'default_value';
```

When using Option B, set the default in the Drizzle schema definition as well
so that application inserts that omit the column still work.

### Changing a column type when it has a DEFAULT

PostgreSQL cannot auto-cast a default value during `ALTER COLUMN ... TYPE`.
If the column has a text default like `'60'::text` and you change the type to
`integer`, the migration will fail with:

```
ERROR: default for column "col" cannot be cast automatically to type integer
```

Fix: drop the default, change the type, then re-add the default:

```sql
ALTER TABLE t ALTER COLUMN col DROP DEFAULT;
ALTER TABLE t ALTER COLUMN col TYPE integer USING col::integer;
ALTER TABLE t ALTER COLUMN col SET DEFAULT 60;
```

### Creating indexes on large tables

By default, `CREATE INDEX` takes a share lock that blocks writes for the
duration of the build. For tables with significant data (especially `alerts`,
`notification_deliveries`, `aws_raw_events`, and `chain_state_snapshots`),
you may want to use `CREATE INDEX CONCURRENTLY` to avoid blocking writes.

**However: `drizzle-kit migrate` wraps each migration file in a transaction,
and `CONCURRENTLY` cannot run inside a transaction.** This is a hard Postgres
error -- the migration will fail.

**Pre-production (current state):** Use plain `CREATE INDEX` in migration
files. The tables are small enough that the brief lock is negligible.

**Post-production:** When tables hold significant data and downtime matters,
`CONCURRENTLY` indexes must be applied **outside** of `drizzle-kit migrate`.
The recommended pattern:

1. Write the migration SQL file with `CONCURRENTLY` as usual.
2. Add it to `_journal.json` so the three-way sync check passes.
3. **Do not** run it via `pnpm db:migrate`. Instead, apply it manually:
   ```bash
   psql $DATABASE_URL -f packages/db/migrations/NNNN_my_index.sql
   ```
4. Manually insert the tracking row into `__drizzle_migrations` so
   `drizzle-kit migrate` skips it on subsequent runs:
   ```sql
   INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
   VALUES ('<sha256sum of the file>', <when from journal>);
   ```

## Current Migration History

| Index | Tag | Description |
|-------|-----|-------------|
| `0000` | `sparkling_callisto` | Consolidated baseline. Creates all 48 tables, foreign keys, and indexes. Generated by Drizzle Kit from the full schema. |

The baseline migration was consolidated from a previously fragmented set of
migrations. All prior incremental migrations (duplicate-alert unique indexes,
session lookup columns, AWS schema fixes) have been folded into this single
baseline.

## Rollback Strategy

Drizzle Kit does not generate or apply rollback SQL automatically. There is no
`pnpm db:rollback` command.

If a migration must be undone:

1. Write a new forward migration that reverses the change (drop the column,
   undo the type change, etc.).
2. Generate the reversal migration with `pnpm db:generate`.
3. Apply it with `pnpm db:migrate`.

For emergency situations where a migration has caused an outage and must be
reversed immediately without going through the normal workflow:

1. Connect to the database with a privileged user.
2. Manually execute the inverse SQL (e.g. `ALTER TABLE ... DROP COLUMN ...`).
3. Delete the corresponding row from `__drizzle_migrations` so Drizzle Kit
   no longer considers it applied.
4. Delete the migration `.sql` file and regenerate the schema snapshot with
   `pnpm db:generate` so the meta directory stays consistent.

This manual procedure is a last resort. Prefer the forward-migration approach
in all non-emergency cases.

## Pre-Production Reset Strategy

Since Sentinel is pre-production, migrations can be consolidated when they
become fragmented or drift accumulates:

1. Back up existing migrations (optional safety net).
2. Delete all `.sql` files and the snapshots in `migrations/meta/`.
3. Empty `_journal.json`: `{"version":"7","dialect":"postgresql","entries":[]}`
4. Run `pnpm db:generate` -- produces a single `0000` with the full schema.
5. Reset the DB tracking table:
   ```sql
   DELETE FROM drizzle.__drizzle_migrations;
   INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
   VALUES ('<sha256sum of new 0000.sql>', <when from journal>);
   ```
6. Run the three-way sync check to verify.

**This is only safe pre-production.** Once there are real deployments with
user data, every migration must be preserved and applied sequentially.
The transition to production-safe migrations should happen before the first
real deployment -- at that point, the current `0000` becomes the permanent
baseline and all future changes are incremental-only.

## Schema Conventions

### Primary keys

- All tables use `uuid` primary keys generated with PostgreSQL's
  `gen_random_uuid()` function, except for high-volume append-only tables
  which use `bigserial` (64-bit auto-increment):
  - `alerts`
  - `notification_deliveries`
  - `audit_log`
  - `chain_state_snapshots`
  - `chain_container_metrics`
  - `aws_raw_events`

  The `bigserial` choice on these tables avoids UUID generation overhead and
  produces naturally ordered IDs that help with range-scan query plans on
  time-ordered data.

### Naming: TypeScript vs SQL

Drizzle ORM maps TypeScript camelCase property names to SQL snake_case column
names. Always declare the SQL name explicitly in the column definition:

```typescript
// TypeScript property name (camelCase)   SQL column name (snake_case)
createdBy: uuid('created_by'),
lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
cooldownMinutes: integer('cooldown_minutes'),
```

Never rely on Drizzle's automatic casing transformation. Explicit SQL names
make migration diffs and raw queries unambiguous.

### Timestamps

All timestamp columns use `withTimezone: true` (stored as `timestamptz` in
PostgreSQL). Never use `timestamp without time zone`.

The shared column helpers defined at the top of each schema file provide
consistent defaults:

```typescript
const createdAt = timestamp('created_at', { withTimezone: true })
  .defaultNow()
  .notNull();

const updatedAt = timestamp('updated_at', { withTimezone: true })
  .defaultNow()
  .notNull()
  .$onUpdate(() => new Date());
```

The `$onUpdate` callback on `updatedAt` instructs Drizzle to set the column
to the current time on every `UPDATE` operation.

### JSONB columns

Use `jsonb` (not `json`) for all document columns. PostgreSQL stores `jsonb`
in a binary decomposed format that supports indexing and operator queries.
Always provide a typed default that reflects the expected shape:

```typescript
config: jsonb('config').notNull().default({}),
scopes: jsonb('scopes').notNull().default(['read']),
notifications: jsonb('notifications').notNull().default([]),
```

### Partial indexes

Use partial `WHERE` clauses on indexes that filter on a status column. This
keeps the index small and fast for the common hot path:

```typescript
index('idx_detections_status')
  .on(t.status)
  .where(sql`status = 'active'`),
```

### Array columns

PostgreSQL native arrays (`text[]`, `uuid[]`) are used for small, bounded
collections that do not need to be queried individually. For collections that
require per-element filtering or joining, use a separate junction table instead.

## Schema Import Convention

Schema files under `packages/db/schema/` must use bare imports without
`.js` extensions:

```typescript
// Correct -- works with drizzle-kit's CJS require()
import { organizations } from './core';

// Wrong -- breaks drizzle-kit generate
import { organizations } from './core.js';
```

Drizzle-kit resolves imports via CJS `require()`, which cannot handle
`.js` extensions pointing to `.ts` files.

## Seeding

Sentinel provides a seed script for populating reference data required by
modules. Run it after migrations:

```bash
pnpm --filter @sentinel/db seed
```

This executes `packages/db/src/seed.ts`, which calls individual seed functions
in sequence.

### Chain networks

The `seedChainNetworks` function (`packages/db/src/seed/chain-networks.ts`)
inserts known blockchain network records into the `chain_networks` table using
`onConflictDoNothing()` to remain idempotent. The current seed includes:

| Network | Chain ID | Block Time | RPC URLs |
|---------|----------|------------|----------|
| Ethereum Mainnet | 1 | 12,000 ms | `cloudflare-eth.com`, `eth.llamarpc.com`, `rpc.ankr.com/eth` |
| Polygon | 137 | 2,000 ms | `polygon-rpc.com`, `rpc.ankr.com/polygon` |
| Arbitrum One | 42161 | 250 ms | `arb1.arbitrum.io/rpc`, `rpc.ankr.com/arbitrum` |
| Optimism | 10 | 2,000 ms | `mainnet.optimism.io`, `rpc.ankr.com/optimism` |
| Base | 8453 | 2,000 ms | `mainnet.base.org`, `rpc.ankr.com/base` |
| Ethereum Sepolia | 11155111 | 12,000 ms | `rpc.sepolia.org`, `rpc.ankr.com/eth_sepolia` |

The `rpcUrl` column stores comma-separated URLs. The RPC client rotates across
them hourly with automatic failover.

### Adding new seed data

To add a new seed function:

1. Create a new file under `packages/db/src/seed/` (e.g. `my-data.ts`).
2. Export an async function that accepts `Db` and inserts the data.
3. Import and call it from `packages/db/src/seed.ts`.
4. Use `onConflictDoNothing()` or `onConflictDoUpdate()` so the seed is
   idempotent and safe to rerun.
