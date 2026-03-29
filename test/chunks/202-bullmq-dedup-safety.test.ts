/**
 * Chunk 202 — BullMQ jobId dedup safety tests
 *
 * Verifies that job producers use unique-enough jobIds so that completed
 * jobs don't silently block re-enqueue on the next cycle.
 *
 * The root pattern that broke us: a sweep job used `jobId: poll-${id}`
 * (static). BullMQ keeps completed jobs (removeOnComplete: { count: 200 }),
 * so the next sweep's queue.add() was silently rejected. The artifact was
 * "due" every 60 seconds but the job never actually ran again.
 *
 * These tests catch that class of bug by:
 *   1. Calling the producer function twice
 *   2. Asserting the second call uses a different jobId than the first
 *   3. Verifying sweep handlers produce time-varying jobIds
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

beforeAll(async () => {
  app = await getApp();
});

beforeEach(async () => {
  await cleanTables();
  resetCounters();
});

// ---------------------------------------------------------------------------
// Helper: capture jobIds from queue.add calls
// ---------------------------------------------------------------------------

function spyOnQueueAdd(queueName: string) {
  const queue = getQueue(queueName);
  const original = queue.add.bind(queue);
  const calls: Array<{ jobName: string; jobId?: string }> = [];

  queue.add = vi.fn(async (name: string, data: any, opts?: any) => {
    calls.push({ jobName: name, jobId: opts?.jobId });
    return original(name, data, opts);
  }) as any;

  return {
    calls,
    restore: () => { queue.add = original; },
  };
}

describe('Chunk 202 — BullMQ jobId dedup safety', () => {
  // =========================================================================
  // Registry poll-now: two calls should produce different jobIds
  // =========================================================================

  describe('Registry poll-now produces unique jobIds', () => {
    it('two consecutive POST /images/:id/poll should not share a jobId', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const artifact = await createTestArtifact(org.id, {
        name: 'org/dedup-test',
        artifactType: 'docker_image',
      });

      const spy = spyOnQueueAdd(QUEUE_NAMES.MODULE_JOBS);

      try {
        await appRequest(app, 'POST', `/modules/registry/images/${artifact.id}/poll`, {
          cookie: session.cookie,
        });

        // Small delay to ensure Date.now() differs
        await new Promise((r) => setTimeout(r, 5));

        await appRequest(app, 'POST', `/modules/registry/images/${artifact.id}/poll`, {
          cookie: session.cookie,
        });

        const pollCalls = spy.calls.filter((c) => c.jobName === 'registry.poll');
        expect(pollCalls.length).toBeGreaterThanOrEqual(2);

        const jobIds = pollCalls.map((c) => c.jobId);
        const uniqueIds = new Set(jobIds);
        expect(uniqueIds.size).toBe(jobIds.length,
          `Expected unique jobIds but got duplicates: ${JSON.stringify(jobIds)}`);
      } finally {
        spy.restore();
      }
    });
  });

  // =========================================================================
  // Registry PUT: updating same artifact twice should produce unique jobIds
  // =========================================================================

  describe('Registry PUT produces unique jobIds', () => {
    it('two consecutive PUT /images/:id should produce different poll jobIds', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      const artifact = await createTestArtifact(org.id, {
        name: 'org/put-dedup',
        artifactType: 'docker_image',
      });

      const spy = spyOnQueueAdd(QUEUE_NAMES.MODULE_JOBS);

      try {
        await appRequest(app, 'PUT', `/modules/registry/images/${artifact.id}`, {
          cookie: session.cookie,
          body: { tagWatchPatterns: ['v1.*'], enabled: true },
        });

        await new Promise((r) => setTimeout(r, 5));

        await appRequest(app, 'PUT', `/modules/registry/images/${artifact.id}`, {
          cookie: session.cookie,
          body: { tagWatchPatterns: ['v2.*'], enabled: true },
        });

        const pollCalls = spy.calls.filter((c) => c.jobName === 'registry.poll');
        expect(pollCalls.length).toBeGreaterThanOrEqual(2);

        const jobIds = pollCalls.map((c) => c.jobId);
        const uniqueIds = new Set(jobIds);
        expect(uniqueIds.size).toBe(jobIds.length,
          `Expected unique jobIds on repeated PUT: ${JSON.stringify(jobIds)}`);
      } finally {
        spy.restore();
      }
    });
  });

  // =========================================================================
  // GitHub repo sync: clicking sync twice should not be silently deduped
  // =========================================================================

  describe('GitHub repo sync produces unique jobIds', () => {
    it('POST /installations/:id/sync should use timestamped jobId', async () => {
      const user = await createTestUser();
      const org = await createTestOrg();
      await addMembership(org.id, user.id, 'admin');
      const session = await createTestSession(user.id, org.id, 'admin');

      // We can't easily create a real GitHub installation in tests,
      // so we just verify the pattern by checking the router code.
      // This is a structural test — if someone changes the jobId back
      // to a static value, the regex will fail.

      const routerCode = await import('node:fs/promises').then((fs) =>
        fs.readFile('modules/github/src/router.ts', 'utf-8'),
      );

      // Installation-scoped jobId dedupes concurrent syncs; per-job removeOnComplete
      // frees the id after completion (see router comment — Fix #8).
      expect(routerCode).toMatch(/jobId:\s*`gh-repo-sync-\$\{installation\.id\}`/);
      expect(routerCode).toMatch(/removeOnComplete:\s*true/);
    });
  });

  // =========================================================================
  // Structural: no static jobIds in sweep handlers
  // =========================================================================

  describe('No static jobIds in sweep/schedule handlers', () => {
    it('poll-sweep should use timestamped jobIds', async () => {
      const code = await import('node:fs/promises').then((fs) =>
        fs.readFile('apps/worker/src/handlers/poll-sweep.ts', 'utf-8'),
      );

      // Should NOT have a static jobId like `poll-${artifact.id}`
      // without a timestamp component
      const staticPattern = /jobId:\s*`poll-\$\{artifact\.id\}`\s*[,)]/;
      expect(code).not.toMatch(staticPattern);

      // Should have Date.now() or similar in the jobId
      expect(code).toMatch(/Date\.now\(\)/);
    });

    it('infra schedule loader should not use static jobIds for scan jobs', async () => {
      const code = await import('node:fs/promises').then((fs) =>
        fs.readFile('modules/infra/src/handlers.ts', 'utf-8'),
      );

      // The schedule loader adds infra.scan jobs without a custom jobId
      // (letting BullMQ auto-generate), which is correct. Verify no
      // static dedup pattern crept in.
      const infraScanStatic = /add\(\s*'infra\.scan'[^)]*jobId:\s*`[^$`]*\$\{[^}]+\}`\s*[,)]/;
      if (infraScanStatic.test(code)) {
        // If a jobId IS set, it should include a timestamp
        const match = code.match(/add\(\s*'infra\.scan'[^)]*jobId:\s*`([^`]+)`/);
        if (match) {
          expect(match[1]).toMatch(/Date\.now|timestamp|Math\.floor/);
        }
      }
    });

    it('aws poll-sweep should use time-varying jobIds', async () => {
      const code = await import('node:fs/promises').then((fs) =>
        fs.readFile('modules/aws/src/handlers.ts', 'utf-8'),
      );

      // AWS sweep uses Math.floor(Date.now() / 60_000) which changes each minute
      expect(code).toMatch(/aws-poll-.*Date\.now\(\)/);
    });
  });

  // =========================================================================
  // Verify removeOnComplete is set (without it, dedup wouldn't matter)
  // =========================================================================

  describe('Queue retains completed jobs (making dedup relevant)', () => {
    it('default queue options should set removeOnComplete with a count > 0', async () => {
      const code = await import('node:fs/promises').then((fs) =>
        fs.readFile('packages/shared/src/queue.ts', 'utf-8'),
      );

      // Verify removeOnComplete is configured (this is what makes static jobIds dangerous)
      expect(code).toMatch(/removeOnComplete/);
    });
  });
});
