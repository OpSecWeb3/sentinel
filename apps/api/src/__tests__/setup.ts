/**
 * Vitest global setup for Sentinel API integration tests.
 *
 * Sets required environment variables, resets the database between test files,
 * and exposes helpers for registering users and making authenticated requests.
 */
import { beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { drizzle } from '@sentinel/db';
import { migrate } from '@sentinel/db';
import * as coreSchema from '@sentinel/db/schema/core';

// ---------------------------------------------------------------------------
// Environment — must be set before any app code is imported
// ---------------------------------------------------------------------------

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://sentinel:sentinel@localhost:5432/sentinel_test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-session-secret-that-is-at-least-32-chars-long!!';
process.env.ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.ALLOWED_ORIGINS ??= 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Shared SQL connection for direct DB operations in tests
// ---------------------------------------------------------------------------

let _sql: ReturnType<typeof postgres>;

export function getTestSql() {
  if (!_sql) {
    _sql = postgres(process.env.DATABASE_URL!);
  }
  return _sql;
}

export function getTestDb() {
  return drizzle(getTestSql(), { schema: coreSchema });
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const sql = getTestSql();

  // Recreate schema and run migrations
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await sql.unsafe('CREATE SCHEMA public');

  // Push schema via drizzle-kit is not available at runtime.
  // Instead, create the tables directly from the schema definitions.
  // We use raw SQL that mirrors the Drizzle schema.
  await sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS "pgcrypto";

    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      invite_secret_hash TEXT,
      invite_secret_encrypted TEXT,
      webhook_secret_encrypted TEXT,
      notify_key_hash TEXT,
      notify_key_prefix TEXT,
      notify_key_last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE org_memberships (
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (org_id, user_id)
    );

    CREATE TABLE sessions (
      sid TEXT PRIMARY KEY,
      sess JSONB NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX idx_sessions_expire ON sessions(expire);

    CREATE TABLE api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      scopes JSONB NOT NULL DEFAULT '["read"]'::jsonb,
      last_used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      revoked BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX uq_api_keys_hash ON api_keys(key_hash);
    CREATE INDEX idx_api_keys_org ON api_keys(org_id);

    CREATE TABLE detections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_by UUID NOT NULL REFERENCES users(id),
      module_id TEXT NOT NULL,
      template_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      severity TEXT NOT NULL DEFAULT 'high',
      status TEXT NOT NULL DEFAULT 'active',
      channel_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
      slack_channel_id TEXT,
      slack_channel_name TEXT,
      cooldown_minutes INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TIMESTAMPTZ,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_detections_org ON detections(org_id);
    CREATE INDEX idx_detections_module ON detections(module_id);
    CREATE INDEX idx_detections_status ON detections(status) WHERE status = 'active';

    CREATE TABLE rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      detection_id UUID NOT NULL REFERENCES detections(id) ON DELETE CASCADE,
      org_id UUID NOT NULL REFERENCES organizations(id),
      module_id TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      config JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      priority INTEGER NOT NULL DEFAULT 50,
      action TEXT NOT NULL DEFAULT 'alert',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_rules_detection ON rules(detection_id);
    CREATE INDEX idx_rules_org_module ON rules(org_id, module_id) WHERE status = 'active';

    CREATE TABLE events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id),
      module_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      external_id TEXT,
      payload JSONB NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_events_org_module ON events(org_id, module_id);
    CREATE INDEX idx_events_type ON events(event_type);
    CREATE INDEX idx_events_external ON events(external_id);

    CREATE TABLE alerts (
      id BIGSERIAL PRIMARY KEY,
      org_id UUID NOT NULL REFERENCES organizations(id),
      detection_id UUID REFERENCES detections(id) ON DELETE SET NULL,
      rule_id UUID REFERENCES rules(id) ON DELETE SET NULL,
      event_id UUID REFERENCES events(id) ON DELETE SET NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      trigger_type TEXT NOT NULL,
      trigger_data JSONB NOT NULL,
      notification_status TEXT NOT NULL DEFAULT 'pending',
      notifications JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_alerts_org ON alerts(org_id);
    CREATE INDEX idx_alerts_detection ON alerts(detection_id);

    CREATE TABLE notification_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      is_verified BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE slack_installations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      bot_token TEXT NOT NULL,
      bot_user_id TEXT NOT NULL,
      installed_by UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX uq_slack_org ON slack_installations(org_id);

    CREATE TABLE audit_log (
      id BIGSERIAL PRIMARY KEY,
      org_id UUID NOT NULL REFERENCES organizations(id),
      user_id UUID,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
});

afterAll(async () => {
  if (_sql) {
    await _sql.end();
  }
});

// ---------------------------------------------------------------------------
// Table truncation helper
// ---------------------------------------------------------------------------

export async function cleanTables() {
  const sql = getTestSql();
  await sql.unsafe(`
    TRUNCATE
      audit_log, alerts, events, rules, detections,
      notification_channels, slack_installations,
      api_keys, sessions, org_memberships, organizations, users
    CASCADE
  `);
}
