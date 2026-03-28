/**
 * Normalizes raw Docker Hub webhook payloads and npm registry events
 * into platform NormalizedEvent format.
 */

// ---------------------------------------------------------------------------
// Normalized event input (before DB fields are added)
// ---------------------------------------------------------------------------

interface NormalizedEventInput {
  eventType: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Docker Hub webhook payload types
// ---------------------------------------------------------------------------

export interface DockerHubWebhookPayload {
  callback_url: string;
  push_data: {
    pushed_at: number;
    tag: string;
    pusher: string;
    images?: string[];
  };
  repository: {
    repo_name: string;
    namespace: string;
    name: string;
    repo_url: string;
    date_created: number;
    star_count: number;
    description: string;
  };
}

// ---------------------------------------------------------------------------
// npm event payload types
// ---------------------------------------------------------------------------

export interface NpmEventPayload {
  event: string;
  name: string;
  type: string;
  version?: string;
  change?: {
    version?: string;
    'dist-tag'?: string;
    deprecation?: string;
    maintainer?: { name: string; email: string };
  };
}

// ---------------------------------------------------------------------------
// CI notification payload
// ---------------------------------------------------------------------------

export interface CiNotificationPayload {
  image: string;
  tag: string;
  digest: string;
  runId: number;
  commit: string;
  actor: string;
  workflow: string;
  repo: string;
}

// ---------------------------------------------------------------------------
// Docker Hub normalizer
// ---------------------------------------------------------------------------

function normalizeDockerHubEvent(payload: DockerHubWebhookPayload): NormalizedEventInput | null {
  const { push_data, repository } = payload;

  if (!repository?.repo_name || !push_data?.tag) return null;

  // Docker Hub webhooks are push events: a tag was pushed (new or updated).
  // We map this to digest_change when there is no way to tell if the tag is new
  // from the webhook alone. The polling service distinguishes new_tag vs digest_change
  // by checking stored state. For webhooks, we emit new_tag if it is the first time
  // we see it, but the handler will refine this after checking DB state.
  return {
    eventType: 'registry.docker.new_tag',
    payload: {
      resourceId: repository.repo_name,
      artifact: repository.repo_name,
      registry: 'docker_hub',
      tag: push_data.tag,
      pusher: push_data.pusher ?? null,
      pushedAt: push_data.pushed_at
        ? new Date(push_data.pushed_at * 1000).toISOString()
        : null,
      source: 'webhook',
      namespace: repository.namespace,
      repoUrl: repository.repo_url,
    },
  };
}

// ---------------------------------------------------------------------------
// npm normalizer
// ---------------------------------------------------------------------------

const NPM_EVENT_MAP: Record<string, (p: NpmEventPayload) => NormalizedEventInput | null> = {
  'package:publish': (p) => ({
    eventType: 'registry.npm.version_published',
    payload: {
      resourceId: p.name,
      artifact: p.name,
      registry: 'npmjs',
      tag: p.change?.version ?? p.version ?? '*',
      version: p.change?.version ?? p.version,
      distTag: p.change?.['dist-tag'] ?? null,
      source: 'webhook',
    },
  }),

  'package:unpublish': (p) => ({
    eventType: 'registry.npm.version_unpublished',
    payload: {
      resourceId: p.name,
      artifact: p.name,
      registry: 'npmjs',
      tag: p.change?.version ?? p.version ?? '*',
      version: p.change?.version ?? p.version,
      unpublished: true,
      source: 'webhook',
    },
  }),

  'package:deprecate': (p) => ({
    eventType: 'registry.npm.version_deprecated',
    payload: {
      resourceId: p.name,
      artifact: p.name,
      registry: 'npmjs',
      tag: p.change?.version ?? p.version ?? '*',
      version: p.change?.version ?? p.version,
      deprecationMessage: p.change?.deprecation ?? null,
      source: 'webhook',
    },
  }),

  'package:owner-added': (p) => ({
    eventType: 'registry.npm.maintainer_changed',
    payload: {
      resourceId: p.name,
      artifact: p.name,
      registry: 'npmjs',
      tag: '*',
      action: 'added',
      maintainer: p.change?.maintainer ?? null,
      source: 'webhook',
    },
  }),

  'package:owner-removed': (p) => ({
    eventType: 'registry.npm.maintainer_changed',
    payload: {
      resourceId: p.name,
      artifact: p.name,
      registry: 'npmjs',
      tag: '*',
      action: 'removed',
      maintainer: p.change?.maintainer ?? null,
      source: 'webhook',
    },
  }),
};

function normalizeNpmEvent(payload: NpmEventPayload): NormalizedEventInput | null {
  const handler = NPM_EVENT_MAP[payload.event];
  if (!handler) return null;
  return handler(payload);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a Docker Hub webhook into a platform event record.
 */
export function normalizeDockerWebhook(
  payload: DockerHubWebhookPayload,
  orgId: string,
  externalId?: string,
) {
  const result = normalizeDockerHubEvent(payload);
  if (!result) return null;

  return {
    orgId,
    moduleId: 'registry' as const,
    eventType: result.eventType,
    externalId: externalId ?? null,
    payload: result.payload,
    occurredAt: new Date(),
  };
}

/**
 * Normalize an npm registry event into a platform event record.
 */
export function normalizeNpmWebhook(
  payload: NpmEventPayload,
  orgId: string,
  externalId?: string,
) {
  const result = normalizeNpmEvent(payload);
  if (!result) return null;

  return {
    orgId,
    moduleId: 'registry' as const,
    eventType: result.eventType,
    externalId: externalId ?? null,
    payload: result.payload,
    occurredAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Poll-based normalizer — used by the polling service to create event records
// from detected changes.
// ---------------------------------------------------------------------------

export type PollChangeType =
  | 'docker.digest_change'
  | 'docker.new_tag'
  | 'docker.tag_removed'
  | 'npm.version_published'
  | 'npm.version_deprecated'
  | 'npm.version_unpublished'
  | 'npm.maintainer_changed'
  | 'npm.dist_tag_updated'
  | 'npm.new_tag'
  | 'npm.tag_removed';

export function normalizePollChange(
  changeType: PollChangeType,
  payload: Record<string, unknown>,
  orgId: string,
) {
  return {
    orgId,
    moduleId: 'registry' as const,
    eventType: `registry.${changeType}`,
    externalId: null,
    payload: {
      resourceId: payload.artifact,
      ...payload,
      source: 'poll',
    },
    occurredAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function pick(obj: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in obj) result[key] = (obj as Record<string, unknown>)[key];
  }
  return result;
}
