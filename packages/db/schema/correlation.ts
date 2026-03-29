import {
  pgTable, text, uuid, timestamp, boolean, jsonb,
  integer, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './core';

// ---------------------------------------------------------------------------
// Shared column helpers (same as core.ts)
// ---------------------------------------------------------------------------

const createdAt = timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Correlation rules
// ---------------------------------------------------------------------------

export const correlationRules = pgTable('correlation_rules', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description'),
  severity: text('severity').notNull().default('high'),
  status: text('status').notNull().default('active'),  // active | paused

  // Full correlation rule definition as JSONB
  // Contains: type, correlationKey, windowMinutes, steps/aggregation/absence
  config: jsonb('config').notNull(),

  // Notification routing (same pattern as detections)
  channelIds: uuid('channel_ids').array().default(sql`'{}'::uuid[]`).notNull(),
  slackChannelId: text('slack_channel_id'),
  slackChannelName: text('slack_channel_name'),
  cooldownMinutes: integer('cooldown_minutes').notNull().default(0),
  lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),

  createdAt,
  updatedAt,
}, (t) => [
  index('idx_correlation_rules_org').on(t.orgId),
  index('idx_correlation_rules_status').on(t.status).where(sql`status = 'active'`),
]);
