/**
 * Release-chain module BullMQ job handlers.
 *
 * Follows the same JobHandler pattern as the GitHub module.
 */
import { logger as rootLogger } from '@sentinel/shared/logger';
import type { Job } from 'bullmq';
import { getDb } from '@sentinel/db';
import { events, rules } from '@sentinel/db/schema/core';
import {
  rcArtifacts,
  rcArtifactEvents,
  rcArtifactVersions,
  rcCiNotifications,
} from '@sentinel/db/schema/release-chain';
import { eq, and } from '@sentinel/db';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { getChildResults } from '@sentinel/shared/fan-out';
import {
  normalizeDockerWebhook,
  normalizeNpmWebhook,
  type DockerHubWebhookPayload,
  type NpmEventPayload,
  type CiNotificationPayload,
} from './normalizer.js';
import { pollArtifact, type MonitoredArtifact } from './polling.js';
export { verifyHandler } from './verification.js';

const log = rootLogger.child({ component: 'release-chain' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely enqueue a job to a BullMQ queue.
 * Returns true if enqueued, false if Redis/queue was unavailable.
 */
async function safeEnqueue(
  queueName: string,
  jobName: string,
  data: Record<string, unknown>,
  opts?: Record<string, unknown>,
): Promise<boolean> {
  try {
    const queue = getQueue(queueName);
    await queue.add(jobName, data, opts);
    return true;
  } catch (err) {
    log.error({ err, jobName, queueName }, 'Failed to enqueue job');
    return false;
  }
}

/**
 * Look up the rcArtifact row for a given artifact name + orgId.
 * Returns null if no monitored artifact is configured.
 */
async function findArtifact(orgId: string, artifactName: string) {
  const db = getDb();
  const [artifact] = await db
    .select()
    .from(rcArtifacts)
    .where(and(eq(rcArtifacts.orgId, orgId), eq(rcArtifacts.name, artifactName)))
    .limit(1);
  return artifact ?? null;
}

/**
 * Insert into rcArtifactEvents, linking a core event to the release-chain
 * module-specific table.
 */
async function insertArtifactEvent(params: {
  eventId: string;
  artifactId: string;
  versionId?: string | null;
  artifactEventType: string;
  version: string;
  oldDigest?: string | null;
  newDigest?: string | null;
  pusher?: string | null;
  source: string;
  metadata?: Record<string, unknown>;
}) {
  const db = getDb();
  const [row] = await db
    .insert(rcArtifactEvents)
    .values({
      eventId: params.eventId,
      artifactId: params.artifactId,
      versionId: params.versionId ?? null,
      artifactEventType: params.artifactEventType,
      version: params.version,
      oldDigest: params.oldDigest ?? null,
      newDigest: params.newDigest ?? null,
      pusher: params.pusher ?? null,
      source: params.source,
      metadata: params.metadata ?? {},
    })
    .returning();
  return row;
}

/**
 * Upsert into rcArtifactVersions when a new tag/version is seen or a digest changes.
 */
async function upsertArtifactVersion(params: {
  artifactId: string;
  version: string;
  digest: string | null;
  metadata?: Record<string, unknown>;
}) {
  const db = getDb();
  // Try to find existing
  const [existing] = await db
    .select()
    .from(rcArtifactVersions)
    .where(
      and(
        eq(rcArtifactVersions.artifactId, params.artifactId),
        eq(rcArtifactVersions.version, params.version),
      ),
    )
    .limit(1);

  if (existing) {
    // Update digest if changed
    if (params.digest && existing.currentDigest !== params.digest) {
      await db
        .update(rcArtifactVersions)
        .set({
          currentDigest: params.digest,
          digestChangedAt: new Date(),
          metadata: params.metadata ?? existing.metadata,
        })
        .where(eq(rcArtifactVersions.id, existing.id));
    }
    return existing;
  }

  // Insert new
  const [row] = await db
    .insert(rcArtifactVersions)
    .values({
      artifactId: params.artifactId,
      version: params.version,
      currentDigest: params.digest,
      status: 'active',
      metadata: params.metadata ?? {},
    })
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// release-chain.webhook.process
// Process incoming Docker Hub / npm webhook payloads.
// ---------------------------------------------------------------------------

export const webhookProcessHandler: JobHandler = {
  jobName: 'release-chain.webhook.process',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { source, payload, orgId, externalId } = job.data as {
      source: 'docker' | 'npm';
      payload: Record<string, unknown>;
      orgId: string;
      externalId?: string;
    };

    let normalized;
    if (source === 'docker') {
      normalized = normalizeDockerWebhook(
        payload as unknown as DockerHubWebhookPayload,
        orgId,
        externalId,
      );
    } else {
      normalized = normalizeNpmWebhook(
        payload as unknown as NpmEventPayload,
        orgId,
        externalId,
      );
    }

    if (!normalized) {
      log.debug({ source, orgId }, 'Skipping unhandled webhook');
      return;
    }

    const db = getDb();
    const normalizedPayload = normalized.payload as Record<string, unknown>;
    const artifactName = normalizedPayload.artifact as string | undefined;
    const tag = normalizedPayload.tag as string | undefined;

    // Fix #11: For Docker webhooks, check if tag already exists to distinguish
    // new_tag vs digest_change
    if (
      source === 'docker' &&
      normalized.eventType === 'release-chain.docker.new_tag' &&
      artifactName &&
      tag
    ) {
      const artifact = await findArtifact(orgId, artifactName);
      if (artifact) {
        const [existingVersion] = await db
          .select()
          .from(rcArtifactVersions)
          .where(
            and(
              eq(rcArtifactVersions.artifactId, artifact.id),
              eq(rcArtifactVersions.version, tag),
            ),
          )
          .limit(1);

        if (existingVersion) {
          // Tag already exists -- this is a digest change, not a new tag
          normalized.eventType = 'release-chain.docker.digest_change';
        }
      }
    }

    // Store normalized event in core events table
    const [event] = await db.insert(events).values(normalized).returning();

    // Fix #5: Also insert into rcArtifactEvents
    if (artifactName) {
      const artifact = await findArtifact(orgId, artifactName);
      if (artifact) {
        // Derive the sub-type from the event type (e.g. 'docker.digest_change' -> 'digest_change')
        const artifactEventType = normalized.eventType.replace(
          /^release-chain\.(?:docker|npm)\./,
          '',
        );

        // Upsert version state
        let versionId: string | null = null;
        if (tag) {
          const versionRow = await upsertArtifactVersion({
            artifactId: artifact.id,
            version: tag,
            digest: (normalizedPayload.newDigest as string) ?? null,
            metadata: normalizedPayload.metadata as Record<string, unknown>,
          });
          versionId = versionRow.id;
        }

        await insertArtifactEvent({
          eventId: event.id,
          artifactId: artifact.id,
          versionId,
          artifactEventType,
          version: tag ?? '*',
          oldDigest: (normalizedPayload.oldDigest as string) ?? null,
          newDigest: (normalizedPayload.newDigest as string) ?? null,
          pusher: (normalizedPayload.pusher as string) ?? null,
          source: 'webhook',
          metadata: normalizedPayload,
        });
      }
    }

    // Enqueue rule evaluation (Fix #10: wrap in try-catch)
    await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', { eventId: event.id });

    // Schedule deferred attribution check (5 min grace period)
    if (tag) {
      await safeEnqueue(
        QUEUE_NAMES.DEFERRED,
        'release-chain.attribution',
        {
          eventId: event.id,
          artifactName: normalizedPayload.artifact as string,
          tag,
        },
        { delay: 5 * 60 * 1000, jobId: `attr-${event.id}` },
      );
    }

    log.info({ source, eventType: normalized.eventType, eventId: event.id }, 'Processed webhook');
  },
};

// ---------------------------------------------------------------------------
// release-chain.poll
// Poll Docker Hub / npm registry for changes on monitored artifacts.
// ---------------------------------------------------------------------------

export const pollHandler: JobHandler = {
  jobName: 'release-chain.poll',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { artifact } = job.data as { artifact: MonitoredArtifact };

    if (!artifact || !artifact.enabled) {
      log.debug('Poll job skipped: artifact not found or disabled');
      return;
    }

    // Fix #2: Load stored versions from DB instead of relying on job payload
    const db = getDb();
    const dbVersions = await db
      .select()
      .from(rcArtifactVersions)
      .where(eq(rcArtifactVersions.artifactId, artifact.id));

    artifact.storedVersions = new Map(
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

    // Also load lastPolledAt from rcArtifacts if not in job payload
    if (!artifact.lastPolledAt) {
      const [dbArtifact] = await db
        .select({ lastPolledAt: rcArtifacts.lastPolledAt })
        .from(rcArtifacts)
        .where(eq(rcArtifacts.id, artifact.id))
        .limit(1);
      if (dbArtifact?.lastPolledAt) {
        artifact.lastPolledAt = dbArtifact.lastPolledAt;
      }
    }

    await pollArtifact(artifact);

    log.info({ artifact: artifact.name }, 'Poll complete');
  },
};

// ---------------------------------------------------------------------------
// release-chain.attribution
// Deferred attribution check -- runs after a 5-minute grace period.
// Searches the GitHub API for a matching CI run to attribute the change.
// ---------------------------------------------------------------------------

export const attributionHandler: JobHandler = {
  jobName: 'release-chain.attribution',
  queueName: QUEUE_NAMES.DEFERRED,

  async process(job: Job) {
    const { eventId, artifactName, tag, digest } = job.data as {
      eventId: string;
      artifactName: string;
      tag: string;
      digest?: string;
    };

    log.info({ eventId, artifactName, tag }, 'Deferred attribution check');

    const db = getDb();

    // Load event
    const eventRows = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    if (eventRows.length === 0) {
      log.debug({ eventId }, 'Attribution: event not found');
      return;
    }

    const event = eventRows[0];
    const payload = event.payload as Record<string, unknown>;

    // If attribution was already resolved (CI notification arrived first), skip
    if (
      payload.attribution &&
      (payload.attribution as Record<string, unknown>).status === 'verified'
    ) {
      log.debug({ eventId }, 'Attribution already resolved');
      return;
    }

    // Fix #3: Before marking unattributed, search the GitHub API for matching
    // workflow runs using the rule's attribution criteria.
    const artifact = await findArtifact(event.orgId, artifactName);
    const githubRepo = artifact?.githubRepo;

    if (githubRepo) {
      // Load attribution rules for this org to get allowed workflows/actors/branches
      const attributionRules = await db
        .select()
        .from(rules)
        .where(
          and(
            eq(rules.orgId, event.orgId),
            eq(rules.moduleId, 'release-chain'),
            eq(rules.ruleType, 'release-chain.attribution'),
            eq(rules.status, 'active'),
          ),
        )
        .limit(10);

      for (const rule of attributionRules) {
        const config = rule.config as Record<string, unknown>;
        const workflows = (config.workflows as string[]) ?? [];
        const actors = (config.actors as string[]) ?? [];
        const branches = (config.branches as string[]) ?? [];

        // Search GitHub API for recent workflow runs that could have produced this artifact
        try {
          const ghApiBase = `https://api.github.com/repos/${githubRepo}/actions/runs`;
          const params = new URLSearchParams({
            status: 'completed',
            per_page: '20',
            created: `>=${new Date(Date.now() - 10 * 60 * 1000).toISOString()}`,
          });

          const ghResponse = await fetch(`${ghApiBase}?${params}`, {
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              ...(process.env.GITHUB_TOKEN
                ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
                : {}),
            },
          });

          if (ghResponse.ok) {
            const ghData = (await ghResponse.json()) as {
              workflow_runs: Array<{
                id: number;
                head_sha: string;
                actor: { login: string };
                path: string;
                name: string;
                head_branch: string;
                conclusion: string;
              }>;
            };

            // Find a matching run
            const matchingRun = ghData.workflow_runs.find((run) => {
              if (run.conclusion !== 'success') return false;

              const workflowOk =
                workflows.length === 0 ||
                workflows.some(
                  (w) => run.path.endsWith(w) || run.name === w,
                );
              const actorOk =
                actors.length === 0 || actors.includes(run.actor.login);
              const branchOk =
                branches.length === 0 ||
                branches.includes(run.head_branch);

              return workflowOk && actorOk && branchOk;
            });

            if (matchingRun) {
              const updatedPayload = {
                ...payload,
                attribution: {
                  status: 'inferred',
                  runId: matchingRun.id,
                  commit: matchingRun.head_sha,
                  actor: matchingRun.actor.login,
                  workflow: matchingRun.path,
                  branch: matchingRun.head_branch,
                  repo: githubRepo,
                  inferredAt: new Date().toISOString(),
                  reason: 'Matched via GitHub API search during grace period',
                },
              };

              await db
                .update(events)
                .set({ payload: updatedPayload })
                .where(eq(events.id, eventId));

              await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', {
                eventId,
                isAttributionReEval: true,
              });

              log.info({ eventId, runId: matchingRun.id }, 'Attribution inferred from GitHub run');
              return;
            }
          }
        } catch (err) {
          log.warn({ err }, 'GitHub API search failed for attribution');
          // Fall through to mark unattributed
        }
      }
    }

    // No matching CI run found -- mark as unattributed
    const updatedPayload = {
      ...payload,
      attribution: {
        status: 'unattributed',
        checkedAt: new Date().toISOString(),
        reason: 'No CI notification received and no matching GitHub workflow run found within grace period',
      },
    };

    await db
      .update(events)
      .set({ payload: updatedPayload })
      .where(eq(events.id, eventId));

    // Re-evaluate rules now that attribution status is resolved
    await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', {
      eventId,
      isAttributionReEval: true,
    });

    log.info({ eventId }, 'Attribution marked unattributed');
  },
};

