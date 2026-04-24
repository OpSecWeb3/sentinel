import {
  pgTable, text, uuid, timestamp, boolean, integer,
  index, uniqueIndex,
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

