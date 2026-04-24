import type { Job } from 'bullmq';
import { getDb, sql } from '@sentinel/db';
import { QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { logger as rootLogger } from '@sentinel/shared/logger';
import type { PreserveRule } from '@sentinel/shared/module';

export interface RetentionPolicy {
  table: string;
  timestampColumn: string;
  retentionDays: number;
  /** Optional SQL fragment appended as an extra AND condition (e.g. "module_id = 'aws'") */
  filter?: string;
  /** Use ctid for batched deletes on tables without an `id` column (e.g. composite PKs). */
  useCtid?: boolean;
  /**
   * Preservation rules: even if a row is older than retentionDays, keep it if
   * any preserveIf rule still needs it. See PreserveRule in shared/module.ts.
   * Each entry is checked against an allowlist below.
   */
  preserveIf?: PreserveRule[];
  /** Count matching rows but do not delete. Used to validate a new policy. */
  dryRun?: boolean;
}

/**
 * Base allowlist of permitted table names for retention policies.
 * Prevents SQL identifier injection via crafted job payloads
 * (e.g. if Redis is compromised). Additional tables declared in
 * validated policies (from module retentionPolicies) are also accepted.
 */
const BASE_ALLOWED_TABLES: ReadonlySet<string> = new Set([
  'events',
  'alerts',
  'notification_deliveries',
  'sessions',
  // Infra module tables
  'infra_reachability_checks',
  'infra_snapshots',
  'infra_scan_step_results',
  'infra_score_history',
  // Chain module tables
  'chain_state_snapshots',
  'chain_container_metrics',
  'chain_rpc_usage_hourly',
  // Registry module tables
  'rc_ci_notifications',
]);

/**
 * Base allowlist of permitted timestamp column names for retention policies.
 */
const BASE_ALLOWED_TIMESTAMP_COLUMNS: ReadonlySet<string> = new Set([
  'received_at',
  'created_at',
  'updated_at',
  'expire',
  'checked_at',
  'recorded_at',
  'polled_at',
  'bucket',
]);

/**
 * Base allowlist of permitted filter expressions for retention policies.
 * Any filter not in this set (and not declared by a policy in the job) will
 * be rejected to prevent SQL injection via crafted job payloads.
 */
const BASE_ALLOWED_FILTERS: ReadonlySet<string> = new Set([
  "module_id = 'aws'",
  "module_id = 'github'",
  "module_id = 'registry'",
  "module_id = 'chain'",
  "module_id = 'infra'",
]);

/**
 * Allowlist for `referenced_by` preserve rules. Each entry is a
 * `<table>.<column>` pair that the handler knows how to emit a safe
 * NOT EXISTS subquery for. Add new entries here as new foreign-key
 * preservation requirements arise.
 */
const ALLOWED_REFERENCED_BY: ReadonlySet<string> = new Set([
  'alerts.event_id',
]);

function buildAllowlists() {
  return {
    tables: BASE_ALLOWED_TABLES,
    columns: BASE_ALLOWED_TIMESTAMP_COLUMNS,
    filters: BASE_ALLOWED_FILTERS,
  } as const;
}

export const DEFAULT_RETENTION_POLICIES: RetentionPolicy[] = [
  { table: 'events', timestampColumn: 'received_at', retentionDays: 90 },
  { table: 'alerts', timestampColumn: 'created_at', retentionDays: 365 },
  { table: 'notification_deliveries', timestampColumn: 'created_at', retentionDays: 30 },
];

const _log = rootLogger.child({ component: 'data-retention' });

/**
 * Compute the maximum correlation lookback in minutes across all active
 * correlation rules. Covers the outer `windowMinutes` plus any absence
 * `graceMinutes` (absence rules need the trigger event to survive both the
 * lookback window and the grace period). Returns 0 when no active rules exist.
 */
/**
 * Extract rows from a drizzle `db.execute` result. The postgres-js driver
 * returns an array-like with extra fields (rowCount, command, …); other
 * drivers / test mocks may return a plain object. Normalise here so callers
 * can `.map` / index safely.
 */
function resultRows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Symbol.iterator in (result as object)) {
    return [...(result as Iterable<T>)];
  }
  if (result && typeof result === 'object' && 'rows' in (result as Record<string, unknown>)) {
    const rows = (result as Record<string, unknown>).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

async function getMaxCorrelationWindowMinutes(
  db: ReturnType<typeof getDb>,
): Promise<number> {
  const result = await db.execute(sql`
    SELECT COALESCE(MAX(
      COALESCE((config->>'windowMinutes')::int, 0) +
      COALESCE((config->'absence'->>'graceMinutes')::int, 0)
    ), 0) AS "maxWindowMinutes"
    FROM correlation_rules
    WHERE status = 'active'
  `);
  const rows = resultRows<{ maxWindowMinutes: number | string | null }>(result);
  const raw = rows[0]?.maxWindowMinutes ?? 0;
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : (raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

interface PreservePredicates {
  /** SQL fragments ANDed into the WHERE to permit deletion of a row. */
  clauses: ReturnType<typeof sql>[];
}

/**
 * Translate a policy's preserveIf rules into SQL predicates. Unknown variants
 * or entries that fail the allowlist are skipped with a warning — the safe
 * default when we don't recognise a rule is to preserve nothing extra (i.e.
 * not emit a clause), so retention continues to operate by TTL alone.
 */
async function buildPreservePredicates(
  db: ReturnType<typeof getDb>,
  policy: RetentionPolicy,
): Promise<PreservePredicates> {
  const clauses: ReturnType<typeof sql>[] = [];
  if (!policy.preserveIf || policy.preserveIf.length === 0) {
    return { clauses };
  }

  for (const rule of policy.preserveIf) {
    if (rule.kind === 'referenced_by') {
      const key = `${rule.table}.${rule.column}`;
      if (!ALLOWED_REFERENCED_BY.has(key)) {
        _log.warn(
          { table: policy.table, referencedBy: key },
          'Skipping referenced_by preserve rule not in allowlist',
        );
        continue;
      }
      if (!BASE_ALLOWED_TABLES.has(rule.table)) {
        _log.warn(
          { table: policy.table, referencedBy: key },
          'Skipping referenced_by preserve rule with unrecognised foreign table',
        );
        continue;
      }
      // Emit: NOT EXISTS (SELECT 1 FROM <rule.table> WHERE <rule.table>.<rule.column> = <policy.table>.id)
      clauses.push(sql`NOT EXISTS (
        SELECT 1 FROM ${sql.identifier(rule.table)}
        WHERE ${sql.identifier(rule.table)}.${sql.identifier(rule.column)} = ${sql.identifier(policy.table)}.id
      )`);
    } else if (rule.kind === 'within_correlation_window') {
      const windowMin = await getMaxCorrelationWindowMinutes(db);
      if (windowMin <= 0) continue; // no active rules → nothing to preserve
      const windowCutoff = new Date(Date.now() - windowMin * 60_000).toISOString();
      // Delete only if the row is *also* older than the correlation window.
      clauses.push(sql`${sql.identifier(policy.timestampColumn)} < ${windowCutoff}`);
    } else {
      _log.warn(
        { rule, table: policy.table },
        'Skipping unknown preserveIf rule kind',
      );
    }
  }

  return { clauses };
}

export const dataRetentionHandler: JobHandler = {
  jobName: 'platform.data.retention',
  queueName: QUEUE_NAMES.DEFERRED,
  async process(job: Job) {
    const policies = (job.data?.policies as RetentionPolicy[]) ?? DEFAULT_RETENTION_POLICIES;
    const db = getDb();
    const allowed = buildAllowlists();

    for (const policy of policies) {
      // Validate table and timestampColumn against allowlists to prevent
      // SQL identifier injection via crafted job payloads.
      if (!allowed.tables.has(policy.table)) {
        _log.warn(
          { table: policy.table },
          'Skipping retention policy with unrecognised table name',
        );
        continue;
      }

      if (!allowed.columns.has(policy.timestampColumn)) {
        _log.warn(
          { table: policy.table, timestampColumn: policy.timestampColumn },
          'Skipping retention policy with unrecognised timestamp column',
        );
        continue;
      }

      // Validate retentionDays: a value of 0 or negative would compute a cutoff
      // in the future (or right now), causing the DELETE to remove every row in
      // the table. Require at least 1 day to be safe.
      if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 1) {
        _log.warn(
          { table: policy.table, retentionDays: policy.retentionDays },
          'Skipping retention policy with invalid retentionDays (must be an integer >= 1)',
        );
        continue;
      }

      // Validate filter against allowlist to prevent SQL injection via crafted job payloads
      if (policy.filter && !allowed.filters.has(policy.filter)) {
        _log.warn(
          { table: policy.table, filter: policy.filter },
          'Skipping retention policy with unrecognised filter expression',
        );
        continue;
      }

      // preserveIf is incompatible with useCtid: the NOT EXISTS clauses reference
      // `<table>.id`, which composite-PK tables don't have. Fail loudly rather
      // than silently producing wrong SQL.
      if (policy.useCtid && policy.preserveIf && policy.preserveIf.length > 0) {
        _log.warn(
          { table: policy.table },
          'Skipping policy: preserveIf is not supported with useCtid (no id column)',
        );
        continue;
      }

      const cutoff = new Date(Date.now() - policy.retentionDays * 86_400_000).toISOString();
      const { clauses: preserveClauses } = await buildPreservePredicates(db, policy);
      // Tables with composite primary keys (no `id` column) use ctid for batching.
      const rowRef = policy.useCtid ? sql`ctid` : sql.identifier('id');

      // Build the candidate-selection WHERE clause once and reuse for both
      // dry-run SELECT and production DELETE. Everything mutable (timestamps,
      // clause lists) is captured here; the loop below only re-issues the
      // statement to drain batches.
      const filterFrag = policy.filter ? sql`AND ${sql.raw(policy.filter)}` : sql``;
      const preserveFrag = preserveClauses.length > 0
        ? sql`AND ${sql.join(preserveClauses, sql` AND `)}`
        : sql``;

      if (policy.dryRun) {
        // Count rows that *would* be deleted and log. Do not mutate.
        const countResult = await db.execute(sql`
          SELECT COUNT(*)::bigint AS "c" FROM ${sql.identifier(policy.table)}
          WHERE ${sql.identifier(policy.timestampColumn)} < ${cutoff}
          ${filterFrag}
          ${preserveFrag}
        `);
        const rows = resultRows<{ c: number | string }>(countResult);
        const wouldDelete = Number(rows[0]?.c ?? 0);
        _log.info(
          {
            table: policy.table,
            retentionDays: policy.retentionDays,
            wouldDelete,
            preserveIf: policy.preserveIf,
            filter: policy.filter,
            dryRun: true,
          },
          'Retention dry-run — rows matched but not deleted',
        );
        continue;
      }

      let totalDeleted = 0;
      let batchDeleted: number;

      do {
        const result = await db.execute(sql`
          DELETE FROM ${sql.identifier(policy.table)}
          WHERE ${rowRef} IN (
            SELECT ${rowRef} FROM ${sql.identifier(policy.table)}
            WHERE ${sql.identifier(policy.timestampColumn)} < ${cutoff}
            ${filterFrag}
            ${preserveFrag}
            LIMIT 1000
          )
        `);
        const rc = result as unknown as { count?: number; rowCount?: number };
        batchDeleted = Number(rc.count ?? rc.rowCount ?? 0);
        totalDeleted += batchDeleted;
      } while (batchDeleted >= 1000);

      if (totalDeleted > 0) {
        _log.info(
          { table: policy.table, deleted: totalDeleted, retentionDays: policy.retentionDays },
          'Retention cleanup complete',
        );
      }
    }
  },
};
