/**
 * Detection Engine E2E Tests
 *
 * Integration tests that exercise the rule engine against a real Postgres DB
 * and Redis instance. Each scenario sets up DB state directly and evaluates
 * events through the RuleEngine, verifying alert candidates, cooldowns,
 * suppress actions, and detection enable/disable behavior.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTestDb,
  getTestRedis,
  getTestSql,
  cleanTables,
  resetCounters,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestDetection,
  createTestRule,
  createTestEvent,
  schema,
} from '../../test/helpers/setup.js';

import { RuleEngine } from '@sentinel/shared/rule-engine';
import { evaluateConditions, getField, compare } from '@sentinel/shared/conditions';
import type { NormalizedEvent, RuleEvaluator, AlertCandidate, EvalContext } from '@sentinel/shared/rules';
import { repoVisibilityEvaluator } from '../../modules/github/src/evaluators/repo-visibility.js';
import { branchProtectionEvaluator } from '../../modules/github/src/evaluators/branch-protection.js';
import { forcePushEvaluator } from '../../modules/github/src/evaluators/force-push.js';
import { secretScanningEvaluator } from '../../modules/github/src/evaluators/secret-scanning.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the evaluator registry from a list of evaluators. */
function buildRegistry(...evaluators: RuleEvaluator[]): Map<string, RuleEvaluator> {
  const map = new Map<string, RuleEvaluator>();
  for (const ev of evaluators) {
    map.set(`${ev.moduleId}:${ev.ruleType}`, ev);
  }
  return map;
}

/** Create a NormalizedEvent from DB event row + payload. */
function toNormalizedEvent(row: {
  id: string;
  orgId: string;
  moduleId: string;
  eventType: string;
}, payload: Record<string, unknown>): NormalizedEvent {
  return {
    id: row.id,
    orgId: row.orgId,
    moduleId: row.moduleId,
    eventType: row.eventType,
    externalId: null,
    payload,
    occurredAt: new Date(),
    receivedAt: new Date(),
  };
}

/** Insert a detection with cooldownMinutes via raw SQL (the helper does not support it). */
async function createDetectionWithCooldown(
  orgId: string,
  userId: string,
  cooldownMinutes: number,
  overrides: Partial<{
    moduleId: string;
    name: string;
    severity: string;
    status: string;
    config: Record<string, unknown>;
  }> = {},
): Promise<{ id: string; orgId: string; moduleId: string; name: string; severity: string; status: string }> {
  const sql = getTestSql();
  const moduleId = overrides.moduleId ?? 'github';
  const name = overrides.name ?? `Detection ${Date.now()}`;
  const severity = overrides.severity ?? 'high';
  const status = overrides.status ?? 'active';
  const config = overrides.config ?? {};

  const [row] = await sql`
    INSERT INTO detections (org_id, created_by, module_id, name, severity, status, cooldown_minutes, config)
    VALUES (${orgId}, ${userId}, ${moduleId}, ${name}, ${severity}, ${status}, ${cooldownMinutes}, ${JSON.stringify(config)}::jsonb)
    RETURNING id, org_id, module_id, name, severity, status
  `;

  return {
    id: row.id,
    orgId: row.org_id,
    moduleId: row.module_id,
    name: row.name,
    severity: row.severity,
    status: row.status,
  };
}

// ---------------------------------------------------------------------------
// Shared state — initialized in beforeEach
// ---------------------------------------------------------------------------

let db: ReturnType<typeof getTestDb>;
let redis: ReturnType<typeof getTestRedis>;
let sql: ReturnType<typeof getTestSql>;
let user: Awaited<ReturnType<typeof createTestUser>>;
let org: Awaited<ReturnType<typeof createTestOrg>>;

beforeEach(async () => {
  await cleanTables();
  resetCounters();
  db = getTestDb();
  redis = getTestRedis();
  sql = getTestSql();

  user = await createTestUser({ username: 'engine-tester' });
  org = await createTestOrg({ name: 'Engine Org', slug: 'engine-org' });
  await addMembership(org.id, user.id, 'admin');
});

