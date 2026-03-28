import type { Job } from 'bullmq';
import { getDb, sql } from '@sentinel/db';
import { QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { logger as rootLogger } from '@sentinel/shared/logger';

const _log = rootLogger.child({ component: 'session-cleanup' });

export const sessionCleanupHandler: JobHandler = {
  jobName: 'platform.session.cleanup',
  queueName: QUEUE_NAMES.DEFERRED,

  async process(_job: Job) {
    const db = getDb();
    let totalDeleted = 0;
    let batchDeleted: number;

    do {
      const result = await db.execute(
        sql`DELETE FROM sessions WHERE sid IN (
          SELECT sid FROM sessions WHERE expire < now() LIMIT 1000
        )`,
      );
      batchDeleted = Number((result as unknown as { rowCount?: number })?.rowCount ?? 0);
      totalDeleted += batchDeleted;
    } while (batchDeleted >= 1000);

    if (totalDeleted > 0) {
      _log.info({ deleted: totalDeleted }, 'Expired sessions cleaned up');
    }
  },
};
