import {
  pgTable, text, uuid, timestamp, boolean, jsonb,
  bigserial, bigint, integer, index, uniqueIndex, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

const createdAt = timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  username: text('username').unique().notNull(),
  email: text('email').unique().notNull(),
  passwordHash: text('password_hash').notNull(),
  failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt,
  updatedAt,
});

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  inviteSecretHash: text('invite_secret_hash'),
  inviteSecretEncrypted: text('invite_secret_encrypted'),
  webhookSecretEncrypted: text('webhook_secret_encrypted'),
  notifyKeyHash: text('notify_key_hash'),
  notifyKeyPrefix: text('notify_key_prefix'),
  notifyKeyLastUsedAt: timestamp('notify_key_last_used_at', { withTimezone: true }),
  createdAt,
  updatedAt,
});

export const orgMemberships = pgTable('org_memberships', {
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('viewer'),
  createdAt,
}, (t) => [primaryKey({ columns: [t.orgId, t.userId] })]);

export const sessions = pgTable('sessions', {
  sid: text('sid').primaryKey(),
  sess: jsonb('sess').notNull(),
  expire: timestamp('expire', { withTimezone: true }).notNull(),
  // Plaintext lookup columns — these are UUIDs (not secrets) and enable indexed
  // deletion without decrypting every row.  Populated at session creation time.
  // Nullable for backward compatibility with rows written before this migration.
  userId: uuid('user_id'),
  orgId: uuid('org_id'),
}, (t) => [
  index('idx_sessions_expire').on(t.expire),
  index('idx_sessions_user_id').on(t.userId),
  index('idx_sessions_org_id').on(t.orgId),
]);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  scopes: jsonb('scopes').notNull().default(['read']),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revoked: boolean('revoked').notNull().default(false),
  createdAt,
}, (t) => [
  uniqueIndex('uq_api_keys_hash').on(t.keyHash),
  index('idx_api_keys_org').on(t.orgId),
]);

// ---------------------------------------------------------------------------
// Detection engine
// ---------------------------------------------------------------------------

export const detections = pgTable('detections', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id),
  moduleId: text('module_id').notNull(),
  templateId: text('template_id'),
  name: text('name').notNull(),
  description: text('description'),
  severity: text('severity').notNull().default('high'),
  status: text('status').notNull().default('active'),
  channelIds: uuid('channel_ids').array().default(sql`'{}'::uuid[]`).notNull(),
  slackChannelId: text('slack_channel_id'),
  slackChannelName: text('slack_channel_name'),
  cooldownMinutes: integer('cooldown_minutes').notNull().default(0),
  lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
  config: jsonb('config').notNull().default({}),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_detections_org').on(t.orgId),
  index('idx_detections_module').on(t.moduleId),
  index('idx_detections_status').on(t.status).where(sql`status = 'active'`),
  index('idx_detections_created_by').on(t.createdBy),
]);

export const rules = pgTable('rules', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  detectionId: uuid('detection_id').notNull().references(() => detections.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  moduleId: text('module_id').notNull(),
  ruleType: text('rule_type').notNull(),
  config: jsonb('config').notNull(),
  status: text('status').notNull().default('active'),
  priority: integer('priority').notNull().default(50),
  action: text('action').notNull().default('alert'),
  lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_rules_detection').on(t.detectionId),
  index('idx_rules_org_module').on(t.orgId, t.moduleId).where(sql`status = 'active'`),
  index('idx_rules_module_type_active').on(t.moduleId, t.ruleType).where(sql`status = 'active'`),
]);

// ---------------------------------------------------------------------------
// Events & alerts
// ---------------------------------------------------------------------------

export const events = pgTable('events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  moduleId: text('module_id').notNull(),
  eventType: text('event_type').notNull(),
  externalId: text('external_id'),
  payload: jsonb('payload').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_events_org_module').on(t.orgId, t.moduleId),
  index('idx_events_type').on(t.eventType),
  index('idx_events_external').on(t.externalId),
]);

export const alerts = pgTable('alerts', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  detectionId: uuid('detection_id').references(() => detections.id, { onDelete: 'set null' }),
  ruleId: uuid('rule_id').references(() => rules.id, { onDelete: 'set null' }),
  eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
  severity: text('severity').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  triggerType: text('trigger_type').notNull(),
  triggerData: jsonb('trigger_data').notNull(),
  notificationStatus: text('notification_status').notNull().default('pending'),
  notifications: jsonb('notifications').notNull().default([]),
  createdAt,
}, (t) => [
  index('idx_alerts_org').on(t.orgId),
  index('idx_alerts_detection').on(t.detectionId),
  // P2: Prevent duplicate alerts for the same event+detection+rule combination.
  uniqueIndex('uq_alerts_event_detection_rule')
    .on(t.eventId, t.detectionId, t.ruleId)
    .where(sql`event_id IS NOT NULL AND detection_id IS NOT NULL`),
  // P2: Prevent duplicate correlated alerts for the same event+correlation rule.
  // Note: the expression index on trigger_data->>'correlationRuleId' must be
  // added via raw SQL in the migration since Drizzle doesn't support expression
  // indexes natively. This schema-level index covers the eventId column; the
  // migration will replace it with the full expression index.
  uniqueIndex('uq_alerts_event_correlation')
    .on(t.eventId)
    .where(sql`trigger_type = 'correlated' AND event_id IS NOT NULL`),
]);

// ---------------------------------------------------------------------------
// Notification channels
// ---------------------------------------------------------------------------

export const notificationChannels = pgTable('notification_channels', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),
  config: jsonb('config').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  isVerified: boolean('is_verified').notNull().default(false),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_notification_channels_org').on(t.orgId),
]);

export const slackInstallations = pgTable('slack_installations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  teamId: text('team_id').notNull(),
  teamName: text('team_name').notNull(),
  botToken: text('bot_token').notNull(),
  botUserId: text('bot_user_id').notNull(),
  installedBy: uuid('installed_by').notNull().references(() => users.id),
  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_slack_org').on(t.orgId),
  index('idx_slack_installations_installed_by').on(t.installedBy),
]);

export const notificationDeliveries = pgTable('notification_deliveries', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  alertId: bigint('alert_id', { mode: 'bigint' }).notNull().references(() => alerts.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull(),
  channelType: text('channel_type').notNull(),
  status: text('status').notNull().default('pending'),
  statusCode: integer('status_code'),
  responseTimeMs: integer('response_time_ms'),
  error: text('error'),
  attemptCount: integer('attempt_count').notNull().default(1),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt,
}, (t) => [
  index('idx_notif_deliveries_alert').on(t.alertId),
  index('idx_notif_deliveries_status').on(t.status),
  index('idx_notif_deliveries_created').on(t.createdAt),
]);

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  userId: uuid('user_id'),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),
  details: jsonb('details'),
  createdAt,
}, (t) => [
  index('idx_audit_log_org').on(t.orgId),
  index('idx_audit_log_user').on(t.userId),
]);
