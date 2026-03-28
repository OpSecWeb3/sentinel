/**
 * GitHub Module E2E Tests
 *
 * Integration tests that exercise GitHub evaluators against a real Postgres DB
 * and Redis instance via the RuleEngine. Covers repo visibility exclusions,
 * deploy key write-vs-read filtering, branch protection glob matching,
 * member change role filtering, and multi-rule detection isolation.
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
import type { NormalizedEvent, RuleEvaluator } from '@sentinel/shared/rules';
import { repoVisibilityEvaluator } from '../../modules/github/src/evaluators/repo-visibility.js';
import { branchProtectionEvaluator } from '../../modules/github/src/evaluators/branch-protection.js';
import { memberChangeEvaluator } from '../../modules/github/src/evaluators/member-change.js';
import { deployKeyEvaluator } from '../../modules/github/src/evaluators/deploy-key.js';
import { secretScanningEvaluator } from '../../modules/github/src/evaluators/secret-scanning.js';
import { forcePushEvaluator } from '../../modules/github/src/evaluators/force-push.js';
import { orgSettingsEvaluator } from '../../modules/github/src/evaluators/org-settings.js';

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

/** Create a NormalizedEvent from a DB event row + payload. */
function toNormalizedEvent(
  row: { id: string; orgId: string; moduleId: string; eventType: string },
  payload: Record<string, unknown>,
): NormalizedEvent {
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

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let db: ReturnType<typeof getTestDb>;
let redis: ReturnType<typeof getTestRedis>;
let user: Awaited<ReturnType<typeof createTestUser>>;
let org: Awaited<ReturnType<typeof createTestOrg>>;

beforeEach(async () => {
  await cleanTables();
  resetCounters();
  db = getTestDb();
  redis = getTestRedis();

  user = await createTestUser({ username: 'gh-module-tester' });
  org = await createTestOrg({ name: 'GitHub Module Org', slug: 'gh-module-org' });
  await addMembership(org.id, user.id, 'admin');
});

// ==========================================================================
// 1. Repo Visibility - Excluded Repo Glob
// ==========================================================================

describe('Repo Visibility - Excluded Repo Glob', () => {
  it('should NOT alert when the repository matches an excludeRepos glob pattern', async () => {
    const evaluators = buildRegistry(repoVisibilityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Repo Visibility with Exclusions',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized', excludeRepos: ['org/internal-*'] },
      action: 'alert',
    });

    // Event for an excluded repo
    const payload = {
      action: 'publicized',
      repository: { full_name: 'org/internal-project', visibility: 'public', owner: { login: 'org' } },
      sender: { login: 'admin-user' },
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repository.visibility_changed',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });

  it('should alert when the repository does NOT match an excludeRepos glob pattern', async () => {
    const evaluators = buildRegistry(repoVisibilityEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Repo Visibility with Exclusions',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized', excludeRepos: ['org/internal-*'] },
      action: 'alert',
    });

    // Event for a non-excluded repo
    const payload = {
      action: 'publicized',
      repository: { full_name: 'org/prod-app', visibility: 'public', owner: { login: 'org' } },
      sender: { login: 'admin-user' },
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repository.visibility_changed',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
    expect(result.candidates[0].severity).toBe('critical');
  });
});

// ==========================================================================
// 2. Deploy Key - Write vs Read-Only
// ==========================================================================

describe('Deploy Key - Write vs Read-Only', () => {
  it('should NOT alert on a read-only deploy key when alertOnWriteKeys is true', async () => {
    const evaluators = buildRegistry(deployKeyEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Deploy Key Monitor (Write Only)',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: true },
      action: 'alert',
    });

    const payload = {
      action: 'created',
      key: { id: 12345, title: 'CI read key', read_only: true },
      repository: { full_name: 'org/my-repo' },
      sender: { login: 'deploy-bot' },
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.deploy_key.created',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });

  it('should alert on a write-access deploy key when alertOnWriteKeys is true', async () => {
    const evaluators = buildRegistry(deployKeyEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Deploy Key Monitor (Write Only)',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: true },
      action: 'alert',
    });

    const payload = {
      action: 'created',
      key: { id: 67890, title: 'CI deploy key', read_only: false },
      repository: { full_name: 'org/my-repo' },
      sender: { login: 'deploy-bot' },
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.deploy_key.created',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });
});

// ==========================================================================
// 3. Branch Protection - Glob Pattern Matching
// ==========================================================================

describe('Branch Protection - Glob Pattern Matching', () => {
  it('should alert when a watched branch (exact match) has protection deleted', async () => {
    const evaluators = buildRegistry(branchProtectionEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Branch Protection Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted', 'edited'], watchBranches: ['main', 'release/*'] },
      action: 'alert',
    });

    const payload = {
      action: 'deleted',
      rule: { name: 'main' },
      repository: { full_name: 'org/core-app' },
      sender: { login: 'rogue-admin' },
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.branch_protection.deleted',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert when an unwatched branch has protection deleted', async () => {
    const evaluators = buildRegistry(branchProtectionEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Branch Protection Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted', 'edited'], watchBranches: ['main', 'release/*'] },
      action: 'alert',
    });

    const payload = {
      action: 'deleted',
      rule: { name: 'feature/xyz' },
      repository: { full_name: 'org/core-app' },
      sender: { login: 'dev-user' },
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.branch_protection.deleted',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });

  it('should alert when a branch matches a glob pattern (release/*)', async () => {
    const evaluators = buildRegistry(branchProtectionEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Branch Protection Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted', 'edited'], watchBranches: ['main', 'release/*'] },
      action: 'alert',
    });

    const payload = {
      action: 'deleted',
      rule: { name: 'release/v2.0' },
      repository: { full_name: 'org/core-app' },
      sender: { login: 'release-mgr' },
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.branch_protection.deleted',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });
});

// ==========================================================================
// 4. Member Change - Role Filtering
// ==========================================================================

describe('Member Change - Role Filtering', () => {
  it('should alert when member added with a watched role (admin)', async () => {
    const evaluators = buildRegistry(memberChangeEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Member Change Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.member_change',
      config: { alertOnActions: ['member_added'], watchRoles: ['admin'] },
      action: 'alert',
    });

    const payload = {
      action: 'member_added',
      organization: { login: 'org' },
      membership: { user: { login: 'new-admin' }, role: 'admin' },
      sender: { login: 'cto' },
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.organization.member_added',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert when member added with a non-watched role (member)', async () => {
    const evaluators = buildRegistry(memberChangeEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Member Change Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.member_change',
      config: { alertOnActions: ['member_added'], watchRoles: ['admin'] },
      action: 'alert',
    });

    const payload = {
      action: 'member_added',
      organization: { login: 'org' },
      membership: { user: { login: 'regular-dev' }, role: 'member' },
      sender: { login: 'tech-lead' },
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.organization.member_added',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});

// ==========================================================================
// 5. Full Security Suite - Multi-Rule Isolation
// ==========================================================================

describe('Full Security Suite - Multi-Rule Isolation', () => {
  it('should fire ONLY the repo_visibility rule on a publicized event', async () => {
    const evaluators = buildRegistry(
      repoVisibilityEvaluator,
      branchProtectionEvaluator,
      memberChangeEvaluator,
      deployKeyEvaluator,
      secretScanningEvaluator,
      forcePushEvaluator,
      orgSettingsEvaluator,
    );
    const engine = new RuleEngine({ evaluators, redis, db });

    // Create a detection mimicking the full-security template
    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Full GitHub Security Suite',
      severity: 'critical',
    });

    // Add all rule types from the full-security template
    const visRule = await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized', excludeRepos: [] },
      action: 'alert',
      priority: 10,
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'], secretTypes: [] },
      action: 'alert',
      priority: 10,
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.force_push',
      config: { watchBranches: ['main', 'master', 'release/*', 'production'], alertOnAllForced: false },
      action: 'alert',
      priority: 20,
    });
    const bpRule = await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['edited', 'deleted'], watchBranches: [] },
      action: 'alert',
      priority: 30,
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: true },
      action: 'alert',
      priority: 30,
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.member_change',
      config: { alertOnActions: ['member_added', 'member_removed'], watchRoles: [] },
      action: 'alert',
      priority: 40,
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.org_settings',
      config: { watchActions: [] },
      action: 'alert',
      priority: 50,
    });

    // Send a publicized event -- only repo_visibility should fire
    const visPayload = {
      action: 'publicized',
      repository: { full_name: 'org/secret-repo', visibility: 'public', owner: { login: 'org' } },
      sender: { login: 'careless-admin' },
    };
    const visEvt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.repository.visibility_changed',
      payload: visPayload,
    });
    const visNormalized = toNormalizedEvent(visEvt, visPayload);

    const visResult = await engine.evaluate(visNormalized);
    expect(visResult.candidates.length).toBe(1);
    expect(visResult.candidates[0].ruleId).toBe(visRule.id);
    expect(visResult.candidates[0].detectionId).toBe(det.id);
  });

  it('should fire ONLY the branch_protection rule on a branch_protection.deleted event', async () => {
    const evaluators = buildRegistry(
      repoVisibilityEvaluator,
      branchProtectionEvaluator,
      memberChangeEvaluator,
      deployKeyEvaluator,
      secretScanningEvaluator,
      forcePushEvaluator,
      orgSettingsEvaluator,
    );
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'github',
      name: 'Full GitHub Security Suite',
      severity: 'critical',
    });

    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized', excludeRepos: [] },
      action: 'alert',
      priority: 10,
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'], secretTypes: [] },
      action: 'alert',
      priority: 10,
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.force_push',
      config: { watchBranches: ['main', 'master', 'release/*', 'production'], alertOnAllForced: false },
      action: 'alert',
      priority: 20,
    });
    const bpRule = await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['edited', 'deleted'], watchBranches: [] },
      action: 'alert',
      priority: 30,
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: true },
      action: 'alert',
      priority: 30,
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.member_change',
      config: { alertOnActions: ['member_added', 'member_removed'], watchRoles: [] },
      action: 'alert',
      priority: 40,
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'github',
      ruleType: 'github.org_settings',
      config: { watchActions: [] },
      action: 'alert',
      priority: 50,
    });

    // Send a branch_protection.deleted event -- only branch_protection should fire
    const bpPayload = {
      action: 'deleted',
      rule: { name: 'main' },
      repository: { full_name: 'org/core-app' },
      changes: {},
      sender: { login: 'attacker' },
    };
    const bpEvt = await createTestEvent(org.id, {
      moduleId: 'github',
      eventType: 'github.branch_protection.deleted',
      payload: bpPayload,
    });
    const bpNormalized = toNormalizedEvent(bpEvt, bpPayload);

    const bpResult = await engine.evaluate(bpNormalized);
    expect(bpResult.candidates.length).toBe(1);
    expect(bpResult.candidates[0].ruleId).toBe(bpRule.id);
    expect(bpResult.candidates[0].detectionId).toBe(det.id);
  });
});
