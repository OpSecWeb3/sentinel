/**
 * AWS module BullMQ job handlers.
 *
 * aws.sqs.poll       — polls an SQS queue for CloudTrail event notifications
 * aws.event.process  — parses and promotes a raw event to the platform events table
 * aws.poll-sweep     — scheduled sweep that enqueues poll jobs for due integrations
 */
import type { Job } from 'bullmq';
import { getDb, eq, sql, and, lte, or, isNull } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import { awsIntegrations, awsRawEvents } from '@sentinel/db/schema/aws';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { decrypt } from '@sentinel/shared/crypto';
import { logger as rootLogger } from '@sentinel/shared/logger';
import { createHash } from 'node:crypto';
import { normalizeCloudTrailEvent, extractPrincipal } from './normalizer.js';

const log = rootLogger.child({ component: 'aws' });

// ---------------------------------------------------------------------------
// Helper: build SQS client for an integration
// ---------------------------------------------------------------------------

interface IntegrationAuth {
  roleArn: string | null;
  credentialsEncrypted: string | null;
  externalId: string | null;
  externalIdEnforced: boolean;
  sqsRegion: string;
}

/**
 * Cached credentials from assuming the SentinelService intermediate role.
 * Shared across all integrations — only the second hop (customer role) varies.
 */
let cachedSentinelCreds: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string | undefined;
  expiresAt: number;
} | null = null;

const AWS_STS_TIMEOUT_MS = 10_000;

/**
 * Assume the SentinelService intermediate role using the bootstrap IAM user
 * credentials from the environment. Returns cached credentials when still valid.
 *
 * This is the first hop in the chain:
 *   IAM User (env creds) → SentinelService role → customer role
 */
async function getSentinelRoleCredentials(region: string) {
  const sentinelRoleArn = process.env.AWS_SENTINEL_ROLE_ARN;
  if (!sentinelRoleArn) return undefined;

  // Return cached credentials if still valid (refresh 5 min before expiry)
  const now = Date.now();
  if (cachedSentinelCreds && cachedSentinelCreds.expiresAt > now + 5 * 60_000) {
    return cachedSentinelCreds;
  }

  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ region });
  const result = await sts.send(new AssumeRoleCommand({
    RoleArn: sentinelRoleArn,
    RoleSessionName: 'sentinel-service',
    DurationSeconds: 3600,
  }), { abortSignal: AbortSignal.timeout(AWS_STS_TIMEOUT_MS) });

  const creds = result.Credentials;
  if (!creds) throw new Error('Failed to assume SentinelService role — no credentials returned');

  cachedSentinelCreds = {
    accessKeyId: creds.AccessKeyId!,
    secretAccessKey: creds.SecretAccessKey!,
    sessionToken: creds.SessionToken,
    expiresAt: creds.Expiration ? creds.Expiration.getTime() : now + 3600_000,
  };

  log.info('Assumed SentinelService role — credentials cached until refresh');
  return cachedSentinelCreds;
}

async function buildSqsClient(integration: IntegrationAuth) {
  const { SQSClient } = await import('@aws-sdk/client-sqs');

  if (integration.roleArn) {
    const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');

    // First hop: assume SentinelService role (if configured).
    // Required when running off-AWS with IAM user env creds, because the
    // customer's trust policy trusts the SentinelService role, not the user.
    // When running on AWS with an instance profile that IS the SentinelService
    // role, AWS_SENTINEL_ROLE_ARN is not set and this is a no-op.
    const sentinelCreds = await getSentinelRoleCredentials(integration.sqsRegion);

    // Second hop: assume the customer's cross-account role.
    const stsClient = new STSClient({
      region: integration.sqsRegion,
      ...(sentinelCreds ? { credentials: sentinelCreds } : {}),
    });

    const assumed = await stsClient.send(new AssumeRoleCommand({
      RoleArn: integration.roleArn,
      RoleSessionName: 'sentinel-aws-module',
      DurationSeconds: 3600,
      ...(integration.externalIdEnforced && integration.externalId ? { ExternalId: integration.externalId } : {}),
    }), { abortSignal: AbortSignal.timeout(AWS_STS_TIMEOUT_MS) });
    const creds = assumed.Credentials;
    if (!creds) throw new Error('Failed to assume customer IAM role — no credentials returned');

    return new SQSClient({
      region: integration.sqsRegion,
      credentials: {
        accessKeyId: creds.AccessKeyId!,
        secretAccessKey: creds.SecretAccessKey!,
        sessionToken: creds.SessionToken,
      },
    });
  }

  if (integration.credentialsEncrypted) {
    const raw = decrypt(integration.credentialsEncrypted);
    const parsed = JSON.parse(raw) as { accessKeyId: string; secretAccessKey: string };
    return new SQSClient({
      region: integration.sqsRegion,
      credentials: {
        accessKeyId: parsed.accessKeyId,
        secretAccessKey: parsed.secretAccessKey,
      },
    });
  }

  // Fall back to the environment / instance profile credentials
  return new SQSClient({ region: integration.sqsRegion });
}

