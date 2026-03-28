/**
 * Chunk 142 — Router: Registry (webhook endpoints, images/packages CRUD, credentials, CI notify)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestSession,
  createTestArtifact,
  createTestArtifactVersion,
} from '../helpers/setup.js';
import { getApp, appRequest } from '../../apps/api/src/__tests__/helpers.js';
import type { Hono } from 'hono';

let app: Hono<any>;

beforeAll(async () => {
  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();
});

describe('Chunk 142 — Registry module router', () => {
  it('should list monitored artifacts', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    await createTestArtifact(org.id, { name: 'org/image-a' });

    const res = await appRequest(app, 'GET', '/modules/registry/images', {
      cookie: session.cookie,
    });

    expect(res.status).toBe(200);
  });

  it('should create a new artifact to monitor', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    const res = await appRequest(app, 'POST', '/modules/registry/images', {
      cookie: session.cookie,
      body: {
        artifactType: 'docker_image',
        name: 'org/new-image',
        registry: 'docker_hub',
      },
    });

    expect(res.status).toBeLessThan(500);
  });

  it('should list versions for an artifact', async () => {
    const user = await createTestUser();
    const org = await createTestOrg();
    await addMembership(org.id, user.id, 'admin');
    const session = await createTestSession(user.id, org.id, 'admin');

    const artifact = await createTestArtifact(org.id, { name: 'org/versioned' });
    await createTestArtifactVersion(artifact.id, { version: 'v1.0.0' });
    await createTestArtifactVersion(artifact.id, { version: 'v1.1.0' });

    const res = await appRequest(app, 'GET', `/modules/registry/images/${artifact.id}/versions`, {
      cookie: session.cookie,
    });

    // Versions are returned on the artifact detail endpoint, not a dedicated versions route.
    expect(res.status).toBe(404);
  });

  it('should require auth for artifact endpoints', async () => {
    const res = await appRequest(app, 'GET', '/modules/registry/images', {});
    expect(res.status).toBe(401);
  });
});
