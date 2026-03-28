/**
 * Audit Gap 7 — Worker wiring: every periodic handler has a scheduler
 *
 * The infra.schedule.load bug: the handler was registered, the evaluator
 * worked, the API created scan schedules — but nothing triggered the handler
 * because upsertJobScheduler was never called. This test catches that class
 * of bug by verifying the wiring between three layers:
 *
 *   1. Module declares jobHandlers → handler is available to process jobs
 *   2. Worker registers handler in a worker → handler listens on a queue
 *   3. Worker calls upsertJobScheduler → jobs actually get enqueued
 *
 * If any periodic handler is missing from layer 3, scans/polls silently
 * never run. This is the single most impactful test gap we found.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read the worker startup source to verify wiring at the code level.
// This is a static analysis test — it doesn't run the worker, it reads the
// source and asserts that every periodic handler has a matching scheduler.
const workerSource = readFileSync(
  resolve(__dirname, '../../apps/worker/src/index.ts'),
  'utf-8',
);

// Read all module index files to find declared jobHandlers
function readModuleIndex(moduleId: string): string {
  return readFileSync(
    resolve(__dirname, `../../modules/${moduleId}/src/index.ts`),
    'utf-8',
  );
}

// Read module handler files to find jobName declarations
function readModuleHandlers(moduleId: string): string {
  try {
    return readFileSync(
      resolve(__dirname, `../../modules/${moduleId}/src/handlers.ts`),
      'utf-8',
    );
  } catch {
    return '';
  }
}

/**
 * Job names that require periodic scheduling (sweep/poll/schedule patterns).
 * These are handlers whose purpose is to find due work and enqueue it.
 * Without a repeatable scheduler, they never fire.
 *
 * Event-driven handlers (webhook.process, block.process, etc.) are NOT
 * included — they're triggered by upstream jobs or external webhooks.
 */
const PERIODIC_JOB_PATTERNS = [
  /\.poll-sweep$/,
  /\.schedule\.load$/,
  /\.sweep$/,
  /^platform\.(data\.retention|session\.cleanup|key\.rotation)$/,
  /^correlation\.expiry$/,
  /\.rpc-usage\.flush$/,
];

function isPeriodicJob(jobName: string): boolean {
  return PERIODIC_JOB_PATTERNS.some((pattern) => pattern.test(jobName));
}

describe('Gap 7 — Worker wiring verification', () => {
  describe('Every module handler is registered in the worker', () => {
    const modules = ['github', 'registry', 'chain', 'infra', 'aws'];

    for (const mod of modules) {
      it(`should register all ${mod} jobHandlers via modules.flatMap`, () => {
        const source = readModuleIndex(mod);
        // Module must export jobHandlers array
        expect(source).toMatch(/jobHandlers:\s*\[/);
      });
    }

    it('should collect module handlers via flatMap', () => {
      expect(workerSource).toContain('modules.flatMap((m) => m.jobHandlers)');
    });
  });

  describe('Every periodic handler has a matching upsertJobScheduler call', () => {
    // Extract all jobName values from module handler files
    const allJobNames: string[] = [];
    const moduleIds = ['github', 'registry', 'chain', 'infra', 'aws'];

    for (const mod of moduleIds) {
      const handlers = readModuleHandlers(mod);
      const matches = handlers.matchAll(/jobName:\s*'([^']+)'/g);
      for (const m of matches) {
        allJobNames.push(m[1]);
      }
    }

    // Also include core handler job names
    const coreHandlerFiles = [
      'event-processing', 'alert-dispatch', 'data-retention',
      'correlation-evaluate', 'correlation-expiry',
      'poll-sweep', 'session-cleanup', 'key-rotation',
    ];
    for (const file of coreHandlerFiles) {
      try {
        const source = readFileSync(
          resolve(__dirname, `../../apps/worker/src/handlers/${file}.ts`),
          'utf-8',
        );
        const matches = source.matchAll(/jobName:\s*'([^']+)'/g);
        for (const m of matches) {
          allJobNames.push(m[1]);
        }
      } catch { /* file may not exist */ }
    }

    // Filter to periodic jobs only
    const periodicJobs = allJobNames.filter(isPeriodicJob);

    it('should have identified periodic jobs', () => {
      expect(periodicJobs.length).toBeGreaterThan(0);
    });

    for (const jobName of periodicJobs) {
      it(`should schedule "${jobName}" via upsertJobScheduler`, () => {
        // The worker source must contain a upsertJobScheduler call that
        // references this job name
        expect(workerSource).toContain(`name: '${jobName}'`);
      });
    }
  });

  describe('Every upsertJobScheduler references a valid handler', () => {
    // Extract all scheduled job names from worker source
    const scheduledNames: string[] = [];
    const nameMatches = workerSource.matchAll(/name:\s*'([^']+)'/g);
    for (const m of nameMatches) {
      scheduledNames.push(m[1]);
    }

    // Collect all handler jobNames
    const allHandlerNames = new Set<string>();
    const moduleIds = ['github', 'registry', 'chain', 'infra', 'aws'];
    for (const mod of moduleIds) {
      const handlers = readModuleHandlers(mod);
      const matches = handlers.matchAll(/jobName:\s*'([^']+)'/g);
      for (const m of matches) {
        allHandlerNames.add(m[1]);
      }
    }
    const coreFiles = [
      'event-processing', 'alert-dispatch', 'data-retention',
      'correlation-evaluate', 'correlation-expiry',
      'poll-sweep', 'session-cleanup', 'key-rotation',
    ];
    for (const file of coreFiles) {
      try {
        const source = readFileSync(
          resolve(__dirname, `../../apps/worker/src/handlers/${file}.ts`),
          'utf-8',
        );
        const matches = source.matchAll(/jobName:\s*'([^']+)'/g);
        for (const m of matches) {
          allHandlerNames.add(m[1]);
        }
      } catch { /* */ }
    }

    for (const scheduled of scheduledNames) {
      it(`scheduled job "${scheduled}" has a matching handler`, () => {
        expect(allHandlerNames.has(scheduled)).toBe(true);
      });
    }
  });

  describe('No module with scan/poll handlers is missing from module list', () => {
    it('should include all 5 modules in the worker modules array', () => {
      expect(workerSource).toContain('GitHubModule');
      expect(workerSource).toContain('RegistryModule');
      expect(workerSource).toContain('ChainModule');
      expect(workerSource).toContain('InfraModule');
      expect(workerSource).toContain('AwsModule');
    });
  });
});
