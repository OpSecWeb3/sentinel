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
