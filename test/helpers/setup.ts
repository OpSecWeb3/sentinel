/**
 * Shared test setup — imported as a vitest setupFile.
 *
 * Responsibilities:
 *   1. Create/reset the sentinel_test Postgres database and run migrations.
 *   2. Provide a Redis mock (ioredis-mock) or connect to a test Redis instance.
 *   3. Export helpers for creating test users, orgs, API keys, and sessions.
 *   4. Clean data between tests.
 *
 * Convention: integration test files call `cleanTables()` in their own
 * `beforeEach` when they need a pristine slate. The global hooks here only
 * handle initial setup and final teardown.
 */

import { beforeAll, afterAll, afterEach } from 'vitest';
import postgres from 'postgres';
import { drizzle } from '@sentinel/db';
import { sql as drizzleSql } from '@sentinel/db';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { encrypt } from '@sentinel/shared/crypto';

// Re-export schema so tests can import from one place.
import * as coreSchema from '../../packages/db/schema/core.js';
import * as githubSchema from '../../packages/db/schema/github.js';
import * as registrySchema from '../../packages/db/schema/registry.js';
import * as infraSchema from '../../packages/db/schema/infra.js';

export const schema = { ...coreSchema, ...githubSchema, ...registrySchema, ...infraSchema };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TestDb = ReturnType<typeof drizzle>;

export interface TestUser {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
}

export interface TestOrg {
  id: string;
  name: string;
  slug: string;
  inviteSecret: string | null;
}

export interface TestMembership {
  orgId: string;
  userId: string;
  role: string;
}

export interface TestApiKey {
  id: string;
  raw: string;
  prefix: string;
  hash: string;
  orgId: string;
  userId: string;
  scopes: string[];
}

export interface TestDetection {
  id: string;
  orgId: string;
  createdBy: string;
  moduleId: string;
  name: string;
  severity: string;
  status: string;
}

export interface TestRule {
  id: string;
  detectionId: string;
  orgId: string;
  moduleId: string;
  ruleType: string;
  config: Record<string, unknown>;
  action: string;
}

// ---------------------------------------------------------------------------
// Connections — lazily initialised, cleaned up in afterAll
// ---------------------------------------------------------------------------

let _sql: ReturnType<typeof postgres> | undefined;
let _db: TestDb | undefined;
let _redis: Redis | undefined;
let _setupLockSql: ReturnType<typeof postgres> | undefined;

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://sentinel:sentinel@localhost:5434/sentinel_test';
const TEST_REDIS_URL =
  process.env.REDIS_URL ?? 'redis://localhost:6380/1';
const SETUP_LOCK_KEY_1 = 548731;
const SETUP_LOCK_KEY_2 = 99213;

/**
 * Return the shared test Drizzle instance.
 */
export function getTestDb(): TestDb {
  if (!_db) {
    throw new Error('Test DB not initialised. Is setup.ts loaded as a vitest setupFile?');
  }
  return _db;
}

/**
 * Return the raw postgres.js sql tagged-template client (for raw queries).
 */
export function getTestSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    throw new Error('Test SQL client not initialised.');
  }
  return _sql;
}

/**
 * Return the shared test Redis instance.
 */
export function getTestRedis(): Redis {
  if (!_redis) {
    throw new Error('Test Redis not initialised. Is setup.ts loaded as a vitest setupFile?');
  }
  return _redis;
}

// ---------------------------------------------------------------------------
// Global lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Serialize destructive schema reset across concurrent test runners/processes.
  // This prevents races where one process drops/recreates public schema while
  // another process is bootstrapping or executing tests.
  _setupLockSql = postgres(TEST_DATABASE_URL, { max: 1 });
  await _setupLockSql`SELECT pg_advisory_lock(${SETUP_LOCK_KEY_1}, ${SETUP_LOCK_KEY_2})`;

  // Drop and recreate the public schema so every test run starts clean.
  await _setupLockSql`DROP SCHEMA IF EXISTS public CASCADE`;
  await _setupLockSql`CREATE SCHEMA IF NOT EXISTS public`;

  // Run Drizzle migrations. We push the schema directly rather than running
  // migration files, which keeps tests in sync with the current schema
  // definition without requiring a separate generate step.
  await pushSchema(_setupLockSql);

  // --- Postgres runtime client used by test helpers ---
  _sql = postgres(TEST_DATABASE_URL, { max: 5 });
  _db = drizzle(_sql, { schema });

  // --- Redis ---
  _redis = new Redis(TEST_REDIS_URL, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
  await _redis.connect();
  // Use a dedicated DB (default DB 1) and flush it so tests start clean.
  await _redis.flushdb();
});

