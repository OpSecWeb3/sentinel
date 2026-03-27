import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  normalizeDockerWebhook,
  normalizeNpmWebhook,
  normalizePollChange,
  type DockerHubWebhookPayload,
  type NpmEventPayload,
} from '../normalizer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ID = 'org-release-1';
const DELIVERY_ID = 'delivery-xyz-123';

function baseDockerPayload(): DockerHubWebhookPayload {
  return {
    callback_url: 'https://registry.hub.docker.com/u/library/nginx/hook/abc123',
    push_data: {
      pushed_at: 1700000000,
      tag: 'v1.25.3',
      pusher: 'dockerbot',
      images: ['amd64'],
    },
    repository: {
      repo_name: 'library/nginx',
      namespace: 'library',
      name: 'nginx',
      repo_url: 'https://hub.docker.com/r/library/nginx',
      date_created: 1400000000,
      star_count: 19000,
      description: 'Official NGINX image',
    },
  };
}

function baseNpmPublishPayload(): NpmEventPayload {
  return {
    event: 'package:publish',
    name: '@acme/core',
    type: 'package',
    version: '2.0.0',
    change: {
      version: '2.0.0',
      'dist-tag': 'latest',
    },
  };
}

// ===========================================================================
// Docker Hub webhook normalization
// ===========================================================================

