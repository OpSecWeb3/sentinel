import {
  pgTable, text, uuid, timestamp, boolean, jsonb, integer,
  bigint, uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, events } from './core';

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

const createdAt = timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp('updated_at', { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Monitored artifacts (Docker images + npm packages)
// ---------------------------------------------------------------------------

export const rcArtifacts = pgTable('rc_artifacts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  artifactType: text('artifact_type').notNull(),           // 'docker_image' | 'npm_package'
  name: text('name').notNull(),                            // e.g. "myorg/myapp" or "@scope/pkg"
  registry: text('registry').notNull().default('docker_hub'), // docker_hub, ghcr, npmjs, etc.

  // Monitoring config
  tagWatchPatterns: jsonb('tag_watch_patterns').notNull().default(['*']),
  tagIgnorePatterns: jsonb('tag_ignore_patterns').notNull().default([]),
  watchMode: text('watch_mode').notNull().default('dist-tags'), // 'dist-tags' | 'versions'
  enabled: boolean('enabled').notNull().default(true),
  pollIntervalSeconds: integer('poll_interval_seconds').notNull().default(300),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),

  // Attribution config: link to source repo & allowed CI workflows
  githubRepo: text('github_repo'),                         // e.g. "myorg/myapp"
  githubAllowedWorkflows: jsonb('github_allowed_workflows').default([]),

  // Webhook config (per-artifact override)
  webhookUrl: text('webhook_url'),

  // Registry-specific metadata (npm: maintainers, dist-tags; docker: platform list)
  metadata: jsonb('metadata').default({}),

  // Encrypted registry credentials (Docker Hub or npm token) stored as
  // AES-256-GCM ciphertext via @sentinel/shared/crypto. Null when not set.
  credentialsEncrypted: text('credentials_encrypted'),

  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_rc_artifact_org_name_registry').on(t.orgId, t.name, t.registry),
  index('idx_rc_artifacts_org').on(t.orgId),
  index('idx_rc_artifacts_type').on(t.artifactType),
  index('idx_rc_artifacts_registry').on(t.registry),
]);

// ---------------------------------------------------------------------------
// Artifact versions / tags  (per-tag or per-version state)
// ---------------------------------------------------------------------------

export const rcArtifactVersions = pgTable('rc_artifact_versions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  artifactId: uuid('artifact_id').notNull().references(() => rcArtifacts.id, { onDelete: 'cascade' }),
  version: text('version').notNull(),                      // tag name or semver string
  currentDigest: text('current_digest'),                   // sha256 digest (Docker) or shasum (npm)
  status: text('status').notNull().default('active'),      // active | gone | ignored | untracked

  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  digestChangedAt: timestamp('digest_changed_at', { withTimezone: true }),

  // Registry-specific version metadata (npm: has_install_scripts, license, deprecated)
  metadata: jsonb('metadata').default({}),

  // Latest verification results (signature, provenance, rekor)
  verification: jsonb('verification').default({}),

  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_rc_version_artifact_version').on(t.artifactId, t.version),
  index('idx_rc_versions_artifact').on(t.artifactId),
  index('idx_rc_versions_status').on(t.status),
]);

// ---------------------------------------------------------------------------
// Artifact events (digest changes, new tags, tag removals, version publishes)
//
// These are registry-specific event details. Each row links back to
// the platform-wide events table via eventId so alerting/detection still
// flows through Sentinel's generic pipeline.
// ---------------------------------------------------------------------------

export const rcArtifactEvents = pgTable('rc_artifact_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  artifactId: uuid('artifact_id').notNull().references(() => rcArtifacts.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').references(() => rcArtifactVersions.id, { onDelete: 'set null' }),

  artifactEventType: text('artifact_event_type').notNull(),
  // Docker: digest_change, new_tag, tag_removed
  // npm:    new_version, version_unpublished, version_deprecated,
  //         maintainer_changed, dist_tag_updated
  // Shared: check_error

  version: text('version').notNull(),                      // tag or semver at time of event
  oldDigest: text('old_digest'),
  newDigest: text('new_digest'),
  pusher: text('pusher'),                                  // from webhook payload
  source: text('source').notNull().default('poll'),        // poll | webhook | ci_notification

  // Registry-specific event metadata
  metadata: jsonb('metadata').default({}),

  createdAt,
}, (t) => [
  index('idx_rc_events_artifact').on(t.artifactId),
  index('idx_rc_events_event').on(t.eventId),
  index('idx_rc_events_type').on(t.artifactEventType),
  index('idx_rc_events_created').on(t.createdAt),
]);