afterEach(async () => {
  // Flush Redis between tests to prevent leakage.
  if (_redis) {
    await _redis.flushdb();
  }
});

afterAll(async () => {
  if (_redis) {
    await _redis.flushdb();
    _redis.disconnect();
    _redis = undefined;
  }
  if (_sql) {
    await _sql.end();
    _sql = undefined;
    _db = undefined;
  }
  if (_setupLockSql) {
    await _setupLockSql`SELECT pg_advisory_unlock(${SETUP_LOCK_KEY_1}, ${SETUP_LOCK_KEY_2})`;
    await _setupLockSql.end();
    _setupLockSql = undefined;
  }
});

// ---------------------------------------------------------------------------
// Schema push — creates all tables from Drizzle schema definitions
// ---------------------------------------------------------------------------

/**
 * Push the Drizzle schema to the database by running the migration files.
 *
 * This keeps the test schema in sync with the actual Drizzle schema definitions
 * without manually duplicating every CREATE TABLE statement.
 */
async function pushSchema(sql: ReturnType<typeof postgres>): Promise<void> {
  // Enable uuid-ossp for gen_random_uuid()
  await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;

  // Run migration files in order
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/db/migrations');
  const journal = JSON.parse(readFileSync(resolve(migrationsDir, 'meta/_journal.json'), 'utf-8'));
  const migrationFiles = (journal.entries as { tag: string }[]).map((e) => `${e.tag}.sql`);

  for (const file of migrationFiles) {
    const migrationSql = readFileSync(resolve(migrationsDir, file), 'utf-8');
    // Drizzle Kit uses `--> statement-breakpoint` to delimit statements.
    // Split on these and execute each statement individually.
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await sql.unsafe(stmt);
    }
  }
}

