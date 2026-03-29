/**
 * Chunk 201 — Mutation → job trigger tests
 *
 * Verifies that mutating endpoints (PUT, POST, PATCH) enqueue the expected
 * BullMQ jobs after state changes. Catches silent no-ops where the DB is
 * updated but no background work is triggered.
 *
 * Strategy: spy on queue.add() and assert it was called with the right
 * job name after each mutation.
 */
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import {
  cleanTables,
  resetCounters,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestSession,
  createTestArtifact,
} from '../helpers/setup.js';
import { getApp, appRequest } from '../../apps/api/src/__tests__/helpers.js';
import { getQueue, QUEUE_NAMES } from '@sentinel/shared/queue';
import type { Hono } from 'hono';

let app: Hono<any>;
let addSpy: ReturnType<typeof vi.fn>;
let originalAdd: any;

beforeAll(async () => {
  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();

  // Spy on the module-jobs queue's add method
  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  originalAdd = queue.add.bind(queue);
  addSpy = vi.fn(originalAdd);
  queue.add = addSpy;
});

afterEach(() => {
  // Restore original
  const queue = getQueue(QUEUE_NAMES.MODULE_JOBS);
  if (originalAdd) queue.add = originalAdd;
});

// ---------------------------------------------------------------------------
// Helper: find a call to queue.add with a specific job name
// ---------------------------------------------------------------------------

function findJobCall(spy: ReturnType<typeof vi.fn>, jobName: string) {
  return spy.mock.calls.find((call: any[]) => call[0] === jobName);
}

function assertJobEnqueued(spy: ReturnType<typeof vi.fn>, jobName: string, msg?: string) {
  const call = findJobCall(spy, jobName);
  expect(call, msg ?? `Expected job "${jobName}" to be enqueued`).toBeDefined();
  return call;
}

function assertNoJobEnqueued(spy: ReturnType<typeof vi.fn>, jobName: string, msg?: string) {
  const call = findJobCall(spy, jobName);
  expect(call, msg ?? `Expected job "${jobName}" NOT to be enqueued`).toBeUndefined();
}

