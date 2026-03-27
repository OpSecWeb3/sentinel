import {
  pgTable, text, uuid, timestamp, boolean, jsonb,
  bigint, uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './core';

const createdAt = timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// GitHub App installations linked to platform orgs
// ---------------------------------------------------------------------------

export const githubInstallations = pgTable('github_installations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  installationId: bigint('installation_id', { mode: 'bigint' }).unique().notNull(),
  appSlug: text('app_slug').notNull(),
  targetType: text('target_type').notNull(),
  targetLogin: text('target_login').notNull(),
  targetId: bigint('target_id', { mode: 'bigint' }).notNull(),
  webhookSecretEncrypted: text('webhook_secret_encrypted').notNull(),
  permissions: jsonb('permissions').notNull().default({}),
  events: text('events').array().notNull().default(sql`'{}'::text[]`),
  status: text('status').notNull().default('active'),
  createdAt,
  updatedAt,
}, (t) => [
  index('idx_gh_install_org').on(t.orgId),
]);

// ---------------------------------------------------------------------------
// Tracked repositories
// ---------------------------------------------------------------------------

export const githubRepositories = pgTable('github_repositories', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  installationId: uuid('installation_id').notNull().references(() => githubInstallations.id, { onDelete: 'cascade' }),
  repoId: bigint('repo_id', { mode: 'bigint' }).notNull(),
  fullName: text('full_name').notNull(),
  visibility: text('visibility').notNull(),
  defaultBranch: text('default_branch'),
  archived: boolean('archived').notNull().default(false),
  fork: boolean('fork').notNull().default(false),
  status: text('status').notNull().default('active'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_gh_repo').on(t.installationId, t.repoId),
  index('idx_gh_repo_org').on(t.orgId),
]);