/*
 * Dead code: manual schema push — replaced by migration files in pushSchema() above.
 * Keeping as block comment for reference.

async function _legacyPushSchema(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`;
  await sql`CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      invite_secret TEXT,
      invite_secret_hash TEXT,
      invite_secret_encrypted TEXT,
      webhook_secret_encrypted TEXT,
      notify_key_hash TEXT,
      notify_key_prefix TEXT,
      notify_key_last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS org_memberships (
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, user_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess JSONB NOT NULL,
      expire TIMESTAMPTZ NOT NULL,
      user_id UUID,
      org_id UUID
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_org_id ON sessions(org_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS api_keys (
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys_hash ON api_keys(key_hash)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(org_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS detections (
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_detections_org ON detections(org_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_detections_module ON detections(module_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      detection_id UUID NOT NULL REFERENCES detections(id) ON DELETE CASCADE,
      org_id UUID NOT NULL REFERENCES organizations(id),
      module_id TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      config JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      priority INTEGER NOT NULL DEFAULT 50,
      action TEXT NOT NULL DEFAULT 'alert',
      last_triggered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_rules_detection ON rules(detection_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id),
      module_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      external_id TEXT,
      payload JSONB NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_org_module ON events(org_id, module_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)`;

  await sql`
    CREATE TABLE IF NOT EXISTS alerts (
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_alerts_org ON alerts(org_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_alerts_detection ON alerts(detection_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id BIGSERIAL PRIMARY KEY,
      alert_id BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      status_code INTEGER,
      response_time_ms INTEGER,
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_notif_deliveries_alert ON notification_deliveries(alert_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_notif_deliveries_status ON notification_deliveries(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_notif_deliveries_created ON notification_deliveries(created_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS notification_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      is_verified BOOLEAN NOT NULL DEFAULT false,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS slack_installations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      bot_token TEXT NOT NULL,
      bot_user_id TEXT NOT NULL,
      installed_by UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_slack_org ON slack_installations(org_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      org_id UUID NOT NULL REFERENCES organizations(id),
      user_id UUID,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // --- github.ts tables ---
  await sql`
    CREATE TABLE IF NOT EXISTS github_installations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      installation_id BIGINT UNIQUE NOT NULL,
      app_slug TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_login TEXT NOT NULL,
      target_id BIGINT NOT NULL,
      webhook_secret_encrypted TEXT NOT NULL,
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      events TEXT[] NOT NULL DEFAULT '{}'::text[],
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS github_repositories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      installation_id UUID NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
      repo_id BIGINT NOT NULL,
      full_name TEXT NOT NULL,
      visibility TEXT NOT NULL,
      default_branch TEXT,
      archived BOOLEAN NOT NULL DEFAULT false,
      fork BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'active',
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_gh_repo ON github_repositories(installation_id, repo_id)`;

  // --- registry.ts tables ---
  await sql`
    CREATE TABLE IF NOT EXISTS rc_artifacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      artifact_type TEXT NOT NULL,
      name TEXT NOT NULL,
      registry TEXT NOT NULL DEFAULT 'docker_hub',
      tag_watch_patterns JSONB NOT NULL DEFAULT '["*"]'::jsonb,
      tag_ignore_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
      watch_mode TEXT NOT NULL DEFAULT 'dist-tags',
      enabled BOOLEAN NOT NULL DEFAULT true,
      poll_interval_seconds INTEGER NOT NULL DEFAULT 300,
      last_polled_at TIMESTAMPTZ,
      github_repo TEXT,
      github_allowed_workflows JSONB DEFAULT '[]'::jsonb,
      webhook_url TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_rc_artifact_org_name_registry ON rc_artifacts(org_id, name, registry)`;

  await sql`
    CREATE TABLE IF NOT EXISTS rc_artifact_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_id UUID NOT NULL REFERENCES rc_artifacts(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      current_digest TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      digest_changed_at TIMESTAMPTZ,
      metadata JSONB DEFAULT '{}'::jsonb,
      verification JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_rc_version_artifact_version ON rc_artifact_versions(artifact_id, version)`;

  await sql`
    CREATE TABLE IF NOT EXISTS rc_artifact_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      artifact_id UUID NOT NULL REFERENCES rc_artifacts(id) ON DELETE CASCADE,
      version_id UUID REFERENCES rc_artifact_versions(id) ON DELETE SET NULL,
      artifact_event_type TEXT NOT NULL,
      version TEXT NOT NULL,
      old_digest TEXT,
      new_digest TEXT,
      pusher TEXT,
      source TEXT NOT NULL DEFAULT 'poll',
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS rc_verifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_id UUID NOT NULL REFERENCES rc_artifacts(id) ON DELETE CASCADE,
      version_id UUID NOT NULL REFERENCES rc_artifact_versions(id) ON DELETE CASCADE,
      digest TEXT,
      has_signature BOOLEAN NOT NULL DEFAULT false,
      signature_key_id TEXT,
      signature_issuer TEXT,
      has_provenance BOOLEAN NOT NULL DEFAULT false,
      provenance_source_repo TEXT,
      provenance_builder TEXT,
      provenance_commit TEXT,
      provenance_build_type TEXT,
      has_rekor_entry BOOLEAN NOT NULL DEFAULT false,
      rekor_entry_count INTEGER,
      rekor_log_index INTEGER,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS rc_attributions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      artifact_event_id UUID NOT NULL REFERENCES rc_artifact_events(id) ON DELETE CASCADE,
      artifact_id UUID NOT NULL REFERENCES rc_artifacts(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      ci_run_id BIGINT,
      commit TEXT,
      actor TEXT,
      workflow TEXT,
      repo TEXT,
      details JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_rc_attribution_event ON rc_attributions(artifact_event_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS rc_ci_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      artifact_name TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      version TEXT NOT NULL,
      digest TEXT NOT NULL,
      github_run_id BIGINT NOT NULL,
      github_commit TEXT NOT NULL,
      github_actor TEXT NOT NULL,
      github_workflow TEXT NOT NULL,
      github_repo TEXT NOT NULL,
      verified BOOLEAN DEFAULT false,
      verification_details JSONB,
      matched_artifact_event_id UUID REFERENCES rc_artifact_events(id) ON DELETE SET NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // --- infra.ts tables (subset -- hosts only, enough for test helpers) ---
  await sql`
    CREATE TABLE IF NOT EXISTS infra_hosts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      parent_id UUID REFERENCES infra_hosts(id) ON DELETE CASCADE,
      hostname TEXT NOT NULL,
      is_root BOOLEAN NOT NULL DEFAULT true,
      is_active BOOLEAN NOT NULL DEFAULT true,
      source TEXT NOT NULL DEFAULT 'manual',
      current_score INTEGER,
      last_scanned_at TIMESTAMPTZ,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_infra_hosts_org_hostname ON infra_hosts(org_id, hostname)`;

  // --- correlation.ts tables ---
  await sql`
    CREATE TABLE IF NOT EXISTS correlation_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_by UUID REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT,
      severity TEXT NOT NULL DEFAULT 'high',
      status TEXT NOT NULL DEFAULT 'active',
      config JSONB NOT NULL,
      channel_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
      slack_channel_id TEXT,
      slack_channel_name TEXT,
      cooldown_minutes INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_correlation_rules_org ON correlation_rules(org_id)`;

  // --- aws.ts tables ---
  await sql`
    CREATE TABLE IF NOT EXISTS aws_integrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      account_id TEXT NOT NULL,
      is_org_integration BOOLEAN NOT NULL DEFAULT false,
      aws_org_id TEXT,
      role_arn TEXT,
      credentials_encrypted TEXT,
      external_id TEXT,
      sqs_queue_url TEXT,
      sqs_region TEXT NOT NULL DEFAULT 'us-east-1',
      regions TEXT[] NOT NULL DEFAULT '{}'::text[],
      enabled BOOLEAN NOT NULL DEFAULT true,
      status TEXT NOT NULL DEFAULT 'active',
      error_message TEXT,
      last_polled_at TIMESTAMPTZ,
      next_poll_at TIMESTAMPTZ,
      poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_aws_integration_org ON aws_integrations(org_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_aws_integration_account ON aws_integrations(org_id, account_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS aws_cloudtrail_events (
      id BIGSERIAL PRIMARY KEY,
      integration_id UUID NOT NULL REFERENCES aws_integrations(id) ON DELETE CASCADE,
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      event_id TEXT,
      event_name TEXT NOT NULL,
      event_source TEXT NOT NULL,
      event_time TIMESTAMPTZ NOT NULL,
      aws_region TEXT NOT NULL,
      source_ip TEXT,
      user_identity JSONB,
      request_parameters JSONB,
      response_elements JSONB,
      error_code TEXT,
      error_message TEXT,
      raw JSONB NOT NULL,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_aws_ct_org ON aws_cloudtrail_events(org_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_aws_ct_integration ON aws_cloudtrail_events(integration_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_aws_ct_event_time ON aws_cloudtrail_events(event_time)`;
}
end of dead code block */

