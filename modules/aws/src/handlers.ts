/**
 * AWS module BullMQ job handlers.
 *
 * aws.sqs.poll       — polls an SQS queue; normalises records and inserts
 *                      directly into the platform `events` table
 * aws.event.process  — drain shim for jobs enqueued by the prior raw-events
 *                      pipeline; removed in a follow-up release
 * aws.poll-sweep     — scheduled sweep that enqueues poll jobs for due integrations
 */
import type { Job } from 'bullmq';
import { getDb, eq, sql, and, lte, or, isNull } from '@sentinel/db';
import { events } from '@sentinel/db/schema/core';
import { awsIntegrations } from '@sentinel/db/schema/aws';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import { captureException } from '@sentinel/shared/sentry';
import { decrypt } from '@sentinel/shared/crypto';
import { logger as rootLogger } from '@sentinel/shared/logger';
import { gunzipSync } from 'node:zlib';
import { normalizeCloudTrailEvent } from './normalizer.js';

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

/**
 * Resolve AWS credentials for a customer integration. Supports three modes:
 *   1. IAM role assumption (two-hop STS chain)
 *   2. Encrypted static credentials
 *   3. Environment / instance profile (fallback)
 */
async function getCustomerCredentials(
  integration: IntegrationAuth,
  region: string,
  sessionName: string,
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined> {
  if (integration.roleArn) {
    const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');

    // First hop: assume SentinelService role (if configured).
    const sentinelCreds = await getSentinelRoleCredentials(region);

    // Second hop: assume the customer's cross-account role.
    const stsClient = new STSClient({
      region,
      ...(sentinelCreds ? { credentials: sentinelCreds } : {}),
    });

    const assumed = await stsClient.send(new AssumeRoleCommand({
      RoleArn: integration.roleArn,
      RoleSessionName: sessionName,
      DurationSeconds: 3600,
      ...(integration.externalIdEnforced && integration.externalId ? { ExternalId: integration.externalId } : {}),
    }), { abortSignal: AbortSignal.timeout(AWS_STS_TIMEOUT_MS) });
    const creds = assumed.Credentials;
    if (!creds) throw new Error('Failed to assume customer IAM role — no credentials returned');

    return {
      accessKeyId: creds.AccessKeyId!,
      secretAccessKey: creds.SecretAccessKey!,
      sessionToken: creds.SessionToken,
    };
  }

  if (integration.credentialsEncrypted) {
    const raw = decrypt(integration.credentialsEncrypted);
    return JSON.parse(raw) as { accessKeyId: string; secretAccessKey: string };
  }

  // Fall back to the environment / instance profile credentials
  return undefined;
}

async function buildSqsClient(integration: IntegrationAuth) {
  const { SQSClient } = await import('@aws-sdk/client-sqs');
  const creds = await getCustomerCredentials(integration, integration.sqsRegion, 'sentinel-aws-module');
  return new SQSClient({
    region: integration.sqsRegion,
    ...(creds ? { credentials: creds } : {}),
  });
}

async function buildS3Client(integration: IntegrationAuth, region: string) {
  const { S3Client } = await import('@aws-sdk/client-s3');
  const creds = await getCustomerCredentials(integration, region, 'sentinel-aws-module-s3');
  return new S3Client({
    region,
    ...(creds ? { credentials: creds } : {}),
  });
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
        captureException(err, { integrationId: row.id, phase: 'aws.poll-sweep.enqueue' });
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

    const integrationAuth: IntegrationAuth = {
      roleArn: integration.roleArn,
      credentialsEncrypted: integration.credentialsEncrypted,
      externalId: integration.externalId,
      externalIdEnforced: integration.externalIdEnforced,
      sqsRegion: integration.sqsRegion,
    };

    let client: Awaited<ReturnType<typeof buildSqsClient>>;
    try {
      client = await buildSqsClient(integrationAuth);
    } catch (err) {
      log.error({ err, integrationId }, 'Failed to build SQS client');
      captureException(err, { integrationId, phase: 'aws.sqs.poll.build-client' });
      await db.update(awsIntegrations)
        .set({ status: 'error', errorMessage: String(err) })
        .where(eq(awsIntegrations.id, integrationId));
      return;
    }

    const { ReceiveMessageCommand, DeleteMessageCommand } = await import('@aws-sdk/client-sqs');

    // Lazily built on first S3 notification — reused across batches
    let s3Client: Awaited<ReturnType<typeof buildS3Client>> | null = null;

    let processed = 0;
    let batchCount = 0;
    const maxBatches = 10; // max 100 messages per poll run

    while (batchCount < maxBatches) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: integration.sqsQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
          VisibilityTimeout: 120,
        }),
      );

      const messages = response.Messages ?? [];
      if (messages.length === 0) break;

      for (const msg of messages) {
        if (!msg.Body || !msg.ReceiptHandle) continue;

        try {
          const parsed = parseCloudTrailMessage(msg.Body);
          let records: Record<string, unknown>[];

          if (parsed.type === 's3-notification') {
            // CloudTrail S3 notification — download .json.gz files
            if (!s3Client) {
              s3Client = await buildS3Client(integrationAuth, integration.sqsRegion);
            }
            records = [];
            for (const key of parsed.keys) {
              try {
                const fileRecords = await downloadTrailFile(s3Client, parsed.bucket, key);
                records.push(...fileRecords);
              } catch (s3Err) {
                log.warn({ err: s3Err, bucket: parsed.bucket, key }, 'Failed to download CloudTrail log file from S3');
                captureException(s3Err, {
                  integrationId,
                  bucket: parsed.bucket,
                  key,
                  phase: 'aws.sqs.poll.s3-download',
                });
                // Re-throw so this message stays in the queue for retry
                throw s3Err;
              }
            }
            log.debug({ integrationId, bucket: parsed.bucket, keys: parsed.keys.length, records: records.length },
              'Downloaded CloudTrail log files from S3');
          } else {
            records = parsed.records;
          }

          const eventsQueue = getQueue(QUEUE_NAMES.EVENTS);
          for (const record of records) {
            const normalized = normalizeCloudTrailEvent(record, orgId);
            if (!normalized) continue;

            // Stash the Sentinel-side integration id into the payload so
            // /modules/aws/events can still filter by integration after the
            // raw-events table was dropped. Underscore prefix to flag this as
            // a Sentinel internal field rather than a CloudTrail one.
            const payloadWithIntegration = {
              ...(normalized.payload as Record<string, unknown>),
              _integrationId: integrationId,
            };

            // Insert directly into the platform events table. SQS redeliveries
            // land on the partial unique index (orgId, moduleId, externalId)
            // and do nothing on conflict; `returning()` yields no row in that
            // case, so we skip re-enqueueing `event.evaluate`.
            const [event] = await db.insert(events).values({
              orgId: normalized.orgId,
              moduleId: normalized.moduleId,
              eventType: normalized.eventType,
              externalId: normalized.externalId,
              payload: payloadWithIntegration,
              occurredAt: normalized.occurredAt,
            }).onConflictDoNothing().returning();

            if (event) {
              await eventsQueue.add('event.evaluate', { eventId: event.id });
              processed++;
            }
          }

          // Delete the message from the queue after successful processing
          await client.send(new DeleteMessageCommand({
            QueueUrl: integration.sqsQueueUrl!,
            ReceiptHandle: msg.ReceiptHandle,
          }));
        } catch (err) {
          log.warn({ err, messageId: msg.MessageId }, 'Failed to process SQS message');
          captureException(err, {
            integrationId,
            messageId: msg.MessageId ?? undefined,
            phase: 'aws.sqs.poll.message',
          });
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
// aws.event.process — drain shim
// ---------------------------------------------------------------------------
// Prior to the aws_raw_events collapse, SQS poll enqueued one of these jobs
// per record to read the raw row and promote it into the events table. New
// ingestion inlines normalise+insert directly on the poll path, so the job
// is no longer enqueued. This shim completes any jobs queued by the previous
// worker version so they drain cleanly instead of failing into the DLQ.
// Remove in a follow-up release after the table-drop migration ships.
export const eventProcessHandler: JobHandler = {
  jobName: 'aws.event.process',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    log.debug(
      { rawEventId: (job.data as { rawEventId?: string } | null)?.rawEventId },
      'aws.event.process drain shim — no-op',
    );
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CloudTrail S3 notification detection
// ---------------------------------------------------------------------------

interface S3NotificationPayload {
  s3Bucket: string;
  s3ObjectKey: string[];
}

function isCloudTrailS3Notification(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.s3Bucket === 'string' &&
    Array.isArray(obj.s3ObjectKey) &&
    obj.s3ObjectKey.length > 0 &&
    obj.s3ObjectKey.every((k: unknown) => typeof k === 'string')
  );
}

/**
 * Download a CloudTrail .json.gz log file from S3, decompress, and return
 * the individual CloudTrail event records.
 */
async function downloadTrailFile(
  s3Client: Awaited<ReturnType<typeof buildS3Client>>,
  bucket: string,
  key: string,
): Promise<Record<string, unknown>[]> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

  if (!response.Body) return [];

  const compressed = Buffer.from(await response.Body.transformToByteArray());
  const decompressed = gunzipSync(compressed);
  const parsed = JSON.parse(decompressed.toString('utf-8')) as { Records?: Record<string, unknown>[] };

  return parsed.Records ?? [];
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

type ParseResult =
  | { type: 'events'; records: Record<string, unknown>[] }
  | { type: 's3-notification'; bucket: string; keys: string[] };

function parseCloudTrailMessage(body: string): ParseResult {
  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { type: 'events', records: [] };
  }

  // SNS wrapper — unwrap the envelope to get the inner message
  if (outer.Type === 'Notification' && typeof outer.Message === 'string') {
    try {
      outer = JSON.parse(outer.Message) as Record<string, unknown>;
    } catch {
      return { type: 'events', records: [] };
    }
  }

  // CloudTrail S3 notification (from CloudTrail → S3 → SNS → SQS).
  // The message contains an S3 bucket and list of object keys pointing to
  // .json.gz log files that need to be downloaded and decompressed.
  if (isCloudTrailS3Notification(outer)) {
    return {
      type: 's3-notification',
      bucket: outer.s3Bucket as string,
      keys: outer.s3ObjectKey as string[],
    };
  }

  // CloudTrail API event delivered directly via EventBridge
  if (outer.eventName && outer.eventSource) {
    return { type: 'events', records: [outer] };
  }

  // EventBridge envelope — two sub-cases:
  // 1. "AWS API Call via CloudTrail": the real CloudTrail record is in `detail`
  // 2. Native EventBridge event (e.g. Spot Instance Interruption Warning):
  //    keep the full envelope so normalizeEventBridgeEvent() handles it.
  if (outer['detail-type'] && outer.source && outer.detail) {
    const detail = outer.detail as Record<string, unknown>;
    if (outer['detail-type'] === 'AWS API Call via CloudTrail' && detail.eventName && detail.eventSource) {
      return { type: 'events', records: [detail] };
    }
    if (outer['detail-type'] === 'AWS Console Sign In via CloudTrail' && detail.eventName && detail.eventSource) {
      return { type: 'events', records: [detail] };
    }
    return { type: 'events', records: [outer] };
  }

  // Direct CloudTrail Records array (rare — some custom pipelines)
  if (Array.isArray(outer.Records)) {
    const direct = (outer.Records as Record<string, unknown>[]).filter(
      (r) => (r.eventName && r.eventSource) || (r['detail-type'] && r.source),
    );
    if (direct.length > 0) return { type: 'events', records: direct };
  }

  return { type: 'events', records: [] };
}

