import type { Job } from 'bullmq';
import { getDb, sql } from '@sentinel/db';
import { QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { logger as rootLogger } from '@sentinel/shared/logger';

export interface RetentionPolicy {
  table: string;
  timestampColumn: string;
  retentionDays: number;
  /** Optional SQL fragment appended as an extra AND condition (e.g. "module_id = 'aws'") */
  filter?: string;
  /** Use ctid for batched deletes on tables without an `id` column (e.g. composite PKs). */
  useCtid?: boolean;
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
  'aws_raw_events',
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

      const cutoff = new Date(Date.now() - policy.retentionDays * 86_400_000);
      let totalDeleted = 0;
      let batchDeleted: number;
      // Tables with composite primary keys (no `id` column) use ctid for batching.
      const rowRef = policy.useCtid ? sql`ctid` : sql.identifier('id');

      do {
        const result = await db.execute(
          policy.filter
            ? sql`
              DELETE FROM ${sql.identifier(policy.table)}
              WHERE ${rowRef} IN (
                SELECT ${rowRef} FROM ${sql.identifier(policy.table)}
                WHERE ${sql.identifier(policy.timestampColumn)} < ${cutoff}
                AND ${sql.raw(policy.filter)}
                LIMIT 1000
              )
            `
            : sql`
              DELETE FROM ${sql.identifier(policy.table)}
              WHERE ${rowRef} IN (
                SELECT ${rowRef} FROM ${sql.identifier(policy.table)}
                WHERE ${sql.identifier(policy.timestampColumn)} < ${cutoff}
                LIMIT 1000
              )
            `
        );
        batchDeleted = Number((result as unknown as { rowCount?: number })?.rowCount ?? 0);
        totalDeleted += batchDeleted;
      } while (batchDeleted >= 1000);

      if (totalDeleted > 0) {
        _log.info({ table: policy.table, deleted: totalDeleted, retentionDays: policy.retentionDays }, 'Retention cleanup complete');
      }
    }
  },
};
