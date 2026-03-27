import type { Job } from 'bullmq';
import { getDb, sql } from '@sentinel/db';
import { QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { logger as rootLogger } from '@sentinel/shared/logger';

export interface RetentionPolicy {
  table: string;
  timestampColumn: string;
  retentionDays: number;
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

    for (const policy of policies) {
      const cutoff = new Date(Date.now() - policy.retentionDays * 86_400_000);
      let totalDeleted = 0;
      let batchDeleted: number;

      do {
        const result = await db.execute(sql`
          DELETE FROM ${sql.identifier(policy.table)}
          WHERE id IN (
            SELECT id FROM ${sql.identifier(policy.table)}
            WHERE ${sql.identifier(policy.timestampColumn)} < ${cutoff}
            LIMIT 1000
          )
        `);
        batchDeleted = Number(result?.rowCount ?? 0);
        totalDeleted += batchDeleted;
      } while (batchDeleted >= 1000);

      if (totalDeleted > 0) {
        _log.info({ table: policy.table, deleted: totalDeleted, retentionDays: policy.retentionDays }, 'Retention cleanup complete');
      }
    }
  },
};