// ==========================================================================
// 1. Cooldown Granularity
// ==========================================================================

describe('Cooldown Granularity', () => {
  it('should allow rule in separate detection to fire while another detection is in cooldown', async () => {
    const evaluators = buildRegistry(repoVisibilityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    // Detection 1 — 5-minute cooldown
    const det1 = await createDetectionWithCooldown(org.id, user.id, 5, {
      moduleId: 'github',
      name: 'Det1 with cooldown',
    });
    await createTestRule(det1.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'alert',
    });

    // Detection 2 — no cooldown
    const det2 = await createDetectionWithCooldown(org.id, user.id, 0, {
      moduleId: 'github',
      name: 'Det2 no cooldown',
    });
    await createTestRule(det2.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'alert',
    });

    // Create event
    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'test-org/my-repo', visibility: 'public' },
        sender: { login: 'admin-user' },
      },
    });

    const normalizedEvent = toNormalizedEvent(evt, {
      action: 'publicized',
      repository: { full_name: 'test-org/my-repo', visibility: 'public' },
      sender: { login: 'admin-user' },
    });

    // First evaluation — both detections should fire
    const result1 = await engine.evaluate(normalizedEvent);
    expect(result1.candidates.length).toBe(2);

    const det1Candidates = result1.candidates.filter(c => c.detectionId === det1.id);
    const det2Candidates = result1.candidates.filter(c => c.detectionId === det2.id);
    expect(det1Candidates.length).toBe(1);
    expect(det2Candidates.length).toBe(1);

    // Second evaluation immediately — det1 should be in cooldown, det2 should fire
    const result2 = await engine.evaluate(normalizedEvent);
    const det1CandidatesAfter = result2.candidates.filter(c => c.detectionId === det1.id);
    const det2CandidatesAfter = result2.candidates.filter(c => c.detectionId === det2.id);

    expect(det1CandidatesAfter.length).toBe(0); // blocked by cooldown
    expect(det2CandidatesAfter.length).toBe(1); // no cooldown, fires again
  });

  it('should allow detection to fire again after cooldown expires', async () => {
    const evaluators = buildRegistry(repoVisibilityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    // Detection with very short cooldown (1 minute) — we will manipulate Redis to simulate expiry
    const det = await createDetectionWithCooldown(org.id, user.id, 1, {
      moduleId: 'github',
      name: 'Short cooldown det',
    });
    const rule = await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'alert',
    });

    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'test-org/cooldown-repo', visibility: 'public' },
        sender: { login: 'admin-user' },
      },
    });

    const normalizedEvent = toNormalizedEvent(evt, {
      action: 'publicized',
      repository: { full_name: 'test-org/cooldown-repo', visibility: 'public' },
      sender: { login: 'admin-user' },
    });

    // First evaluation — should fire
    const result1 = await engine.evaluate(normalizedEvent);
    expect(result1.candidates.length).toBe(1);

    // Second evaluation — should be blocked by cooldown
    const result2 = await engine.evaluate(normalizedEvent);
    expect(result2.candidates.length).toBe(0);

    // Simulate cooldown expiry by deleting the Redis key
    const cooldownKey = `sentinel:cooldown:${det.id}:${rule.id}`;
    await redis.del(cooldownKey);

    // Third evaluation — should fire again now that cooldown has expired
    const result3 = await engine.evaluate(normalizedEvent);
    expect(result3.candidates.length).toBe(1);
  });
});

// ==========================================================================
// 2. Null/Empty/Missing Field Semantics
// ==========================================================================

