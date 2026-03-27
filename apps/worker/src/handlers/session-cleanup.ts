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
    const result = await db.execute(
      sql`DELETE FROM sessions WHERE expire < now()`,
    );
    const deleted = Number((result as unknown as { rowCount?: number })?.rowCount ?? 0);

    if (deleted > 0) {
      _log.info({ deleted }, 'Expired sessions cleaned up');
    }
  },
};