// ---------------------------------------------------------------------------
// Table cleaning
// ---------------------------------------------------------------------------

/**
 * All data tables in dependency-safe truncation order.
 */
const ALL_DATA_TABLES = [
  // AWS module
  'aws_raw_events',
  'aws_integrations',
  // Chain module
  'chain_state_snapshots',
  'chain_rpc_usage_hourly',
  'chain_container_metrics',
  'chain_block_cursors',
  'chain_org_rpc_configs',
  'chain_org_contracts',
  'chain_detection_templates',
  'chain_contracts',
  'chain_networks',
  // Correlation
  'correlation_rules',
  // Registry module
  'rc_ci_notifications',
  'rc_attributions',
  'rc_verifications',
  'rc_artifact_events',
  'rc_artifact_versions',
  'rc_artifacts',
  // GitHub module
  'github_repositories',
  'github_installations',
  // Infra module
  'infra_whois_changes',
  'infra_whois_records',
  'infra_tls_analyses',
  'infra_snapshots',
  'infra_score_history',
  'infra_scan_step_results',
  'infra_scan_schedules',
  'infra_scan_events',
  'infra_reachability_checks',
  'infra_http_header_checks',
  'infra_finding_suppressions',
  'infra_dns_records',
  'infra_dns_health_checks',
  'infra_dns_changes',
  'infra_ct_log_entries',
  'infra_certificates',
  'infra_cdn_origin_records',
  'infra_cdn_provider_configs',
  'infra_hosts',
  // Core tables
  'notification_deliveries',
  'audit_log',
  'alerts',
  'rules',
  'detections',
  'events',
  'notification_channels',
  'slack_installations',
  'api_keys',
  'sessions',
  'org_memberships',
  'organizations',
  'users',
] as const;