describe('Null/Empty/Missing Field Semantics', () => {
  it('field == "" should match empty string but not null or missing', () => {
    const conditions = [{ field: 'name', operator: '==' as const, value: '' }];

    // Empty string matches
    expect(evaluateConditions({ name: '' }, conditions)).toBe(true);

    // null — getField returns null (not undefined), compare('', '==', null) behavior
    // null is a defined value, getField returns it (not undefined), then compare(null, '==', '') runs
    expect(evaluateConditions({ name: null }, conditions)).toBe(false);

    // Missing field — getField returns undefined, evaluateConditions short-circuits to false
    expect(evaluateConditions({}, conditions)).toBe(false);
  });

  it('field != "" should NOT match missing fields (missing returns false)', () => {
    const conditions = [{ field: 'tag', operator: '!=' as const, value: '' }];

    // Present non-empty string matches
    expect(evaluateConditions({ tag: 'latest' }, conditions)).toBe(true);

    // Missing field — undefined from getField means condition fails
    expect(evaluateConditions({}, conditions)).toBe(false);
  });

  it('numeric comparisons on null/missing should not match', () => {
    const gtCondition = [{ field: 'count', operator: '>' as const, value: 5 }];

    // Valid number
    expect(evaluateConditions({ count: 10 }, gtCondition)).toBe(true);
    expect(evaluateConditions({ count: 3 }, gtCondition)).toBe(false);

    // null field value — compare(null, '>', 5) should not match
    expect(evaluateConditions({ count: null }, gtCondition)).toBe(false);

    // Missing field — getField returns undefined, short-circuits to false
    expect(evaluateConditions({}, gtCondition)).toBe(false);
  });

  it('field == value should match when field exists with matching value', () => {
    const conditions = [{ field: 'status', operator: '==' as const, value: 'active' }];

    expect(evaluateConditions({ status: 'active' }, conditions)).toBe(true);
    expect(evaluateConditions({ status: 'inactive' }, conditions)).toBe(false);
  });

  it('nested field access should handle null intermediate objects', () => {
    const conditions = [{ field: 'repo.owner.login', operator: '==' as const, value: 'admin' }];

    // Full path present
    expect(evaluateConditions({ repo: { owner: { login: 'admin' } } }, conditions)).toBe(true);

    // Intermediate null
    expect(evaluateConditions({ repo: { owner: null } }, conditions)).toBe(false);

    // Missing intermediate
    expect(evaluateConditions({ repo: {} }, conditions)).toBe(false);

    // Top-level missing
    expect(evaluateConditions({}, conditions)).toBe(false);
  });

  it('empty conditions array should always return true', () => {
    expect(evaluateConditions({ anything: 'here' }, [])).toBe(true);
    expect(evaluateConditions({}, [])).toBe(true);
  });

  it('getField returns undefined for missing keys and null for explicit nulls', () => {
    expect(getField({ a: null }, 'a')).toBe(null);
    expect(getField({}, 'a')).toBe(undefined);
    expect(getField({ a: { b: undefined } }, 'a.b')).toBe(undefined);
  });
});

// ==========================================================================
// 3. Detection Enable/Disable
// ==========================================================================

describe('Detection Enable/Disable', () => {
  it('should not produce candidates for a paused detection', async () => {
    const evaluators = buildRegistry(repoVisibilityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    // Active detection — should produce candidates
    const activeDet = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Active detection',
      status: 'active',
    });
    await createTestRule(activeDet.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'alert',
    });

    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'test-org/active-repo', visibility: 'public' },
        sender: { login: 'admin-user' },
      },
    });

    const normalizedEvent = toNormalizedEvent(evt, {
      action: 'publicized',
      repository: { full_name: 'test-org/active-repo', visibility: 'public' },
      sender: { login: 'admin-user' },
    });

    // Should fire for active detection
    const result1 = await engine.evaluate(normalizedEvent);
    expect(result1.candidates.length).toBe(1);
    expect(result1.candidates[0].detectionId).toBe(activeDet.id);

    // Now pause the detection
    await sql`UPDATE detections SET status = 'paused' WHERE id = ${activeDet.id}`;

    // Should NOT fire for paused detection
    const result2 = await engine.evaluate(normalizedEvent);
    expect(result2.candidates.length).toBe(0);
  });

  it('should resume producing candidates when detection is re-enabled', async () => {
    const evaluators = buildRegistry(repoVisibilityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    // Start with a disabled detection
    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Toggle detection',
      status: 'disabled',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'alert',
    });

    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'test-org/toggle-repo', visibility: 'public' },
        sender: { login: 'admin-user' },
      },
    });

    const normalizedEvent = toNormalizedEvent(evt, {
      action: 'publicized',
      repository: { full_name: 'test-org/toggle-repo', visibility: 'public' },
      sender: { login: 'admin-user' },
    });

    // Disabled — no candidates
    const result1 = await engine.evaluate(normalizedEvent);
    expect(result1.candidates.length).toBe(0);

    // Re-enable
    await sql`UPDATE detections SET status = 'active' WHERE id = ${det.id}`;

    // Should fire now
    const result2 = await engine.evaluate(normalizedEvent);
    expect(result2.candidates.length).toBe(1);
    expect(result2.candidates[0].detectionId).toBe(det.id);
  });

  it('should not produce candidates for detections with status error', async () => {
    const evaluators = buildRegistry(repoVisibilityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Error detection',
      status: 'error',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'alert',
    });

    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'test-org/err-repo', visibility: 'public' },
        sender: { login: 'admin-user' },
      },
    });

    const normalizedEvent = toNormalizedEvent(evt, {
      action: 'publicized',
      repository: { full_name: 'test-org/err-repo', visibility: 'public' },
      sender: { login: 'admin-user' },
    });

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});

