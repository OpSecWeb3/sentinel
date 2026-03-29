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
}

/**
 * Allowlist of permitted table names for retention policies.
 * Prevents SQL identifier injection via crafted job payloads
 * (e.g. if Redis is compromised).
 */
const ALLOWED_TABLES: ReadonlySet<string> = new Set([
  'events',
  'alerts',
  'notification_deliveries',
  'sessions',
  'aws_raw_events',
]);

/**
 * Allowlist of permitted timestamp column names for retention policies.
 */
const ALLOWED_TIMESTAMP_COLUMNS: ReadonlySet<string> = new Set([
  'received_at',
  'created_at',
  'updated_at',
  'expire',
]);

/**
 * Allowlist of permitted filter expressions for retention policies.
 * Any filter not in this set will be rejected to prevent SQL injection
 * via crafted job payloads (e.g. if Redis is compromised).
 */
const ALLOWED_FILTERS: ReadonlySet<string> = new Set([
  "module_id = 'aws'",
  "module_id = 'github'",
  "module_id = 'registry'",
  "module_id = 'chain'",
  "module_id = 'infra'",
]);

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

    for (const policy of policies) {
      // Validate table and timestampColumn against allowlists to prevent
      // SQL identifier injection via crafted job payloads.
      if (!ALLOWED_TABLES.has(policy.table)) {
        _log.warn(
          { table: policy.table },
          'Skipping retention policy with unrecognised table name',
        );
        continue;
      }

      if (!ALLOWED_TIMESTAMP_COLUMNS.has(policy.timestampColumn)) {
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
      if (policy.filter && !ALLOWED_FILTERS.has(policy.filter)) {
        _log.warn(
          { table: policy.table, filter: policy.filter },
          'Skipping retention policy with unrecognised filter expression',
        );
        continue;
      }

      const cutoff = new Date(Date.now() - policy.retentionDays * 86_400_000);
      let totalDeleted = 0;
      let batchDeleted: number;

      do {
        const result = await db.execute(
          policy.filter
            ? sql`
              DELETE FROM ${sql.identifier(policy.table)}
              WHERE id IN (
                SELECT id FROM ${sql.identifier(policy.table)}
                WHERE ${sql.identifier(policy.timestampColumn)} < ${cutoff}
                AND ${sql.raw(policy.filter)}
                LIMIT 1000
              )
            `
            : sql`
              DELETE FROM ${sql.identifier(policy.table)}
              WHERE id IN (
                SELECT id FROM ${sql.identifier(policy.table)}
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