/**
 * Truncate all data tables. Call in `beforeEach` for a clean slate.
 *
 * Uses TRUNCATE ... CASCADE for speed and correctness.
 */
export async function cleanTables(): Promise<void> {
  const sql = getTestSql();
  await sql.unsafe(`TRUNCATE ${ALL_DATA_TABLES.join(', ')} CASCADE`);
}

/**
 * Truncate a specific subset of tables.
 */
export async function cleanSpecificTables(...tables: string[]): Promise<void> {
  const sql = getTestSql();
  await sql.unsafe(`TRUNCATE ${tables.join(', ')} CASCADE`);
}

// ---------------------------------------------------------------------------
// Entity creation helpers
// ---------------------------------------------------------------------------

let _userCounter = 0;
let _orgCounter = 0;

/**
 * Reset counters between tests if you call cleanTables().
 */
export function resetCounters(): void {
  _userCounter = 0;
  _orgCounter = 0;
}

/**
 * Create a test user directly in the database.
 *
 * Returns the user row including the raw password for login helpers.
 */
export async function createTestUser(overrides: Partial<{
  username: string;
  email: string;
  password: string;
}> = {}): Promise<TestUser & { password: string }> {
  _userCounter++;
  const sql = getTestSql();

  const username = overrides.username ?? `testuser${_userCounter}`;
  const email = overrides.email ?? `${username}@test.sentinel.dev`;
  const password = overrides.password ?? 'TestPass123!';

  // Use a simple hash for tests -- bcrypt is slow and unnecessary here.
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

  const [row] = await sql`
    INSERT INTO users (username, email, password_hash)
    VALUES (${username}, ${email}, ${passwordHash})
    RETURNING id, username, email, password_hash
  `;

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.password_hash,
    password,
  };
}

/**
 * Create a test organization directly in the database.
 */
export async function createTestOrg(overrides: Partial<{
  name: string;
  slug: string;
  inviteSecret: string;
}> = {}): Promise<TestOrg> {
  _orgCounter++;
  const sql = getTestSql();

  const name = overrides.name ?? `Test Org ${_orgCounter}`;
  const slug = overrides.slug ?? `test-org-${_orgCounter}`;
  const inviteSecret = overrides.inviteSecret ?? crypto.randomBytes(24).toString('base64url');

  // Hash the invite secret for storage (matches how auth routes look it up)
  const inviteSecretHash = crypto.createHash('sha256').update(inviteSecret).digest('hex');

  const [row] = await sql`
    INSERT INTO organizations (name, slug, invite_secret_hash)
    VALUES (${name}, ${slug}, ${inviteSecretHash})
    RETURNING id, name, slug
  `;

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    inviteSecret,  // Return the raw secret for tests that need it
  };
}

/**
 * Add a user to an org with a given role.
 */
export async function addMembership(
  orgId: string,
  userId: string,
  role: 'admin' | 'editor' | 'viewer' = 'admin',
): Promise<TestMembership> {
  const sql = getTestSql();
  await sql`
    INSERT INTO org_memberships (org_id, user_id, role)
    VALUES (${orgId}, ${userId}, ${role})
  `;
  return { orgId, userId, role };
}

