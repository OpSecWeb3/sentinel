/**
 * registry.poll-sweep
 *
 * Runs every 60 seconds. Queries all enabled rcArtifacts that are due for
 * polling (lastPolledAt IS NULL OR lastPolledAt + pollIntervalSeconds has
 * elapsed), then enqueues a registry.poll job for each one.
 *
 * Uses a timestamped jobId `poll-${artifact.id}-${Date.now()}` to ensure each
 * sweep cycle can enqueue a fresh job — static jobIds were silently deduped
 * against completed jobs retained in Redis, causing missed poll cycles.
 */
import type { Job } from 'bullmq';
import { getDb, sql } from '@sentinel/db';
import { eq, isNull, or, and, inArray } from '@sentinel/db';
import { rcArtifacts, rcArtifactVersions } from '@sentinel/db/schema/registry';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { createLogger } from '@sentinel/shared/logger';

const log = createLogger({ service: 'sentinel-worker' }).child({ component: 'poll-sweep' });

export const pollSweepHandler: JobHandler = {
  jobName: 'registry.poll-sweep',
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
    const failedIds: string[] = [];

    // Batch-load all stored versions for every due artifact in a single query
    // instead of issuing one SELECT per artifact (N+1 pattern).
    const artifactIds = enabledDue.map((a) => a.id);
    const allVersionRows = await db
      .select()
      .from(rcArtifactVersions)
      .where(inArray(rcArtifactVersions.artifactId, artifactIds));

    // Group version rows by artifactId for O(1) lookup below.
    const versionsByArtifactId = new Map<string, typeof allVersionRows>();
    for (const row of allVersionRows) {
      const list = versionsByArtifactId.get(row.artifactId) ?? [];
      list.push(row);
      versionsByArtifactId.set(row.artifactId, list);
    }

    for (const artifact of enabledDue) {
      const dbVersions = versionsByArtifactId.get(artifact.id) ?? [];

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
        credentialsEncrypted: artifact.credentialsEncrypted,
      };

      try {
        await moduleJobsQueue.add(
          'registry.poll',
          { artifact: monitoredArtifact },
          { jobId: `poll-${artifact.id}-${Date.now()}` },
        );
        log.debug({ artifactId: artifact.id, name: artifact.name }, 'Enqueued poll job');
      } catch (err) {
        log.error({ err, artifactId: artifact.id, name: artifact.name }, 'Failed to enqueue poll job');
        failedIds.push(artifact.id);
      }
    }

    if (failedIds.length > 0) {
      throw new Error(`Failed to enqueue ${failedIds.length}/${enabledDue.length} registry poll job(s): ${failedIds.join(', ')}`);
    }
  },
};