// ---------------------------------------------------------------------------
// Artifact verification state
//
// Stores the full verification result for a specific artifact version at a
// specific digest. Separate from rc_artifact_versions.verification because
// an artifact may be re-verified over time (e.g. digest change re-triggers
// checks) and we want a historical record.
// ---------------------------------------------------------------------------

export const rcVerifications = pgTable('rc_verifications', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  artifactId: uuid('artifact_id').notNull().references(() => rcArtifacts.id, { onDelete: 'cascade' }),
  versionId: uuid('version_id').notNull().references(() => rcArtifactVersions.id, { onDelete: 'cascade' }),
  digest: text('digest'),                                  // digest at verification time

  // Signature check (cosign for Docker, Sigstore for npm)
  hasSignature: boolean('has_signature').notNull().default(false),
  signatureKeyId: text('signature_key_id'),
  signatureIssuer: text('signature_issuer'),

  // Provenance check (SLSA attestations)
  hasProvenance: boolean('has_provenance').notNull().default(false),
  provenanceSourceRepo: text('provenance_source_repo'),
  provenanceBuilder: text('provenance_builder'),
  provenanceCommit: text('provenance_commit'),
  provenanceBuildType: text('provenance_build_type'),

  // Rekor transparency log
  hasRekorEntry: boolean('has_rekor_entry').notNull().default(false),
  rekorEntryCount: integer('rekor_entry_count'),
  rekorLogIndex: integer('rekor_log_index'),

  verifiedAt: timestamp('verified_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt,
}, (t) => [
  index('idx_rc_verifications_artifact').on(t.artifactId),
  index('idx_rc_verifications_version').on(t.versionId),
  index('idx_rc_verifications_digest').on(t.digest),
]);

// ---------------------------------------------------------------------------
// Attribution tracking
//
// Links artifact changes back to the CI/CD pipeline that produced them.
// Populated by matching CI notifications against detected events, then
// verifying against GitHub Actions API.
// ---------------------------------------------------------------------------

export const rcAttributions = pgTable('rc_attributions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  artifactEventId: uuid('artifact_event_id').notNull().references(() => rcArtifactEvents.id, { onDelete: 'cascade' }),
  artifactId: uuid('artifact_id').notNull().references(() => rcArtifacts.id, { onDelete: 'cascade' }),

  status: text('status').notNull().default('pending'),
  // pending | verified | inferred | suspicious | unattributed

  ciRunId: bigint('ci_run_id', { mode: 'bigint' }),
  commit: text('commit'),
  actor: text('actor'),
  workflow: text('workflow'),
  repo: text('repo'),

  // Full details of the verification (mismatches, run URL, etc.)
  details: jsonb('details').default({}),

  createdAt,
  updatedAt,
}, (t) => [
  uniqueIndex('uq_rc_attribution_event').on(t.artifactEventId),
  index('idx_rc_attributions_artifact').on(t.artifactId),
  index('idx_rc_attributions_status').on(t.status),
]);

// ---------------------------------------------------------------------------
// CI notifications
//
// Received from instrumented CI workflows (e.g. GitHub Actions) that report
// what they built. Matched against detected artifact events to verify
// attribution.
// ---------------------------------------------------------------------------

export const rcCiNotifications = pgTable('rc_ci_notifications', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),

  artifactName: text('artifact_name').notNull(),
  artifactType: text('artifact_type').notNull(),           // docker_image | npm_package
  version: text('version').notNull(),                      // tag or semver
  digest: text('digest').notNull(),

  // CI metadata
  githubRunId: bigint('github_run_id', { mode: 'bigint' }).notNull(),
  githubCommit: text('github_commit').notNull(),
  githubActor: text('github_actor').notNull(),
  githubWorkflow: text('github_workflow').notNull(),
  githubRepo: text('github_repo').notNull(),

  // Verification against GitHub API
  verified: boolean('verified').default(false),
  verificationDetails: jsonb('verification_details'),
  matchedArtifactEventId: uuid('matched_artifact_event_id').references(() => rcArtifactEvents.id, { onDelete: 'set null' }),

  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt,
}, (t) => [
  index('idx_rc_ci_notif_org').on(t.orgId),
  index('idx_rc_ci_notif_artifact').on(t.artifactName, t.version),
  index('idx_rc_ci_notif_digest').on(t.digest),
  index('idx_rc_ci_notif_unmatched').on(t.artifactName, t.version, t.digest)
    .where(sql`matched_artifact_event_id IS NULL`),
]);