/**
 * Create a user + org + admin membership in one call.
 * This is the most common setup pattern for integration tests.
 */
export async function createTestUserWithOrg(overrides: Partial<{
  username: string;
  orgName: string;
  orgSlug: string;
}> = {}): Promise<{
  user: TestUser & { password: string };
  org: TestOrg;
  membership: TestMembership;
}> {
  const user = await createTestUser({
    username: overrides.username,
  });
  const org = await createTestOrg({
    name: overrides.orgName,
    slug: overrides.orgSlug,
  });
  const membership = await addMembership(org.id, user.id, 'admin');

  return { user, org, membership };
}

/**
 * Create an API key for a user/org pair.
 */
export async function createTestApiKey(
  orgId: string,
  userId: string,
  overrides: Partial<{
    name: string;
    scopes: string[];
  }> = {},
): Promise<TestApiKey> {
  const sql = getTestSql();
  const raw = `sk_test_${crypto.randomBytes(32).toString('base64url')}`;
  const prefix = raw.slice(0, 11);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const scopes = overrides.scopes ?? ['read'];
  const name = overrides.name ?? `test-key-${Date.now()}`;

  const [row] = await sql`
    INSERT INTO api_keys (org_id, user_id, name, key_hash, key_prefix, scopes)
    VALUES (${orgId}, ${userId}, ${name}, ${hash}, ${prefix}, ${JSON.stringify(scopes)}::jsonb)
    RETURNING id
  `;

  return { id: row.id, raw, prefix, hash, orgId, userId, scopes };
}

/**
 * Create a test detection (security rule group).
 */
export async function createTestDetection(
  orgId: string,
  userId: string,
  overrides: Partial<{
    moduleId: string;
    templateId: string;
    name: string;
    severity: string;
    status: string;
    config: Record<string, unknown>;
  }> = {},
): Promise<TestDetection> {
  const sql = getTestSql();
  const moduleId = overrides.moduleId ?? 'github';
  const name = overrides.name ?? `Test Detection ${Date.now()}`;
  const severity = overrides.severity ?? 'high';
  const status = overrides.status ?? 'active';
  const config = overrides.config ?? {};

  const [row] = await sql`
    INSERT INTO detections (org_id, created_by, module_id, template_id, name, severity, status, config)
    VALUES (${orgId}, ${userId}, ${moduleId}, ${overrides.templateId ?? null}, ${name}, ${severity}, ${status}, ${JSON.stringify(config)}::jsonb)
    RETURNING id, org_id, created_by, module_id, name, severity, status
  `;

  return {
    id: row.id,
    orgId: row.org_id,
    createdBy: row.created_by,
    moduleId: row.module_id,
    name: row.name,
    severity: row.severity,
    status: row.status,
  };
}

/**
 * Create a test rule within a detection.
 */
export async function createTestRule(
  detectionId: string,
  orgId: string,
  overrides: Partial<{
    moduleId: string;
    ruleType: string;
    config: Record<string, unknown>;
    status: string;
    priority: number;
    action: string;
  }> = {},
): Promise<TestRule> {
  const sql = getTestSql();
  const moduleId = overrides.moduleId ?? 'github';
  const ruleType = overrides.ruleType ?? 'github.repo_visibility';
  const config = overrides.config ?? { visibility: 'public' };
  const action = overrides.action ?? 'alert';
  const status = overrides.status ?? 'active';
  const priority = overrides.priority ?? 50;

  const [row] = await sql`
    INSERT INTO rules (detection_id, org_id, module_id, rule_type, config, status, priority, action)
    VALUES (${detectionId}, ${orgId}, ${moduleId}, ${ruleType}, ${JSON.stringify(config)}::jsonb, ${status}, ${priority}, ${action})
    RETURNING id, detection_id, org_id, module_id, rule_type, config, action
  `;

  return {
    id: row.id,
    detectionId: row.detection_id,
    orgId: row.org_id,
    moduleId: row.module_id,
    ruleType: row.rule_type,
    config: row.config as Record<string, unknown>,
    action: row.action,
  };
}

