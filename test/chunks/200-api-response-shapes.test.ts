/**
 * Chunk 200 — API response shape tests
 *
 * Verifies that list and detail endpoints return the fields the frontend
 * actually accesses. Catches DB column → API response name mismatches
 * (e.g. tagWatchPatterns vs tagPatterns) before they hit production.
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

// ---------------------------------------------------------------------------
// Helper: assert a set of required keys exist on every item in a list response
// ---------------------------------------------------------------------------

function assertResponseShape(body: any, requiredKeys: string[], path = 'data') {
  const items = path.split('.').reduce((o, k) => o?.[k], body);
  expect(items).toBeDefined();
  expect(Array.isArray(items)).toBe(true);
  for (const item of items) {
    for (const key of requiredKeys) {
      expect(item, `Missing key "${key}" in response item`).toHaveProperty(key);
    }
  }
}

function assertObjectShape(body: any, requiredKeys: string[], path = 'data') {
  const obj = path.split('.').reduce((o, k) => o?.[k], body);
  expect(obj).toBeDefined();
  for (const key of requiredKeys) {
    expect(obj, `Missing key "${key}" in response object`).toHaveProperty(key);
  }
}

// ===========================================================================
// Registry — Images
// ===========================================================================

describe('Chunk 200 — API response shapes', () => {
  describe('Registry images list', () => {
    it('should return tagPatterns, tagCount, lastEvent, verificationStatus — not raw DB columns', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const artifact = await createTestArtifact(org.id, {
        name: 'org/test-image',
        artifactType: 'docker_image',
      });
      await createTestArtifactVersion(artifact.id, { version: 'v1.0.0' });

      const res = await appRequest(app, 'GET', '/modules/registry/images', {
        cookie: session.cookie,
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      assertResponseShape(body, [
        'id',
        'name',
        'tagPatterns',       // NOT tagWatchPatterns
        'ignorePatterns',    // NOT tagIgnorePatterns
        'tagCount',          // computed from rcArtifactVersions
        'lastEvent',         // computed from rcArtifactEvents
        'verificationStatus', // computed from rcVerifications
        'hasCredentials',
        'enabled',
        'pollIntervalSeconds',
      ]);

      // Must NOT have raw DB column names
      const item = body.data[0];
      expect(item).not.toHaveProperty('tagWatchPatterns');
      expect(item).not.toHaveProperty('tagIgnorePatterns');
      expect(item).not.toHaveProperty('credentialsEncrypted');
    });

    it('tagCount should reflect actual version count', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const artifact = await createTestArtifact(org.id, {
        name: 'org/counted-image',
        artifactType: 'docker_image',
      });
      await createTestArtifactVersion(artifact.id, { version: 'v1.0.0' });
      await createTestArtifactVersion(artifact.id, { version: 'v1.1.0' });
      await createTestArtifactVersion(artifact.id, { version: 'v2.0.0' });

      const res = await appRequest(app, 'GET', '/modules/registry/images', {
        cookie: session.cookie,
      });
      const body = await res.json();
      expect(body.data[0].tagCount).toBe(3);
    });
  });

  // =========================================================================
  // Registry — Packages
  // =========================================================================

  describe('Registry packages list', () => {
    it('should return tagPatterns, tagCount, latestVersion, provenanceStatus — not raw DB columns', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const artifact = await createTestArtifact(org.id, {
        name: '@scope/test-pkg',
        artifactType: 'npm_package',
        registry: 'npmjs',
      });
      await createTestArtifactVersion(artifact.id, { version: '1.0.0' });

      const res = await appRequest(app, 'GET', '/modules/registry/packages', {
        cookie: session.cookie,
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      assertResponseShape(body, [
        'id',
        'name',
        'tagPatterns',
        'ignorePatterns',
        'tagCount',
        'lastEvent',
        'latestVersion',
        'provenanceStatus',
        'hasCredentials',
      ]);

      const item = body.data[0];
      expect(item).not.toHaveProperty('tagWatchPatterns');
      expect(item).not.toHaveProperty('tagIgnorePatterns');
      expect(item).not.toHaveProperty('credentialsEncrypted');
    });
  });

  // =========================================================================
  // Registry — PUT response shape
  // =========================================================================

  describe('Registry PUT response', () => {
    it('PUT /images/:id should return tagPatterns not tagWatchPatterns', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const artifact = await createTestArtifact(org.id, {
        name: 'org/edit-image',
        artifactType: 'docker_image',
      });

      const res = await appRequest(app, 'PUT', `/modules/registry/images/${artifact.id}`, {
        cookie: session.cookie,
        body: {
          tagWatchPatterns: ['v*'],
          pollIntervalSeconds: 120,
          enabled: true,
        },
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      assertObjectShape(body, ['tagPatterns', 'ignorePatterns', 'hasCredentials']);
      expect(body.data).not.toHaveProperty('tagWatchPatterns');
      expect(body.data).not.toHaveProperty('tagIgnorePatterns');
    });
  });

  // =========================================================================
  // GitHub — Repositories
  // =========================================================================

  describe('GitHub repositories list', () => {
    it('should return syncedAt not lastSyncedAt', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const res = await appRequest(app, 'GET', '/modules/github/repositories', {
        cookie: session.cookie,
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      // Even if empty, the response should be an array
      expect(Array.isArray(body.data)).toBe(true);

      // If there are items, verify shape
      if (body.data.length > 0) {
        assertResponseShape(body, ['syncedAt']);
        expect(body.data[0]).not.toHaveProperty('lastSyncedAt');
      }
    });
  });

  // =========================================================================
  // Infra — Host detail schedule
  // =========================================================================

  describe('Infra host detail schedule', () => {
    it('should include nextRunAt and probeNextRunAt in schedule', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      // Create host via API
      const createRes = await appRequest(app, 'POST', '/modules/infra/hosts', {
        cookie: session.cookie,
        body: { hostname: 'example.com' },
      });
      expect(createRes.status).toBe(201);
      const { data: host } = await createRes.json();

      // Fetch detail
      const detailRes = await appRequest(app, 'GET', `/modules/infra/hosts/${host.id}`, {
        cookie: session.cookie,
      });
      expect(detailRes.status).toBe(200);

      const detail = await detailRes.json();
      expect(detail.data.schedule).toBeDefined();
      expect(detail.data.schedule).toHaveProperty('nextRunAt');
      expect(detail.data.schedule).toHaveProperty('probeNextRunAt');
      expect(detail.data.schedule).toHaveProperty('scanIntervalHours');
      expect(detail.data.schedule).toHaveProperty('probeIntervalMinutes');
    });
  });
});