// ---------------------------------------------------------------------------
// aws.poll-sweep — scheduled every 60 seconds; enqueues poll jobs for due
//                  integrations
// ---------------------------------------------------------------------------

export const pollSweepHandler: JobHandler = {
  jobName: 'aws.poll-sweep',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(_job: Job) {
    const db = getDb();
    const now = new Date().toISOString();

    // Clean up abandoned setup integrations older than 24 hours
    const stale = await db.delete(awsIntegrations)
      .where(
        and(
          eq(awsIntegrations.status, 'setup'),
          lte(awsIntegrations.createdAt, sql`NOW() - interval '24 hours'`),
        ),
      )
      .returning({ id: awsIntegrations.id });

    if (stale.length > 0) {
      log.info({ count: stale.length }, 'Cleaned up stale setup integrations');
    }

    const due = await db
      .select({ id: awsIntegrations.id, orgId: awsIntegrations.orgId })
      .from(awsIntegrations)
      .where(
        and(
          eq(awsIntegrations.enabled, true),
          eq(awsIntegrations.status, 'active'),
          or(
            isNull(awsIntegrations.lastPolledAt),
            lte(
              sql`${awsIntegrations.lastPolledAt} + (${awsIntegrations.pollIntervalSeconds} * interval '1 second')`,
              now,
            ),
          ),
        ),
      );

    if (due.length === 0) return;

    const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
    const failedIds: string[] = [];
    for (const row of due) {
      try {
        await queue.add('aws.sqs.poll', { integrationId: row.id, orgId: row.orgId }, {
          jobId: `aws-poll-${row.id}-${Math.floor(Date.now() / 60_000)}`,
          removeOnComplete: { age: 300 },
          removeOnFail: { age: 3600 },
        });
      } catch (err) {
        log.error({ err, integrationId: row.id }, 'Failed to enqueue SQS poll job');
        failedIds.push(row.id);
      }
    }

    log.debug({ count: due.length, failed: failedIds.length }, 'Enqueued SQS poll jobs');

    if (failedIds.length > 0) {
      throw new Error(`Failed to enqueue ${failedIds.length}/${due.length} SQS poll job(s): ${failedIds.join(', ')}`);
    }
  },
};

// ---------------------------------------------------------------------------
// aws.sqs.poll — polls an SQS queue and stores raw CloudTrail events
// ---------------------------------------------------------------------------