/**
 * Insert a raw event into the events table.
 */
export async function createTestEvent(
  orgId: string,
  overrides: Partial<{
    moduleId: string;
    eventType: string;
    externalId: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
  }> = {},
): Promise<{ id: string; orgId: string; moduleId: string; eventType: string }> {
  const sql = getTestSql();
  const moduleId = overrides.moduleId ?? 'github';
  const eventType = overrides.eventType ?? 'github.push';
  const payload = overrides.payload ?? {};
  const occurredAt = overrides.occurredAt ?? new Date();

  const [row] = await sql`
    INSERT INTO events (org_id, module_id, event_type, external_id, payload, occurred_at)
    VALUES (${orgId}, ${moduleId}, ${eventType}, ${overrides.externalId ?? null}, ${JSON.stringify(payload)}::jsonb, ${occurredAt.toISOString()})
    RETURNING id, org_id, module_id, event_type
  `;

  return {
    id: row.id,
    orgId: row.org_id,
    moduleId: row.module_id,
    eventType: row.event_type,
  };
}

/**
 * Create a notification channel for an org.
 */
export async function createTestNotificationChannel(
  orgId: string,
  overrides: Partial<{
    name: string;
    type: string;
    config: Record<string, unknown>;
    enabled: boolean;
  }> = {},
): Promise<{ id: string; orgId: string; type: string }> {
  const sql = getTestSql();
  const name = overrides.name ?? 'Test Slack Channel';
  const type = overrides.type ?? 'slack';
  const config = overrides.config ?? { channelId: 'C12345' };
  const enabled = overrides.enabled ?? true;

  const [row] = await sql`
    INSERT INTO notification_channels (org_id, name, type, config, enabled)
    VALUES (${orgId}, ${name}, ${type}, ${JSON.stringify(config)}::jsonb, ${enabled})
    RETURNING id, org_id, type
  `;

  return { id: row.id, orgId: row.org_id, type: row.type };
}

// ---------------------------------------------------------------------------
// Session / cookie helpers for Hono API tests
// ---------------------------------------------------------------------------

/**
 * Create a fake session in the sessions table and return the session ID.
 *
 * This is useful for API integration tests that need to bypass the login
 * flow and directly create an authenticated session.
 */
export async function createTestSession(
  userId: string,
  orgId: string,
  role = 'admin',
): Promise<{ sid: string; cookie: string }> {
  const sql = getTestSql();
  const sid = crypto.randomBytes(24).toString('base64url');
  const expire = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const sess = { _encrypted: encrypt(JSON.stringify({ userId, orgId, role })) };

  await sql`
    INSERT INTO sessions (sid, sess, expire, user_id, org_id)
    VALUES (${sid}, ${JSON.stringify(sess)}::jsonb, ${expire.toISOString()}, ${userId}::uuid, ${orgId}::uuid)
  `;

  // The cookie format depends on the session middleware. This is a generic
  // format that most test HTTP clients can use.
  const cookie = `sentinel.sid=${sid}`;
  return { sid, cookie };
}

// ---------------------------------------------------------------------------
// HMAC webhook signature helper
// ---------------------------------------------------------------------------

/**
 * Generate an HMAC-SHA256 signature for a webhook payload.
 *
 * Matches the format used by Sentinel's webhook verification middleware.
 */
