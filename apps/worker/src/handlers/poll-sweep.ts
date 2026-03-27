/**
 * release-chain.poll-sweep
 *
 * Runs every 60 seconds. Queries all enabled rcArtifacts that are due for
 * polling (lastPolledAt IS NULL OR lastPolledAt + pollIntervalSeconds has
 * elapsed), then enqueues a release-chain.poll job for each one.
 *
 * Using jobId: `poll-${artifact.id}` prevents duplicate concurrent polls for
 * the same artifact — BullMQ will deduplicate by jobId within a queue.
 */
import type { Job } from 'bullmq';
import { getDb, sql } from '@sentinel/db';
import { eq, isNull, or, and } from '@sentinel/db';
import { rcArtifacts, rcArtifactVersions } from '@sentinel/db/schema/release-chain';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { createLogger } from '@sentinel/shared/logger';

const log = createLogger({ service: 'sentinel-worker' }).child({ component: 'poll-sweep' });

export const pollSweepHandler: JobHandler = {
  jobName: 'release-chain.poll-sweep',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(_job: Job) {
    const db = getDb();

    // Fetch all enabled artifacts that are due for polling.
    // An artifact is due when:
    //   - lastPolledAt IS NULL (never polled), OR
    //   - lastPolledAt + pollIntervalSeconds <= now()
    const enabledDue = await db
      .select()
      .from(rcArtifacts)
      .where(
        and(
          eq(rcArtifacts.enabled, true),
          or(
            isNull(rcArtifacts.lastPolledAt),
            sql`${rcArtifacts.lastPolledAt} + (${rcArtifacts.pollIntervalSeconds} * interval '1 second') <= now()`,
          ),
        ),
      );

    if (enabledDue.length === 0) {
      log.debug('Poll sweep: no artifacts due for polling');
      return;
    }

    log.info({ count: enabledDue.length }, 'Poll sweep: enqueueing poll jobs');

    const moduleJobsQueue = getQueue(QUEUE_NAMES.MODULE_JOBS);

    for (const artifact of enabledDue) {
      // Load stored versions for this artifact
      const dbVersions = await db
        .select()
        .from(rcArtifactVersions)
        .where(eq(rcArtifactVersions.artifactId, artifact.id));

      const storedVersions = new Map(
        dbVersions.map((v) => [
          v.version,
          {
            id: v.id,
            tag: v.version,
            currentDigest: v.currentDigest,
            status: v.status as 'active' | 'gone' | 'untracked',
            metadata: (v.metadata as Record<string, unknown>) ?? {},
          },
        ]),
      );

      const monitoredArtifact = {
        id: artifact.id,
        orgId: artifact.orgId,
        name: artifact.name,
        registry: artifact.registry as 'docker_hub' | 'npmjs',
        enabled: artifact.enabled,
        tagPatterns: (artifact.tagWatchPatterns as string[]) ?? ['*'],
        ignorePatterns: (artifact.tagIgnorePatterns as string[]) ?? [],
        pollIntervalSeconds: artifact.pollIntervalSeconds,
        lastPolledAt: artifact.lastPolledAt,
        storedVersions,
        metadata: (artifact.metadata as Record<string, unknown>) ?? {},
      };

      try {
        await moduleJobsQueue.add(
          'release-chain.poll',
          { artifact: monitoredArtifact },
          { jobId: `poll-${artifact.id}` },
        );
        log.debug({ artifactId: artifact.id, name: artifact.name }, 'Enqueued poll job');
      } catch (err) {
        log.error({ err, artifactId: artifact.id, name: artifact.name }, 'Failed to enqueue poll job');
      }
    }
  },
};