describe('normalizeDockerWebhook', () => {
  it('normalizes Docker Hub push to release-chain.docker.new_tag', () => {
    const result = normalizeDockerWebhook(baseDockerPayload(), ORG_ID, DELIVERY_ID);

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('release-chain.docker.new_tag');
    expect(result!.moduleId).toBe('release-chain');
    expect(result!.orgId).toBe(ORG_ID);
    expect(result!.payload).toMatchObject({
      artifact: 'library/nginx',
      registry: 'docker_hub',
      tag: 'v1.25.3',
      pusher: 'dockerbot',
      source: 'webhook',
      namespace: 'library',
      repoUrl: 'https://hub.docker.com/r/library/nginx',
    });
  });

  it('converts pushed_at epoch to ISO string', () => {
    const result = normalizeDockerWebhook(baseDockerPayload(), ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.payload.pushedAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('preserves external ID (delivery ID)', () => {
    const result = normalizeDockerWebhook(baseDockerPayload(), ORG_ID, DELIVERY_ID);

    expect(result).not.toBeNull();
    expect(result!.externalId).toBe(DELIVERY_ID);
  });

  it('sets externalId to null when not provided', () => {
    const result = normalizeDockerWebhook(baseDockerPayload(), ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.externalId).toBeNull();
  });

  it('sets occurredAt to a Date instance', () => {
    const result = normalizeDockerWebhook(baseDockerPayload(), ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.occurredAt).toBeInstanceOf(Date);
  });

  it('returns null when repository.repo_name is missing', () => {
    const payload = baseDockerPayload();
    // @ts-expect-error intentionally malformed
    payload.repository.repo_name = undefined;

    const result = normalizeDockerWebhook(payload, ORG_ID, DELIVERY_ID);
    expect(result).toBeNull();
  });

  it('returns null when push_data.tag is missing', () => {
    const payload = baseDockerPayload();
    // @ts-expect-error intentionally malformed
    payload.push_data.tag = undefined;

    const result = normalizeDockerWebhook(payload, ORG_ID, DELIVERY_ID);
    expect(result).toBeNull();
  });

  it('returns null when repository is entirely missing', () => {
    const payload = baseDockerPayload();
    // @ts-expect-error intentionally malformed
    payload.repository = undefined;

    const result = normalizeDockerWebhook(payload, ORG_ID, DELIVERY_ID);
    expect(result).toBeNull();
  });

  it('sets pusher to null when push_data.pusher is missing', () => {
    const payload = baseDockerPayload();
    // @ts-expect-error intentionally malformed
    delete payload.push_data.pusher;

    const result = normalizeDockerWebhook(payload, ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.payload.pusher).toBeNull();
  });

  it('sets pushedAt to null when pushed_at is 0/falsy', () => {
    const payload = baseDockerPayload();
    payload.push_data.pushed_at = 0;

    const result = normalizeDockerWebhook(payload, ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.payload.pushedAt).toBeNull();
  });
});

// ===========================================================================
// npm webhook normalization
// ===========================================================================

describe('normalizeNpmWebhook — package:publish', () => {
  it('normalizes npm version publish correctly', () => {
    const result = normalizeNpmWebhook(baseNpmPublishPayload(), ORG_ID, DELIVERY_ID);

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('release-chain.npm.version_published');
    expect(result!.moduleId).toBe('release-chain');
    expect(result!.orgId).toBe(ORG_ID);
    expect(result!.externalId).toBe(DELIVERY_ID);
    expect(result!.payload).toMatchObject({
      artifact: '@acme/core',
      registry: 'npmjs',
      tag: '2.0.0',
      version: '2.0.0',
      distTag: 'latest',
      source: 'webhook',
    });
  });

  it('falls back to top-level version when change.version is missing', () => {
    const payload: NpmEventPayload = {
      event: 'package:publish',
      name: 'lodash',
      type: 'package',
      version: '4.17.21',
    };

    const result = normalizeNpmWebhook(payload, ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.payload.version).toBe('4.17.21');
    expect(result!.payload.tag).toBe('4.17.21');
  });

  it('uses * when both version fields are missing', () => {
    const payload: NpmEventPayload = {
      event: 'package:publish',
      name: 'lodash',
      type: 'package',
    };

    const result = normalizeNpmWebhook(payload, ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.payload.tag).toBe('*');
  });
});

describe('normalizeNpmWebhook — package:deprecate', () => {
  it('normalizes npm deprecation correctly', () => {
    const payload: NpmEventPayload = {
      event: 'package:deprecate',
      name: '@acme/legacy',
      type: 'package',
      version: '1.0.0',
      change: {
        version: '1.0.0',
        deprecation: 'This package has been renamed to @acme/core',
      },
    };

    const result = normalizeNpmWebhook(payload, ORG_ID, DELIVERY_ID);

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('release-chain.npm.version_deprecated');
    expect(result!.payload).toMatchObject({
      artifact: '@acme/legacy',
      registry: 'npmjs',
      version: '1.0.0',
      deprecationMessage: 'This package has been renamed to @acme/core',
      source: 'webhook',
    });
  });

  it('sets deprecationMessage to null when not present', () => {
    const payload: NpmEventPayload = {
      event: 'package:deprecate',
      name: 'old-pkg',
      type: 'package',
      version: '0.1.0',
      change: { version: '0.1.0' },
    };

    const result = normalizeNpmWebhook(payload, ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.payload.deprecationMessage).toBeNull();
  });
});

describe('normalizeNpmWebhook — maintainer change', () => {
  it('normalizes owner-added correctly', () => {
    const payload: NpmEventPayload = {
      event: 'package:owner-added',
      name: '@acme/core',
      type: 'package',
      change: {
        maintainer: { name: 'newdev', email: 'newdev@example.com' },
      },
    };

    const result = normalizeNpmWebhook(payload, ORG_ID, DELIVERY_ID);

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('release-chain.npm.maintainer_changed');
    expect(result!.payload).toMatchObject({
      artifact: '@acme/core',
      registry: 'npmjs',
      tag: '*',
      action: 'added',
      maintainer: { name: 'newdev', email: 'newdev@example.com' },
      source: 'webhook',
    });
  });

  it('normalizes owner-removed correctly', () => {
    const payload: NpmEventPayload = {
      event: 'package:owner-removed',
      name: '@acme/core',
      type: 'package',
      change: {
        maintainer: { name: 'olddev', email: 'olddev@example.com' },
      },
    };

    const result = normalizeNpmWebhook(payload, ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.eventType).toBe('release-chain.npm.maintainer_changed');
    expect(result!.payload.action).toBe('removed');
    expect(result!.payload.maintainer).toEqual({ name: 'olddev', email: 'olddev@example.com' });
  });

  it('sets maintainer to null when change.maintainer is missing', () => {
    const payload: NpmEventPayload = {
      event: 'package:owner-added',
      name: '@acme/core',
      type: 'package',
    };

    const result = normalizeNpmWebhook(payload, ORG_ID);

    expect(result).not.toBeNull();
    expect(result!.payload.maintainer).toBeNull();
  });
});

describe('normalizeNpmWebhook — unsupported events', () => {
  it('returns null for unknown npm event type', () => {
    const payload: NpmEventPayload = {
      event: 'package:star',
      name: 'cool-lib',
      type: 'package',
    };

    const result = normalizeNpmWebhook(payload, ORG_ID, DELIVERY_ID);
    expect(result).toBeNull();
  });
});

// ===========================================================================
// Poll-based normalization
// ===========================================================================

describe('normalizePollChange', () => {
  it('normalizes poll-detected digest change', () => {
    const payload = {
      artifact: 'library/nginx',
      registry: 'docker_hub',
      tag: 'latest',
      oldDigest: 'sha256:aaa',
      newDigest: 'sha256:bbb',
    };

    const result = normalizePollChange('docker.digest_change', payload, ORG_ID);

    expect(result).not.toBeNull();
    expect(result.eventType).toBe('release-chain.docker.digest_change');
    expect(result.moduleId).toBe('release-chain');
    expect(result.orgId).toBe(ORG_ID);
    expect(result.externalId).toBeNull();
    expect(result.payload).toMatchObject({
      artifact: 'library/nginx',
      tag: 'latest',
      oldDigest: 'sha256:aaa',
      newDigest: 'sha256:bbb',
      source: 'poll',
    });
  });

  it('normalizes poll-detected tag removal', () => {
    const payload = {
      artifact: 'library/redis',
      registry: 'docker_hub',
      tag: 'alpine3.18',
      lastDigest: 'sha256:ccc',
    };

    const result = normalizePollChange('docker.tag_removed', payload, ORG_ID);

    expect(result.eventType).toBe('release-chain.docker.tag_removed');
    expect(result.payload.source).toBe('poll');
    expect(result.payload.artifact).toBe('library/redis');
    expect(result.payload.tag).toBe('alpine3.18');
  });

  it('normalizes poll-detected npm version published', () => {
    const result = normalizePollChange(
      'npm.version_published',
      { artifact: 'lodash', version: '4.18.0', registry: 'npmjs' },
      ORG_ID,
    );

    expect(result.eventType).toBe('release-chain.npm.version_published');
    expect(result.payload.source).toBe('poll');
  });

  it('always sets externalId to null for poll changes', () => {
    const result = normalizePollChange(
      'docker.new_tag',
      { artifact: 'library/node', tag: '22-slim' },
      ORG_ID,
    );

    expect(result.externalId).toBeNull();
  });

  it('sets occurredAt to a Date instance', () => {
    const result = normalizePollChange(
      'docker.new_tag',
      { artifact: 'library/node', tag: '22' },
      ORG_ID,
    );

    expect(result.occurredAt).toBeInstanceOf(Date);
  });
});
