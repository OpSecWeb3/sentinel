/**
 * AWS module BullMQ job handlers.
 *
 * aws.sqs.poll       — polls an SQS queue for CloudTrail event notifications
 * aws.event.process  — parses and promotes a raw event to the platform events table
 * aws.poll-sweep     — scheduled sweep that enqueues poll jobs for due integrations
 */
import type { Job } from 'bullmq';
import { getDb, eq, sql, and, lte } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import { awsIntegrations, awsRawEvents } from '@sentinel/db/schema/aws';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { decrypt } from '@sentinel/shared/crypto';
import { logger as rootLogger } from '@sentinel/shared/logger';
import { normalizeCloudTrailEvent, extractPrincipal } from './normalizer.js';

const log = rootLogger.child({ component: 'aws' });

// ---------------------------------------------------------------------------
// Helper: build SQS client for an integration
// ---------------------------------------------------------------------------

interface IntegrationAuth {
  roleArn: string | null;
  credentialsEncrypted: string | null;
  externalId: string | null;
  sqsRegion: string;
}

async function buildSqsClient(integration: IntegrationAuth) {
  const { SQSClient } = await import('@aws-sdk/client-sqs');

  if (integration.roleArn) {
    const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
    const stsClient = new STSClient({ region: integration.sqsRegion });

    const assumed = await stsClient.send(new AssumeRoleCommand({
      RoleArn: integration.roleArn,
      RoleSessionName: 'sentinel-aws-module',
      DurationSeconds: 3600,
      ...(integration.externalId ? { ExternalId: integration.externalId } : {}),
    }));
    const creds = assumed.Credentials;
    if (!creds) throw new Error('Failed to assume IAM role — no credentials returned');

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
    const now = new Date();

    const due = await db
      .select({ id: awsIntegrations.id, orgId: awsIntegrations.orgId })
      .from(awsIntegrations)
      .where(
        and(
          eq(awsIntegrations.enabled, true),
          eq(awsIntegrations.status, 'active'),
        ),
      );

    if (due.length === 0) return;

    const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
    await Promise.all(
      due.map((row) =>
        queue.add('aws.sqs.poll', { integrationId: row.id, orgId: row.orgId }, {
          jobId: `aws-poll-${row.id}-${Math.floor(now.getTime() / 60_000)}`,
          removeOnComplete: { age: 300 },
          removeOnFail: { age: 3600 },
        }),
      ),
    );

    log.debug({ count: due.length }, 'Enqueued SQS poll jobs');
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
  const eventId = (record.eventID ?? record.id ?? `eb-${Date.now()}-${Math.random()}`) as string;

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
