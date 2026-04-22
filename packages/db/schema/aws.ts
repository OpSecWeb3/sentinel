import {
  pgTable, text, uuid, timestamp, boolean, jsonb, integer,
  bigserial, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './core';

const createdAt = timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// AWS integrations — one per AWS account (or one per AWS Organization)
// ---------------------------------------------------------------------------

export const awsIntegrations = pgTable('aws_integrations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // For org integrations this is the management account ID; for single-account
  // integrations it is the target account ID.
  accountId: text('account_id').notNull(),

  // AWS Organizations support: a single integration can cover all accounts in
  // an org by pointing at the management account's SQS queue (fed by an org
  // CloudTrail trail). Each ingested event still carries its own accountId.
  isOrgIntegration: boolean('is_org_integration').notNull().default(false),
  awsOrgId: text('aws_org_id'),  // e.g. o-aa111bb222

  // Auth: role ARN (cross-account assume-role) or encrypted static credentials
  roleArn: text('role_arn'),
  credentialsEncrypted: text('credentials_encrypted'),
  externalId: text('external_id'),
  externalIdGeneratedAt: timestamp('external_id_generated_at', { withTimezone: true }),
  externalIdEnforced: boolean('external_id_enforced').notNull().default(true),

  // CloudTrail ingestion: SQS queue URL where CloudTrail S3 notifications or
  // EventBridge rules deliver events
  sqsQueueUrl: text('sqs_queue_url'),
  sqsRegion: text('sqs_region').notNull().default('us-east-1'),

  // Optional: limit watched regions; empty array means all regions
  regions: text('regions').array().notNull().default(sql`'{}'::text[]`),

  enabled: boolean('enabled').notNull().default(true),
  status: text('status').notNull().default('active'),  // setup | active | error | disabled | needs_update
  errorMessage: text('error_message'),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
  pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(60),

  createdAt,
  updatedAt,
}, (t) => [
  index('idx_aws_integration_org').on(t.orgId),
  uniqueIndex('uq_aws_integration_account').on(t.orgId, t.accountId),
]);

// ---------------------------------------------------------------------------
// AWS raw CloudTrail events — 7-day hot buffer
//
// ALL ingested CloudTrail events land here first and are then normalized into
// the platform `events` table for rule / correlation evaluation. Lifecycle in
// the platform table is owned by the retention layer (see modules/aws/src/
// index.ts): 1-day floor, but rows referenced by an alert or still inside an
// active correlation window are preserved. The 7-day buffer here exists so
// new detections can backfill over recent raw history.
// ---------------------------------------------------------------------------

export const awsRawEvents = pgTable('aws_raw_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  integrationId: uuid('integration_id').notNull().references(() => awsIntegrations.id, { onDelete: 'cascade' }),

  // CloudTrail event identity
  cloudTrailEventId: text('cloudtrail_event_id').notNull(),
  eventName: text('event_name').notNull(),
  eventSource: text('event_source').notNull(),   // e.g. "iam.amazonaws.com"
  eventVersion: text('event_version'),
  awsRegion: text('aws_region').notNull(),

  // Who did it
  principalId: text('principal_id'),
  userArn: text('user_arn'),
  accountId: text('account_id'),
  userType: text('user_type'),  // Root | IAMUser | AssumedRole | FederatedUser | AWSService

  // What happened
  sourceIpAddress: text('source_ip_address'),
  userAgent: text('user_agent'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),

  // Resources affected (JSONB array: [{ARN, accountId, type}])
  resources: jsonb('resources'),

  // Full raw CloudTrail event record
  rawPayload: jsonb('raw_payload').notNull(),

  // Timestamps
  eventTime: timestamp('event_time', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),

  // Promotion flag: true once this event has been written to the platform events table
  promoted: boolean('promoted').notNull().default(false),
  platformEventId: uuid('platform_event_id'),
}, (t) => [
  index('idx_aws_raw_org').on(t.orgId),
  index('idx_aws_raw_integration').on(t.integrationId),
  index('idx_aws_raw_received_at').on(t.receivedAt),
  index('idx_aws_raw_event_name').on(t.eventName),
  uniqueIndex('uq_aws_raw_cloudtrail_id').on(t.integrationId, t.cloudTrailEventId),
]);