export function signWebhookPayload(payload: string | object, secret: string): string {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ---------------------------------------------------------------------------
// Release chain helpers
// ---------------------------------------------------------------------------

/**
 * Create a monitored artifact (Docker image or npm package).
 */
export async function createTestArtifact(
  orgId: string,
  overrides: Partial<{
    artifactType: string;
    name: string;
    registry: string;
    githubRepo: string;
    enabled: boolean;
  }> = {},
): Promise<{ id: string; orgId: string; artifactType: string; name: string; registry: string }> {
  const sql = getTestSql();
  const artifactType = overrides.artifactType ?? 'docker_image';
  const name = overrides.name ?? 'sentinel/test-image';
  const registry = overrides.registry ?? 'docker_hub';
  const enabled = overrides.enabled ?? true;

  const [row] = await sql`
    INSERT INTO rc_artifacts (org_id, artifact_type, name, registry, github_repo, enabled)
    VALUES (${orgId}, ${artifactType}, ${name}, ${registry}, ${overrides.githubRepo ?? null}, ${enabled})
    RETURNING id, org_id, artifact_type, name, registry
  `;

  return {
    id: row.id,
    orgId: row.org_id,
    artifactType: row.artifact_type,
    name: row.name,
    registry: row.registry,
  };
}

/**
 * Create an artifact version (tag/semver).
 */
export async function createTestArtifactVersion(
  artifactId: string,
  overrides: Partial<{
    version: string;
    currentDigest: string;
    status: string;
  }> = {},
): Promise<{ id: string; artifactId: string; version: string; currentDigest: string | null }> {
  const sql = getTestSql();
  const version = overrides.version ?? 'latest';
  const currentDigest = overrides.currentDigest ?? 'sha256:abc123def456';
  const status = overrides.status ?? 'active';

  const [row] = await sql`
    INSERT INTO rc_artifact_versions (artifact_id, version, current_digest, status)
    VALUES (${artifactId}, ${version}, ${currentDigest}, ${status})
    RETURNING id, artifact_id, version, current_digest
  `;

  return {
    id: row.id,
    artifactId: row.artifact_id,
    version: row.version,
    currentDigest: row.current_digest,
  };
}

// ---------------------------------------------------------------------------
// GitHub module helpers
// ---------------------------------------------------------------------------

/**
 * Create a GitHub App installation record.
 */
export async function createTestGithubInstallation(
  orgId: string,
  overrides: Partial<{
    installationId: number;
    appSlug: string;
    targetType: string;
    targetLogin: string;
    targetId: number;
    webhookSecretEncrypted: string;
  }> = {},
): Promise<{ id: string; orgId: string; installationId: number }> {
  const sql = getTestSql();
  const installationId = overrides.installationId ?? Math.floor(Math.random() * 1_000_000);
  const appSlug = overrides.appSlug ?? 'sentinel-test';
  const targetType = overrides.targetType ?? 'Organization';
  const targetLogin = overrides.targetLogin ?? 'test-org';
  const targetId = overrides.targetId ?? Math.floor(Math.random() * 1_000_000);
  const webhookSecretEncrypted = overrides.webhookSecretEncrypted ?? 'encrypted_test_secret';

  const [row] = await sql`
    INSERT INTO github_installations (org_id, installation_id, app_slug, target_type, target_login, target_id, webhook_secret_encrypted)
    VALUES (${orgId}, ${installationId}, ${appSlug}, ${targetType}, ${targetLogin}, ${targetId}, ${webhookSecretEncrypted})
    RETURNING id, org_id, installation_id
  `;

  return {
    id: row.id,
    orgId: row.org_id,
    installationId: Number(row.installation_id),
  };
}

/**
 * Create a tracked GitHub repository.
 */
export async function createTestGithubRepo(
  orgId: string,
  installationId: string,
  overrides: Partial<{
    repoId: number;
    fullName: string;
    visibility: string;
    defaultBranch: string;
  }> = {},
): Promise<{ id: string; fullName: string }> {
  const sql = getTestSql();
  const repoId = overrides.repoId ?? Math.floor(Math.random() * 1_000_000);
  const fullName = overrides.fullName ?? 'test-org/test-repo';
  const visibility = overrides.visibility ?? 'private';
  const defaultBranch = overrides.defaultBranch ?? 'main';

  const [row] = await sql`
    INSERT INTO github_repositories (org_id, installation_id, repo_id, full_name, visibility, default_branch)
    VALUES (${orgId}, ${installationId}, ${repoId}, ${fullName}, ${visibility}, ${defaultBranch})
    RETURNING id, full_name
  `;

  return { id: row.id, fullName: row.full_name };
}