// ---------------------------------------------------------------------------
// release-chain.ci.process
// Process an incoming CI notification (from GitHub Actions).
// Links the notification to a pending event if one exists.
// ---------------------------------------------------------------------------

export const ciNotifyHandler: JobHandler = {
  jobName: 'release-chain.ci.process',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { notification, orgId } = job.data as {
      notification: CiNotificationPayload;
      orgId: string;
    };

    const { image, tag, digest, runId, commit, actor, workflow, repo } =
      notification;

    log.info({ image, tag, runId, commit }, 'Processing CI notification');

    const db = getDb();

    // Fix #4 & #5: Always persist CI notification to rcCiNotifications
    let ciNotificationId: string | null = null;
    try {
      const [ciNotifRow] = await db
        .insert(rcCiNotifications)
        .values({
          orgId,
          artifactName: image,
          artifactType: image.includes('/') ? 'docker_image' : 'npm_package',
          version: tag,
          digest,
          githubRunId: BigInt(runId),
          githubCommit: commit,
          githubActor: actor,
          githubWorkflow: workflow,
          githubRepo: repo,
        })
        .returning();
      ciNotificationId = ciNotifRow.id;
    } catch (err) {
      log.warn({ err }, 'Failed to persist CI notification to rcCiNotifications');
    }

    // Fix #4: Require digest matching -- do not fall through when digest is absent
    if (!digest) {
      log.debug({ image, tag }, 'CI notification has no digest, skipping event matching');
      return;
    }

    // Search for a pending event matching this artifact + tag + digest
    const matchingEvents = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.orgId, orgId),
          eq(events.moduleId, 'release-chain'),
        ),
      )
      .limit(50);

    // Fix #4: Require digest matching -- p.newDigest must equal digest
    const matched = matchingEvents.find((e) => {
      const p = e.payload as Record<string, unknown>;
      return (
        p.artifact === image &&
        p.tag === tag &&
        p.newDigest === digest
      );
    });

    if (matched) {
      // Link CI data to the event
      const payload = matched.payload as Record<string, unknown>;
      const updatedPayload = {
        ...payload,
        attribution: {
          status: 'verified',
          runId,
          commit,
          actor,
          workflow,
          repo,
          verifiedAt: new Date().toISOString(),
        },
      };

      await db
        .update(events)
        .set({ payload: updatedPayload })
        .where(eq(events.id, matched.id));

      // Update CI notification with matched event link
      if (ciNotificationId) {
        // Find the rcArtifactEvent linked to this core event
        const [artifactEvent] = await db
          .select()
          .from(rcArtifactEvents)
          .where(eq(rcArtifactEvents.eventId, matched.id))
          .limit(1);

        if (artifactEvent) {
          try {
            await db
              .update(rcCiNotifications)
              .set({
                verified: true,
                verifiedAt: new Date(),
                matchedArtifactEventId: artifactEvent.id,
              })
              .where(eq(rcCiNotifications.id, ciNotificationId));
          } catch (err) {
            log.debug({ err, ciNotificationId }, 'Non-critical: failed to update CI notification verification status');
          }
        }
      }

      // Re-evaluate rules with attribution data
      await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', {
        eventId: matched.id,
        isAttributionReEval: true,
      });

      log.info({ eventId: matched.id }, 'CI notification matched event');
    } else {
      log.debug({ image, tag, digest: digest.slice(0, 16) }, 'CI notification persisted, no pending event found');
    }
  },
};

