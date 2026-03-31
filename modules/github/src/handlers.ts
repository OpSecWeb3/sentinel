/**
 * GitHub module BullMQ job handlers.
 */
import type { Job } from 'bullmq';
import { getDb, eq, and } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import { githubInstallations, githubRepositories } from '@sentinel/db/schema/github';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { logger as rootLogger } from '@sentinel/shared/logger';
import { normalizeGitHubEvent } from './normalizer.js';
import { syncRepositories, type SyncOptions } from './sync.js';

const log = rootLogger.child({ component: 'github' });

export const webhookProcessHandler: JobHandler = {
  jobName: 'github.webhook.process',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { deliveryId, eventType, payload, orgId } = job.data as {
      deliveryId: string;
      eventType: string;
      payload: Record<string, unknown>;
      installationId: string;
      orgId: string;
    };

    // Normalize the GitHub event
    const normalized = normalizeGitHubEvent(eventType, payload, deliveryId, orgId);
    if (!normalized) {
      log.debug({ eventType, deliveryId }, 'Skipping unhandled event type');
      return;
    }

    // Bug #11 fix: handle installation lifecycle status updates with await,
    // so failures are surfaced and the installation status stays consistent.
    await handleInstallationLifecycle(normalized.eventType, payload);

    const db = getDb();

    // Update repo visibility in DB when it changes via webhook
    if (normalized.eventType === 'github.repository.visibility_changed') {
      const repo = payload.repository as { id?: number; visibility?: string } | undefined;
      if (repo?.id && repo.visibility) {
        await db
          .update(githubRepositories)
          .set({ visibility: repo.visibility })
          .where(
            and(
              eq(githubRepositories.orgId, orgId),
              eq(githubRepositories.repoId, BigInt(repo.id)),
            ),
          );
      }
    }

    // Store normalized event
    const [event] = await db.insert(events).values(normalized).returning();

    // Enqueue rule evaluation
    const eventsQueue = getQueue(QUEUE_NAMES.EVENTS);
    await eventsQueue.add('event.evaluate', { eventId: event.id });

    log.info({ rawEventType: eventType, eventType: normalized.eventType, eventId: event.id }, 'Processed webhook event');
  },
};

// ---------------------------------------------------------------------------
// github.repo.sync — background repository sync for an installation
// ---------------------------------------------------------------------------

export const repoSyncHandler: JobHandler = {
  jobName: 'github.repo.sync',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { installationId, options } = job.data as {
      installationId: string;
      orgId: string;
      options?: SyncOptions;
    };

    const syncOptions: SyncOptions = {
      excludeArchived: true,
      excludeForks: false,
      ...options,
    };

    const result = await syncRepositories(installationId, syncOptions);

    log.info({ jobId: job.id, added: result.added, updated: result.updated, removed: result.removed, unchanged: result.unchanged }, 'Repo sync complete');
  },
};

// ---------------------------------------------------------------------------
// Installation lifecycle — update status in DB (Bug #11 fix)
// ---------------------------------------------------------------------------

const INSTALLATION_STATUS_MAP: Record<string, 'removed' | 'suspended' | 'active'> = {
  'github.installation.deleted': 'removed',
  'github.installation.suspended': 'suspended',
  'github.installation.unsuspended': 'active',
};

async function handleInstallationLifecycle(
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const newStatus = INSTALLATION_STATUS_MAP[eventType];
  if (!newStatus) return;

  const installation = payload.installation as Record<string, unknown> | undefined;
  if (!installation?.id) return;

  const githubInstallationId = BigInt(installation.id as number);
  const db = getDb();
  await db.update(githubInstallations)
    .set({ status: newStatus })
    .where(eq(githubInstallations.installationId, githubInstallationId));

  log.info({ githubInstallationId: githubInstallationId.toString(), newStatus }, 'Installation status updated');
}