export const sqsPollHandler: JobHandler = {
  jobName: 'aws.sqs.poll',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { integrationId, orgId } = job.data as { integrationId: string; orgId: string };
    const db = getDb();

    const [integration] = await db
      .select()
      .from(awsIntegrations)
      .where(eq(awsIntegrations.id, integrationId))
      .limit(1);

    if (!integration || !integration.enabled) return;
    if (!integration.sqsQueueUrl) {
      log.debug({ integrationId }, 'No SQS queue URL configured — skipping poll');
      return;
    }

    let client: Awaited<ReturnType<typeof buildSqsClient>>;
    try {
      client = await buildSqsClient({
        roleArn: integration.roleArn,
        credentialsEncrypted: integration.credentialsEncrypted,
        externalId: integration.externalId,
        externalIdEnforced: integration.externalIdEnforced,
        sqsRegion: integration.sqsRegion,
      });
    } catch (err) {
      log.error({ err, integrationId }, 'Failed to build SQS client');
      await db.update(awsIntegrations)
        .set({ status: 'error', errorMessage: String(err) })
        .where(eq(awsIntegrations.id, integrationId));
      return;
    }

    const { ReceiveMessageCommand, DeleteMessageCommand } = await import('@aws-sdk/client-sqs');

    let processed = 0;
    let batchCount = 0;
    const maxBatches = 10; // max 100 messages per poll run

    while (batchCount < maxBatches) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: integration.sqsQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
          VisibilityTimeout: 30,
        }),
      );

      const messages = response.Messages ?? [];
      if (messages.length === 0) break;

      const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);

      for (const msg of messages) {
        if (!msg.Body || !msg.ReceiptHandle) continue;

        try {
          const records = parseCloudTrailMessage(msg.Body);
          for (const record of records) {
            await storeRawEvent(db, integrationId, orgId, record);
            const rawId = await getRawEventId(db, integrationId, record.eventID as string);
            if (rawId) {
              await queue.add('aws.event.process', { rawEventId: rawId, orgId }, {
                removeOnComplete: { age: 3600 },
                removeOnFail: { age: 86400 },
              });
            }
            processed++;
          }

          // Delete the message from the queue after successful processing
          await client.send(new DeleteMessageCommand({
            QueueUrl: integration.sqsQueueUrl!,
            ReceiptHandle: msg.ReceiptHandle,
          }));
        } catch (err) {
          log.warn({ err, messageId: msg.MessageId }, 'Failed to process SQS message');
        }
      }

      batchCount++;
    }

    await db.update(awsIntegrations)
      .set({ lastPolledAt: new Date(), status: 'active', errorMessage: null })
      .where(eq(awsIntegrations.id, integrationId));

    if (processed > 0) {
      log.info({ integrationId, processed }, 'SQS poll complete');
    }
  },
};

// ---------------------------------------------------------------------------
// aws.event.process — normalizes a raw event and promotes it to platform
// ---------------------------------------------------------------------------

export const eventProcessHandler: JobHandler = {
  jobName: 'aws.event.process',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { rawEventId, orgId } = job.data as { rawEventId: bigint | string; orgId: string };
    const db = getDb();

    const [raw] = await db
      .select()
      .from(awsRawEvents)
      .where(eq(awsRawEvents.id, BigInt(rawEventId)))
      .limit(1);

    if (!raw || raw.promoted) return;

    const payload = raw.rawPayload as Record<string, unknown>;
    const normalized = normalizeCloudTrailEvent(payload, orgId);
    if (!normalized) {
      log.debug({ rawEventId }, 'Could not normalize CloudTrail event — skipping');
      return;
    }

    // Write to platform events table for rule evaluation
    const [event] = await db.insert(events).values({
      orgId: normalized.orgId,
      moduleId: normalized.moduleId,
      eventType: normalized.eventType,
      externalId: normalized.externalId,
      payload: normalized.payload,
      occurredAt: normalized.occurredAt,
    }).returning();

    // Mark raw event as promoted
    await db.update(awsRawEvents)
      .set({ promoted: true, platformEventId: event.id })
      .where(eq(awsRawEvents.id, BigInt(rawEventId)));

    // Enqueue rule evaluation
    const eventsQueue = getQueue(QUEUE_NAMES.EVENTS);
    await eventsQueue.add('event.evaluate', { eventId: event.id });

    log.debug({ rawEventId, eventId: event.id, eventType: event.eventType }, 'Promoted CloudTrail event');
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCloudTrailMessage(body: string): Record<string, unknown>[] {
  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return [];
  }

  // S3 event notification wrapping (SNS → SQS → CloudTrail S3 object key)
  // For simplicity we handle the common EventBridge → SQS direct delivery pattern
  // where the body IS the CloudTrail event object, or is an SNS notification
  // with a Message field containing the event.

  // SNS wrapper
  if (outer.Type === 'Notification' && typeof outer.Message === 'string') {
    try {
      outer = JSON.parse(outer.Message) as Record<string, unknown>;
    } catch {
      return [];
    }
  }

  // CloudTrail API event delivered directly via EventBridge
  if (outer.eventName && outer.eventSource) {
    return [outer];
  }

  // Native EventBridge event (e.g. Spot Instance Interruption Warning)
  // These have 'detail-type', 'source', and 'detail' fields instead of
  // CloudTrail's eventName/eventSource.
  if (outer['detail-type'] && outer.source && outer.detail) {
    return [outer];
  }

  // CloudTrail batch via S3 notification contains Records[] pointing to S3 keys.
  // We don't download S3 objects here — that would require S3 access.
  // Instead, users should configure EventBridge → SQS for direct delivery.
  if (Array.isArray(outer.Records)) {
    const direct = (outer.Records as Record<string, unknown>[]).filter(
      (r) => (r.eventName && r.eventSource) || (r['detail-type'] && r.source),
    );
    if (direct.length > 0) return direct;
  }

  return [];
}

