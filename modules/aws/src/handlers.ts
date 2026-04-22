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
import { captureException } from '@sentinel/shared/sentry';
import { decrypt } from '@sentinel/shared/crypto';
import { logger as rootLogger } from '@sentinel/shared/logger';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
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

      const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);

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

          for (const record of records) {
            await storeRawEvent(db, integrationId, orgId, record);
            const rawId = await getRawEventId(db, integrationId, record.eventID as string);
            if (rawId) {
              // BullMQ JSON-serializes job data; bigint is not JSON-serializable.
              await queue.add('aws.event.process', { rawEventId: rawId.toString(), orgId }, {
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

    // Every raw CloudTrail event is forwarded to the platform `events` table so
    // that detection rules, correlation rules, and retroactive backfills all see
    // the full substrate. Lifecycle (how long this row survives) is owned by
    // the retention layer: AWS events default to a 1-day TTL but are preserved
    // when referenced by an alert or still inside an active correlation rule's
    // lookback window. See modules/aws/src/index.ts retentionPolicies.
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