// ==========================================================================
// 4. Multi-Rule Detection — Partial Match
// ==========================================================================

describe('Multi-Rule Detection — Partial Match', () => {
  it('should produce candidates only for matching rules, not non-matching ones', async () => {
    const evaluators = buildRegistry(
      repoVisibilityEvaluator,
      branchProtectionEvaluator,
      forcePushEvaluator,
    );
    const engine = new RuleEngine({ evaluators, redis, db });

    // Single detection with 3 rules
    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Multi-rule detection',
    });

    // Rule 1: repo visibility — will NOT match (event is branch_protection)
    const r1 = await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'alert',
      priority: 10,
    });

    // Rule 2: branch protection deleted — WILL match
    const r2 = await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted'], watchBranches: [] },
      action: 'alert',
      priority: 20,
    });

    // Rule 3: force push — will NOT match (event is branch_protection, not push)
    const r3 = await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.force_push',
      config: { watchBranches: ['main'], alertOnAllForced: false },
      action: 'alert',
      priority: 30,
    });

    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.branch_protection.deleted',
      payload: {
        action: 'deleted',
        rule: { name: 'main', pattern: 'main' },
        repository: { full_name: 'test-org/core-api' },
        sender: { login: 'rogue-dev' },
      },
    });

    const normalizedEvent = toNormalizedEvent(evt, {
      action: 'deleted',
      rule: { name: 'main', pattern: 'main' },
      repository: { full_name: 'test-org/core-api' },
      sender: { login: 'rogue-dev' },
    });

    const result = await engine.evaluate(normalizedEvent);

    // Only rule 2 (branch protection) should match
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].ruleId).toBe(r2.id);
    expect(result.candidates[0].detectionId).toBe(det.id);
    expect(result.candidates[0].title).toContain('Branch protection');
  });

  it('should produce candidates for multiple matching rules in the same detection', async () => {
    const evaluators = buildRegistry(branchProtectionEvaluator, secretScanningEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Two-match detection',
    });

    // Rule 1: branch protection — watches deleted and edited
    const r1 = await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted', 'edited'], watchBranches: [] },
      action: 'alert',
      priority: 10,
    });

    // Rule 2: secret scanning — will NOT match (wrong event type)
    const r2 = await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'], secretTypes: [] },
      action: 'alert',
      priority: 20,
    });

    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.branch_protection.deleted',
      payload: {
        action: 'deleted',
        rule: { name: 'main', pattern: 'main' },
        repository: { full_name: 'test-org/core-api' },
        sender: { login: 'admin-user' },
      },
    });

    const normalizedEvent = toNormalizedEvent(evt, {
      action: 'deleted',
      rule: { name: 'main', pattern: 'main' },
      repository: { full_name: 'test-org/core-api' },
      sender: { login: 'admin-user' },
    });

    const result = await engine.evaluate(normalizedEvent);

    // Only rule 1 should match
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].ruleId).toBe(r1.id);
    // Rule 2 should not have produced a candidate (wrong event type)
    expect(result.candidates.find(c => c.ruleId === r2.id)).toBeUndefined();
  });

  it('should evaluate all rules independently — one failing does not block others', async () => {
    const evaluators = buildRegistry(repoVisibilityEvaluator, branchProtectionEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    // Two detections, each with one rule, same module
    const det1 = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Det repo vis',
    });
    const r1 = await createTestRule(det1.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'alert',
    });

    const det2 = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Det branch prot',
    });
    const r2 = await createTestRule(det2.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted'], watchBranches: [] },
      action: 'alert',
    });

    // Send a repo visibility event — only det1/r1 should match
    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'test-org/my-repo', visibility: 'public' },
        sender: { login: 'admin-user' },
      },
    });

    const normalizedEvent = toNormalizedEvent(evt, {
      action: 'publicized',
      repository: { full_name: 'test-org/my-repo', visibility: 'public' },
      sender: { login: 'admin-user' },
    });

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].ruleId).toBe(r1.id);
    expect(result.candidates[0].detectionId).toBe(det1.id);
  });
});