describe('Chunk 201 — Mutations trigger background jobs', () => {
  // =========================================================================
  // Registry
  // =========================================================================

  describe('Registry images', () => {
    it('PUT /images/:id should trigger registry.poll when enabled', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const artifact = await createTestArtifact(org.id, {
        name: 'org/trigger-test',
        artifactType: 'docker_image',
      });

      addSpy.mockClear();

      const res = await appRequest(app, 'PUT', `/modules/registry/images/${artifact.id}`, {
        cookie: session.cookie,
        body: {
          tagWatchPatterns: ['v*'],
          pollIntervalSeconds: 120,
          enabled: true,
        },
      });
      expect(res.status).toBe(200);
      assertJobEnqueued(addSpy, 'registry.poll', 'PUT /images/:id should enqueue registry.poll');
    });

    it('PUT /images/:id should NOT trigger poll when disabling', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const artifact = await createTestArtifact(org.id, {
        name: 'org/disable-test',
        artifactType: 'docker_image',
      });

      addSpy.mockClear();

      const res = await appRequest(app, 'PUT', `/modules/registry/images/${artifact.id}`, {
        cookie: session.cookie,
        body: { enabled: false },
      });
      expect(res.status).toBe(200);
      assertNoJobEnqueued(addSpy, 'registry.poll', 'Disabling should not enqueue a poll');
    });

    it('POST /images/:id/credentials should trigger registry.poll', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const artifact = await createTestArtifact(org.id, {
        name: 'org/creds-test',
        artifactType: 'docker_image',
      });

      addSpy.mockClear();

      const res = await appRequest(app, 'POST', `/modules/registry/images/${artifact.id}/credentials`, {
        cookie: session.cookie,
        body: { dockerUsername: 'user', dockerToken: 'token123' },
      });
      expect(res.status).toBe(200);
      assertJobEnqueued(addSpy, 'registry.poll', 'Setting credentials should trigger a poll');
    });

    it('POST /images/:id/poll should trigger registry.poll', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const artifact = await createTestArtifact(org.id, {
        name: 'org/pollnow-test',
        artifactType: 'docker_image',
      });

      addSpy.mockClear();

      const res = await appRequest(app, 'POST', `/modules/registry/images/${artifact.id}/poll`, {
        cookie: session.cookie,
      });
      expect(res.status).toBe(202);
      assertJobEnqueued(addSpy, 'registry.poll', 'Poll-now should enqueue registry.poll');
    });
  });

  // =========================================================================
  // Registry — Packages
  // =========================================================================

  describe('Registry packages', () => {
    it('PUT /packages/:id should trigger registry.poll when enabled', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const artifact = await createTestArtifact(org.id, {
        name: '@scope/trigger-pkg',
        artifactType: 'npm_package',
        registry: 'npmjs',
      });

      addSpy.mockClear();

      const res = await appRequest(app, 'PUT', `/modules/registry/packages/${artifact.id}`, {
        cookie: session.cookie,
        body: {
          tagWatchPatterns: ['*'],
          pollIntervalSeconds: 120,
          enabled: true,
        },
      });
      expect(res.status).toBe(200);
      assertJobEnqueued(addSpy, 'registry.poll', 'PUT /packages/:id should enqueue registry.poll');
    });
  });

  // =========================================================================
  // Infra
  // =========================================================================

  describe('Infra hosts', () => {
    it('POST /hosts should trigger infra.scan', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      addSpy.mockClear();

      const res = await appRequest(app, 'POST', '/modules/infra/hosts', {
        cookie: session.cookie,
        body: { hostname: 'scan-trigger.example.com' },
      });
      expect(res.status).toBe(201);
      assertJobEnqueued(addSpy, 'infra.scan', 'Creating a host should trigger an initial scan');
    });

    it('POST /hosts/:id/scan should trigger infra.scan', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const createRes = await appRequest(app, 'POST', '/modules/infra/hosts', {
        cookie: session.cookie,
        body: { hostname: 'manual-scan.example.com' },
      });
      const { data: host } = await createRes.json();

      addSpy.mockClear();

      const res = await appRequest(app, 'POST', `/modules/infra/hosts/${host.id}/scan`, {
        cookie: session.cookie,
      });
      expect(res.status).toBe(202);
      assertJobEnqueued(addSpy, 'infra.scan', 'Manual scan should enqueue infra.scan');
    });

    it('PUT /hosts/:id/schedule should reset nextRunAt so scheduler picks it up', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const createRes = await appRequest(app, 'POST', '/modules/infra/hosts', {
        cookie: session.cookie,
        body: { hostname: 'schedule-test.example.com' },
      });
      const { data: host } = await createRes.json();

      // Wait a moment then update schedule
      const res = await appRequest(app, 'PUT', `/modules/infra/hosts/${host.id}/schedule`, {
        cookie: session.cookie,
        body: { enabled: true, scanIntervalHours: 1 },
      });
      expect(res.status).toBe(200);

      // Verify nextRunAt was reset to approximately now
      const detailRes = await appRequest(app, 'GET', `/modules/infra/hosts/${host.id}`, {
        cookie: session.cookie,
      });
      const detail = await detailRes.json();
      const nextRun = new Date(detail.data.schedule.nextRunAt);
      const diff = Math.abs(Date.now() - nextRun.getTime());
      expect(diff).toBeLessThan(5000); // within 5 seconds of now
    });
  });

  // =========================================================================
  // AWS
  // =========================================================================

  describe('AWS integrations', () => {
    it('POST /integrations should trigger aws.sqs.poll', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      addSpy.mockClear();

      const res = await appRequest(app, 'POST', '/modules/aws/integrations', {
        cookie: session.cookie,
        body: {
          name: 'test-integration',
          accountId: '123456789012',
          roleArn: 'arn:aws:iam::123456789012:role/test',
          sqsRegion: 'us-east-1',
          regions: ['us-east-1'],
        },
      });
      expect(res.status).toBe(201);
      assertJobEnqueued(addSpy, 'aws.sqs.poll', 'Creating integration should trigger initial poll');
    });
  });
});