// ---------------------------------------------------------------------------
// release-chain.verify.aggregate
// Fan-in handler: aggregates results from parallel verification + attribution
// child jobs and triggers final evaluation.
// ---------------------------------------------------------------------------

interface VerifyAggregateChildResult {
  step: string;
  eventId?: string;
  status: 'success' | 'failed' | 'skipped';
  details?: Record<string, unknown>;
}

export const verifyAggregateHandler: JobHandler = {
  jobName: 'release-chain.verify.aggregate',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { artifactName, tag, eventId, orgId } = job.data as {
      artifactName: string;
      tag: string;
      eventId: string;
      orgId: string;
    };

    const fanIn = await getChildResults<VerifyAggregateChildResult>(job);

    const results = Object.values(fanIn.childResults);
    const failedSteps = results.filter((r) => r.status === 'failed');

    log.info({
      artifactName,
      tag,
      successCount: fanIn.successCount,
      failedCount: failedSteps.length,
    }, 'Verify aggregate completed');

    // Merge child step results into the event payload for downstream evaluation
    const db = getDb();
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    if (event) {
      const payload = event.payload as Record<string, unknown>;
      const pipelineResults: Record<string, unknown> = {};
      for (const result of results) {
        pipelineResults[result.step] = {
          status: result.status,
          ...(result.details ?? {}),
        };
      }

      await db
        .update(events)
        .set({
          payload: { ...payload, pipelineResults },
        })
        .where(eq(events.id, eventId));

      // Re-evaluate rules with the aggregated pipeline data
      await safeEnqueue(QUEUE_NAMES.EVENTS, 'event.evaluate', {
        eventId,
        isPipelineReEval: true,
      });
    }
  },
};