async function storeRawEvent(
  db: ReturnType<typeof getDb>,
  integrationId: string,
  orgId: string,
  record: Record<string, unknown>,
): Promise<void> {
  const principal = extractPrincipal(record);
  // Native EventBridge events use 'id'; CloudTrail events use 'eventID'
  // Deterministic fallback: derive an ID from content so duplicate processing
  // of the same event hits the onConflictDoNothing() dedup correctly.
  // Previously used `Date.now()-Math.random()` which created a new ID every time.
  const eventId = (record.eventID ?? record.id ?? deterministicEventId(record)) as string;

  // Upsert — skip if already stored (idempotent)
  // Support both CloudTrail events and native EventBridge events
  const isEventBridge = !record.eventName && record['detail-type'];
  const eventName = isEventBridge
    ? (record['detail-type'] as string)
    : (record.eventName as string);
  const eventSource = isEventBridge
    ? (record.source as string ?? 'aws.events')
    : (record.eventSource as string);
  const awsRegion = (record.awsRegion ?? record.region ?? '') as string;
  const eventTime = record.eventTime
    ? new Date(record.eventTime as string)
    : record.time
      ? new Date(record.time as string)
      : new Date();

  await db.insert(awsRawEvents).values({
    orgId,
    integrationId,
    cloudTrailEventId: eventId,
    eventName,
    eventSource,
    eventVersion: record.eventVersion as string ?? null,
    awsRegion,
    principalId: principal.principalId,
    userArn: principal.userArn,
    accountId: (principal.accountId ?? record.account) as string ?? null,
    userType: principal.userType,
    sourceIpAddress: record.sourceIPAddress as string ?? null,
    userAgent: record.userAgent as string ?? null,
    errorCode: record.errorCode as string ?? null,
    errorMessage: record.errorMessage as string ?? null,
    resources: (record.resources as object) ?? null,
    rawPayload: record,
    eventTime,
  }).onConflictDoNothing();
}

/**
 * Build a deterministic event ID from the record content so that duplicate
 * deliveries of the same event are de-duplicated by the DB unique constraint.
 */
function deterministicEventId(record: Record<string, unknown>): string {
  // Use fields that uniquely identify an EventBridge event even when 'id' is missing
  const source = (record.source ?? record['detail-type'] ?? '') as string;
  const time = (record.time ?? record.eventTime ?? '') as string;
  const account = (record.account ?? '') as string;
  const detail = record.detail ? JSON.stringify(record.detail) : '';
  const hash = createHash('sha256')
    .update(`${source}|${time}|${account}|${detail}`)
    .digest('hex')
    .slice(0, 24);
  return `eb-${hash}`;
}

async function getRawEventId(
  db: ReturnType<typeof getDb>,
  integrationId: string,
  cloudTrailEventId: string,
): Promise<bigint | null> {
  const [row] = await db
    .select({ id: awsRawEvents.id })
    .from(awsRawEvents)
    .where(
      and(
        eq(awsRawEvents.integrationId, integrationId),
        eq(awsRawEvents.cloudTrailEventId, cloudTrailEventId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