// ==========================================================================
// 5. Suppress Action
// ==========================================================================

describe('Suppress Action', () => {
  it('should not produce alert candidates when suppress rule matches', async () => {
    const evaluators = buildRegistry(repoVisibilityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Suppress detection',
    });

    // Suppress rule (higher priority = evaluated first since priority is asc)
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'suppress',
      priority: 1, // lower number = evaluated first
    });

    // Alert rule — should never fire because suppress runs first
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'alert',
      priority: 100,
    });

    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'test-org/suppress-repo', visibility: 'public' },
        sender: { login: 'admin-user' },
      },
    });

    const normalizedEvent = toNormalizedEvent(evt, {
      action: 'publicized',
      repository: { full_name: 'test-org/suppress-repo', visibility: 'public' },
      sender: { login: 'admin-user' },
    });

    const result = await engine.evaluate(normalizedEvent);

    // Suppressed — no alert candidates
    expect(result.candidates.length).toBe(0);
    expect(result.suppressed).toBe(true);
  });

  it('suppress should stop evaluation of subsequent rules across all detections', async () => {
    const evaluators = buildRegistry(repoVisibilityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    // Detection 1 — suppress rule (low priority number = evaluated first)
    const det1 = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Suppress det',
    });
    await createTestRule(det1.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'suppress',
      priority: 1,
    });

    // Detection 2 — alert rule (higher priority number = evaluated after)
    const det2 = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Alert det',
    });
    await createTestRule(det2.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'alert',
      priority: 50,
    });

    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'test-org/suppress-all', visibility: 'public' },
        sender: { login: 'admin-user' },
      },
    });

    const normalizedEvent = toNormalizedEvent(evt, {
      action: 'publicized',
      repository: { full_name: 'test-org/suppress-all', visibility: 'public' },
      sender: { login: 'admin-user' },
    });

    const result = await engine.evaluate(normalizedEvent);

    // Suppress stops everything — det2's alert rule should never run
    expect(result.candidates.length).toBe(0);
    expect(result.suppressed).toBe(true);
  });

  it('alert rule should fire when suppress rule does not match the event', async () => {
    const evaluators = buildRegistry(repoVisibilityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Mixed actions det',
    });

    // Suppress rule for privatized events
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'privatized' },
      action: 'suppress',
      priority: 1,
    });

    // Alert rule for publicized events
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
      action: 'alert',
      priority: 50,
    });

    // Send a publicized event — suppress rule should NOT match (it watches privatized)
    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'test-org/open-repo', visibility: 'public' },
        sender: { login: 'admin-user' },
      },
    });

    const normalizedEvent = toNormalizedEvent(evt, {
      action: 'publicized',
      repository: { full_name: 'test-org/open-repo', visibility: 'public' },
      sender: { login: 'admin-user' },
    });

    const result = await engine.evaluate(normalizedEvent);

    // Suppress did not match, alert should fire
    expect(result.suppressed).toBe(false);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].title).toContain('public');
  });
});
