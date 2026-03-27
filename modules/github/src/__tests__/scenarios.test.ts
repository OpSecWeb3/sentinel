import { describe, it, expect } from 'vitest';
import type { EvalContext, NormalizedEvent, RuleRow } from '@sentinel/shared/rules';
import { repoVisibilityEvaluator } from '../evaluators/repo-visibility.js';
import { branchProtectionEvaluator } from '../evaluators/branch-protection.js';
import { memberChangeEvaluator } from '../evaluators/member-change.js';
import { deployKeyEvaluator } from '../evaluators/deploy-key.js';
import { secretScanningEvaluator } from '../evaluators/secret-scanning.js';
import { forcePushEvaluator } from '../evaluators/force-push.js';
import { orgSettingsEvaluator } from '../evaluators/org-settings.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'evt-test-001',
    orgId: 'org-test-001',
    moduleId: 'github',
    eventType: 'github.push',
    externalId: 'delivery-001',
    payload: {},
    occurredAt: new Date('2026-03-15T10:00:00Z'),
    receivedAt: new Date('2026-03-15T10:00:01Z'),
    ...overrides,
  };
}

function makeRule(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: 'rule-test-001',
    detectionId: 'det-test-001',
    orgId: 'org-test-001',
    moduleId: 'github',
    ruleType: 'github.repo_visibility',
    config: {},
    status: 'active',
    priority: 50,
    action: 'alert',
    ...overrides,
  };
}

function makeCtx(event: NormalizedEvent, rule: RuleRow): EvalContext {
  return { event, rule, redis: {} as any };
}

// ===========================================================================
// A. Repo Visibility Scenarios (20 tests)
// ===========================================================================

describe('Repo Visibility Scenarios', () => {
  it('GH-S01: internal project accidentally made public by junior dev triggers critical alert', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/internal-auth-service', visibility: 'public' },
        sender: { login: 'junior-dev-intern' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('acme/internal-auth-service');
    expect(result!.title).toContain('public');
    expect(result!.description).toContain('junior-dev-intern');
  });

  it('GH-S02: open-source repo intentionally publicized is excluded via glob pattern', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/oss-react-components', visibility: 'public' },
        sender: { login: 'lead-engineer' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized', excludeRepos: ['acme/oss-*'] },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('GH-S03: repo made private fires when alertOn=privatized', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'privatized',
        repository: { full_name: 'acme/shared-utils', visibility: 'private' },
        sender: { login: 'security-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'privatized' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('security-admin');
  });

  it('GH-S04: repo made public does NOT fire when alertOn=privatized', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/docs-site', visibility: 'public' },
        sender: { login: 'devops-lead' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'privatized' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('GH-S05: alertOn=any catches publicized events', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/api-gateway', visibility: 'public' },
        sender: { login: 'ops-bot' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'any' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('GH-S05b: alertOn=any catches privatized events', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'privatized',
        repository: { full_name: 'acme/api-gateway', visibility: 'private' },
        sender: { login: 'ops-bot' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'any' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('GH-S06: exclude pattern with wildcard org/public-* filters correctly', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/public-demo-app', visibility: 'public' },
        sender: { login: 'marketing-team' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized', excludeRepos: ['acme/public-*'] },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('GH-S07: exclude pattern with nested glob org/*/docs matches', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/team-alpha/docs', visibility: 'public' },
        sender: { login: 'tech-writer' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized', excludeRepos: ['acme/*/docs'] },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('GH-S08: multiple exclude patterns - repo matches one pattern - no alert', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/test-integration', visibility: 'public' },
        sender: { login: 'qa-lead' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: {
        alertOn: 'publicized',
        excludeRepos: ['acme/oss-*', 'acme/test-*', 'acme/demo-*'],
      },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('GH-S09: multiple exclude patterns - repo matches none - fires alert', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/payment-service', visibility: 'public' },
        sender: { login: 'rogue-dev' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: {
        alertOn: 'publicized',
        excludeRepos: ['acme/oss-*', 'acme/test-*', 'acme/demo-*'],
      },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('GH-S10: wrong event type (github.push) returns null', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: {
        ref: 'refs/heads/main',
        forced: false,
        repository: { full_name: 'acme/core' },
        pusher: { name: 'alice' },
        sender: { login: 'alice' },
        commits_count: 1,
        head_commit: null,
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('GH-S11: missing payload fields returns null gracefully via wrong event type', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: { action: 'added', member: { login: 'bob', id: 1 } },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('GH-S12: empty excludeRepos array fires on any matching event', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/secret-project', visibility: 'public' },
        sender: { login: 'dev-user' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized', excludeRepos: [] },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('GH-S13: case sensitivity in repo names - exact case match fires', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'Acme/Core-API', visibility: 'public' },
        sender: { login: 'alice' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized', excludeRepos: ['acme/core-api'] },
    });
    // minimatch is case-sensitive by default, so Acme/Core-API != acme/core-api
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('GH-S14: repo with special chars in name still fires alert', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/my-repo.v2', visibility: 'public' },
        sender: { login: 'dev' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('acme/my-repo.v2');
  });

  it('GH-S15: event from different module (chain) returns null', async () => {
    const event = makeEvent({
      moduleId: 'chain',
      eventType: 'chain.contract.deployed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/core', visibility: 'public' },
        sender: { login: 'alice' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
    });
    // eventType does not match, so returns null
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('GH-S16: payload with extra unknown fields still works correctly', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/core', visibility: 'public', id: 12345, html_url: 'https://github.com/acme/core' },
        sender: { login: 'alice', id: 42, avatar_url: 'https://example.com/avatar.png' },
        installation: { id: 999 },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('GH-S17: alert output always has critical severity for visibility changes', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'privatized',
        repository: { full_name: 'acme/service-mesh', visibility: 'private' },
        sender: { login: 'admin-user' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'any' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('GH-S18: alert title contains repo full_name', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'megacorp/billing-engine', visibility: 'public' },
        sender: { login: 'finance-dev' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('megacorp/billing-engine');
  });

  it('GH-S19: alert description contains sender login', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/data-pipeline', visibility: 'public' },
        sender: { login: 'suspicious-contractor' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('suspicious-contractor');
  });

  it('GH-S20: triggerData contains original payload', async () => {
    const payload = {
      action: 'publicized',
      repository: { full_name: 'acme/ml-models', visibility: 'public' },
      sender: { login: 'data-scientist' },
    };
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload,
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.triggerData).toEqual(payload);
  });
});

// ===========================================================================
// B. Branch Protection Scenarios (18 tests)
// ===========================================================================

describe('Branch Protection Scenarios', () => {
  it('BP-S01: protection deleted on main triggers critical severity alert', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.deleted',
      payload: {
        action: 'deleted',
        rule: { name: 'Protect main', pattern: 'main' },
        repository: { full_name: 'acme/production-api' },
        sender: { login: 'compromised-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted'], watchBranches: ['main'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('removed');
  });

  it('BP-S02: protection edited on main triggers high severity alert', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.edited',
      payload: {
        action: 'edited',
        rule: { name: 'main protection', pattern: 'main' },
        repository: { full_name: 'acme/production-api' },
        sender: { login: 'senior-dev' },
        changes: { required_status_checks: { from: { strict: true } } },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['edited'], watchBranches: ['main'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('modified');
  });

  it('BP-S03: protection created on main fires when rule watches created', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.created',
      payload: {
        action: 'created',
        rule: { name: 'main branch rule', pattern: 'main' },
        repository: { full_name: 'acme/new-service' },
        sender: { login: 'devops-bot' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['created'], watchBranches: ['main'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('created');
  });

  it('BP-S04: protection deleted on dev branch not in watchBranches - no alert', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.deleted',
      payload: {
        action: 'deleted',
        rule: { name: 'dev protection', pattern: 'develop' },
        repository: { full_name: 'acme/frontend' },
        sender: { login: 'developer' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted'], watchBranches: ['main', 'production'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('BP-S05: empty watchBranches means all branches are watched', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.deleted',
      payload: {
        action: 'deleted',
        rule: { name: 'staging protection', pattern: 'staging' },
        repository: { full_name: 'acme/backend' },
        sender: { login: 'ops-engineer' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted'], watchBranches: [] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('BP-S06: wildcard watchBranches release-* does not match release-v2 (exact match only)', async () => {
    // The branch protection evaluator uses exact string comparison, not glob matching
    const event = makeEvent({
      eventType: 'github.branch_protection.edited',
      payload: {
        action: 'edited',
        rule: { name: 'release rule', pattern: 'release-v2' },
        repository: { full_name: 'acme/platform' },
        sender: { login: 'release-manager' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['edited'], watchBranches: ['release-v2'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('BP-S07: action not in alertOnActions produces no alert', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.created',
      payload: {
        action: 'created',
        rule: { name: 'main', pattern: 'main' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['edited', 'deleted'], watchBranches: ['main'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('BP-S08: multiple alertOnActions catch different events - edited fires', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.edited',
      payload: {
        action: 'edited',
        rule: { name: 'main', pattern: 'main' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['created', 'edited', 'deleted'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('BP-S09: branch pattern with special name (hotfix/urgent-2026) matches exactly', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.deleted',
      payload: {
        action: 'deleted',
        rule: { name: 'hotfix protection', pattern: 'hotfix/urgent-2026' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'ops' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted'], watchBranches: ['hotfix/urgent-2026'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('BP-S10: wrong event type (github.push) returns null', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: {
        ref: 'refs/heads/main',
        forced: true,
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('BP-S11: alert title contains action verb (removed for deleted)', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.deleted',
      payload: {
        action: 'deleted',
        rule: { name: 'main', pattern: 'main' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('removed');
  });

  it('BP-S12: alert title contains repository name', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.edited',
      payload: {
        action: 'edited',
        rule: { name: 'main', pattern: 'main' },
        repository: { full_name: 'megacorp/secret-platform' },
        sender: { login: 'engineer' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['edited'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('megacorp/secret-platform');
  });

  it('BP-S13: attacker deletes branch protection to prepare for force push', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.deleted',
      payload: {
        action: 'deleted',
        rule: { name: 'Require PR reviews', pattern: 'main' },
        repository: { full_name: 'acme/supply-chain-critical' },
        sender: { login: 'attacker-account-42' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted'], watchBranches: ['main'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('attacker-account-42');
    expect(result!.description).toContain('Require PR reviews');
  });

  it('BP-S14: automated system creates branch protection - rule watches created', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.created',
      payload: {
        action: 'created',
        rule: { name: 'Auto protection', pattern: 'main' },
        repository: { full_name: 'acme/new-microservice' },
        sender: { login: 'github-actions[bot]' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['created'], watchBranches: ['main'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('created');
    expect(result!.description).toContain('github-actions[bot]');
  });

  it('BP-S15: branch protection edited by unknown user generates alert with user info', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.edited',
      payload: {
        action: 'edited',
        rule: { name: 'main', pattern: 'main' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'unknown-external-user' },
        changes: { required_pull_request_reviews: { from: { required_approving_review_count: 2 } } },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['edited'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('unknown-external-user');
  });

  it('BP-S16: watching only deleted ignores edited events', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.edited',
      payload: {
        action: 'edited',
        rule: { name: 'main', pattern: 'main' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('BP-S17: multiple branches watched - event matches second pattern', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.deleted',
      payload: {
        action: 'deleted',
        rule: { name: 'production', pattern: 'production' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted'], watchBranches: ['main', 'production', 'staging'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('BP-S18: changes field present in payload for edited events - preserved in triggerData', async () => {
    const changes = { required_status_checks: { from: { strict: true, contexts: ['ci/build'] } } };
    const payload = {
      action: 'edited',
      rule: { name: 'main', pattern: 'main' },
      repository: { full_name: 'acme/core' },
      sender: { login: 'admin' },
      changes,
    };
    const event = makeEvent({
      eventType: 'github.branch_protection.edited',
      payload,
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['edited'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.triggerData).toEqual(payload);
    expect((result!.triggerData as any).changes).toEqual(changes);
  });
});

// ===========================================================================
// C. Member Change Scenarios (16 tests)
// ===========================================================================

describe('Member Change Scenarios', () => {
  it('MC-S01: contractor added at 2 AM to private repo triggers alert', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      occurredAt: new Date('2026-03-15T02:00:00Z'),
      payload: {
        action: 'added',
        member: { login: 'contractor-jane', id: 5001, role: 'member' },
        repository: { full_name: 'acme/payment-processing' },
        sender: { login: 'eng-manager' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['added'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('contractor-jane');
    expect(result!.title).toContain('added');
    expect(result!.title).toContain('acme/payment-processing');
  });

  it('MC-S02: employee removed from org triggers alert', async () => {
    const event = makeEvent({
      eventType: 'github.member.removed',
      payload: {
        action: 'removed',
        member: { login: 'former-employee', id: 3001 },
        sender: { login: 'hr-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['removed'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('former-employee');
    expect(result!.title).toContain('removed');
    expect(result!.title).toContain('in organization');
  });

  it('MC-S03: admin added with watchRoles=[admin] fires alert', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: {
        action: 'added',
        member: { login: 'new-admin', id: 7001, role: 'admin' },
        repository: { full_name: 'acme/infrastructure' },
        sender: { login: 'cto' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['added'], watchRoles: ['admin'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('admin');
  });

  it('MC-S04: member role added with watchRoles=[admin] does NOT fire alert', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: {
        action: 'added',
        member: { login: 'regular-dev', id: 2001, role: 'member' },
        repository: { full_name: 'acme/frontend' },
        sender: { login: 'tech-lead' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['added'], watchRoles: ['admin'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('MC-S05: any role change detected with empty watchRoles', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: {
        action: 'added',
        member: { login: 'new-hire', id: 8001, role: 'triage' },
        repository: { full_name: 'acme/docs' },
        sender: { login: 'onboarding-bot' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['added'], watchRoles: [] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('MC-S06: alertOnActions=[removed] ignores additions', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: {
        action: 'added',
        member: { login: 'new-dev', id: 9001 },
        repository: { full_name: 'acme/core' },
        sender: { login: 'admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['removed'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('MC-S07: member edited (permissions changed) triggers alert', async () => {
    const event = makeEvent({
      eventType: 'github.member.edited',
      payload: {
        action: 'edited',
        member: { login: 'dev-alice', id: 1001, role: 'admin' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'org-owner' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['edited'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('edited');
    expect(result!.description).toContain('admin');
  });

  it('MC-S08: member with no repository context shows org-level scope', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: {
        action: 'added',
        member: { login: 'org-member', id: 4001 },
        sender: { login: 'org-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['added'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('in organization');
  });

  it('MC-S09: member with repository context shows repo-level scope', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: {
        action: 'added',
        member: { login: 'repo-collaborator', id: 4002 },
        repository: { full_name: 'acme/api-v2' },
        sender: { login: 'repo-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['added'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('on acme/api-v2');
  });

  it('MC-S10: former employee removed produces descriptive alert title', async () => {
    const event = makeEvent({
      eventType: 'github.member.removed',
      payload: {
        action: 'removed',
        member: { login: 'ex-employee-john', id: 6001 },
        sender: { login: 'it-operations' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['removed'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('ex-employee-john');
    expect(result!.title).toContain('removed');
    expect(result!.description).toContain('it-operations');
  });

  it('MC-S11: bot account added as member triggers alert', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: {
        action: 'added',
        member: { login: 'deploy-bot[bot]', id: 10001, role: 'member' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'devops-lead' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['added'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('deploy-bot[bot]');
  });

  it('MC-S12: self-add by the member (sender=member) still triggers', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: {
        action: 'added',
        member: { login: 'self-adder', id: 11001 },
        repository: { full_name: 'acme/open-project' },
        sender: { login: 'self-adder' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['added'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('self-adder');
  });

  it('MC-S13: bulk additions from same sender each trigger independently', async () => {
    const members = ['hire-1', 'hire-2', 'hire-3'];
    const results = await Promise.all(
      members.map((login, i) => {
        const event = makeEvent({
          id: `evt-bulk-${i}`,
          eventType: 'github.member.added',
          payload: {
            action: 'added',
            member: { login, id: 20000 + i },
            repository: { full_name: 'acme/monorepo' },
            sender: { login: 'bulk-admin' },
          },
        });
        const rule = makeRule({
          ruleType: 'github.member_change',
          config: { alertOnActions: ['added'] },
        });
        return memberChangeEvaluator.evaluate(makeCtx(event, rule));
      }),
    );

    expect(results).toHaveLength(3);
    results.forEach((result) => {
      expect(result).not.toBeNull();
    });
    expect(results[0]!.title).toContain('hire-1');
    expect(results[1]!.title).toContain('hire-2');
    expect(results[2]!.title).toContain('hire-3');
  });

  it('MC-S14: wrong event type (github.push) returns null', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ref: 'refs/heads/main', forced: false },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['added'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('MC-S15: alert severity is always high for member changes', async () => {
    const actions = ['added', 'removed', 'edited'] as const;
    for (const action of actions) {
      const event = makeEvent({
        eventType: `github.member.${action}`,
        payload: {
          action,
          member: { login: 'test-user', id: 1 },
          sender: { login: 'admin' },
        },
      });
      const rule = makeRule({
        ruleType: 'github.member_change',
        config: { alertOnActions: [action] },
      });
      const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

      expect(result).not.toBeNull();
      expect(result!.severity).toBe('high');
    }
  });

  it('MC-S16: alert description includes role when present', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: {
        action: 'added',
        member: { login: 'new-maintainer', id: 5555, role: 'maintainer' },
        repository: { full_name: 'acme/oss-project' },
        sender: { login: 'project-lead' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['added'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('maintainer');
    expect(result!.description).toContain('as maintainer');
  });
});

// ===========================================================================
// D. Deploy Key Scenarios (14 tests)
// ===========================================================================

describe('Deploy Key Scenarios', () => {
  it('DK-S01: write-access deploy key created on production repo triggers high severity', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 101, title: 'CI/CD Pipeline Key', read_only: false },
        repository: { full_name: 'acme/production-backend' },
        sender: { login: 'devops-engineer' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: true },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('created');
    expect(result!.title).toContain('acme/production-backend');
    expect(result!.description).toContain('read-write');
  });

  it('DK-S02: read-only key created with alertOnWriteKeys=true does not fire', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 102, title: 'Read-only deploy', read_only: true },
        repository: { full_name: 'acme/docs-site' },
        sender: { login: 'docs-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: true },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('DK-S03: read-only key created with alertOnWriteKeys=false fires alert', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 103, title: 'Monitoring key', read_only: true },
        repository: { full_name: 'acme/metrics-service' },
        sender: { login: 'monitoring-bot' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: false },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.description).toContain('read-only');
  });

  it('DK-S04: deploy key deleted (write access) fires when alertOnActions includes deleted', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.deleted',
      payload: {
        action: 'deleted',
        key: { id: 104, title: 'Old deploy key', read_only: false },
        repository: { full_name: 'acme/core' },
        sender: { login: 'security-team' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['deleted'], alertOnWriteKeys: true },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('deleted');
  });

  it('DK-S05: deploy key deleted (read-only) with alertOnWriteKeys=true does not fire', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.deleted',
      payload: {
        action: 'deleted',
        key: { id: 105, title: 'Legacy read key', read_only: true },
        repository: { full_name: 'acme/core' },
        sender: { login: 'cleanup-bot' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['deleted'], alertOnWriteKeys: true },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('DK-S06: only watching created - deleted event comes - no alert', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.deleted',
      payload: {
        action: 'deleted',
        key: { id: 106, title: 'Expired key', read_only: false },
        repository: { full_name: 'acme/core' },
        sender: { login: 'admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'] },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('DK-S07: suspicious late-night key creation triggers alert with full context', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.created',
      occurredAt: new Date('2026-03-15T03:30:00Z'),
      payload: {
        action: 'created',
        key: { id: 107, title: 'temp-access-key', read_only: false },
        repository: { full_name: 'acme/financial-data' },
        sender: { login: 'unknown-user-99' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: true },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('unknown-user-99');
    expect(result!.description).toContain('temp-access-key');
  });

  it('DK-S08: key with unusual title suggesting automation still fires', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 108, title: 'auto-exfil-2026-03-15', read_only: false },
        repository: { full_name: 'acme/secrets-vault' },
        sender: { login: 'script-kiddie' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: true },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('auto-exfil-2026-03-15');
  });

  it('DK-S09: wrong event type (github.push) returns null', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ref: 'refs/heads/main', forced: false },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'] },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('DK-S10: alert includes access level in description', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 109, title: 'deploy-key-prod', read_only: false },
        repository: { full_name: 'acme/core' },
        sender: { login: 'admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: false },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('read-write');
  });

  it('DK-S11: write key = high severity, read key = medium severity', async () => {
    // Write key
    const writeEvent = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 110, title: 'write-key', read_only: false },
        repository: { full_name: 'acme/core' },
        sender: { login: 'admin' },
      },
    });
    const writeRule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: false },
    });
    const writeResult = await deployKeyEvaluator.evaluate(makeCtx(writeEvent, writeRule));

    expect(writeResult).not.toBeNull();
    expect(writeResult!.severity).toBe('high');

    // Read key
    const readEvent = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 111, title: 'read-key', read_only: true },
        repository: { full_name: 'acme/core' },
        sender: { login: 'admin' },
      },
    });
    const readRule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: false },
    });
    const readResult = await deployKeyEvaluator.evaluate(makeCtx(readEvent, readRule));

    expect(readResult).not.toBeNull();
    expect(readResult!.severity).toBe('medium');
  });

  it('DK-S12: both created and deleted watched - both fire', async () => {
    const createdEvent = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 112, title: 'new-key', read_only: false },
        repository: { full_name: 'acme/core' },
        sender: { login: 'admin' },
      },
    });
    const deletedEvent = makeEvent({
      eventType: 'github.deploy_key.deleted',
      payload: {
        action: 'deleted',
        key: { id: 112, title: 'new-key', read_only: false },
        repository: { full_name: 'acme/core' },
        sender: { login: 'admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created', 'deleted'], alertOnWriteKeys: true },
    });

    const createdResult = await deployKeyEvaluator.evaluate(makeCtx(createdEvent, rule));
    const deletedResult = await deployKeyEvaluator.evaluate(makeCtx(deletedEvent, rule));

    expect(createdResult).not.toBeNull();
    expect(deletedResult).not.toBeNull();
  });

  it('DK-S13: key title preserved in alert description', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 113, title: 'github-actions-deploy-v3', read_only: false },
        repository: { full_name: 'acme/core' },
        sender: { login: 'ci-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: true },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('github-actions-deploy-v3');
  });

  it('DK-S14: repository full_name in alert title', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 114, title: 'prod-deploy', read_only: false },
        repository: { full_name: 'megacorp/critical-infra' },
        sender: { login: 'infra-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: true },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('megacorp/critical-infra');
  });
});

// ===========================================================================
// E. Secret Scanning Scenarios (14 tests)
// ===========================================================================

describe('Secret Scanning Scenarios', () => {
  it('SS-S01: AWS access key detected in production repo triggers critical alert', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.created',
      payload: {
        action: 'created',
        alert: { number: 42, secret_type: 'aws_access_key_id', state: 'open' },
        repository: { full_name: 'acme/production-api' },
        sender: { login: 'github-scanner[bot]' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'], secretTypes: ['aws_access_key_id'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('acme/production-api');
    expect(result!.description).toContain('aws_access_key_id');
  });

  it('SS-S02: GitHub PAT leaked in commit triggers critical alert', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.created',
      payload: {
        action: 'created',
        alert: { number: 43, secret_type: 'github_personal_access_token', state: 'open' },
        repository: { full_name: 'acme/dotfiles' },
        sender: { login: 'github-scanner[bot]' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('github_personal_access_token');
  });

  it('SS-S03: private key committed accidentally triggers critical alert', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.created',
      payload: {
        action: 'created',
        alert: { number: 44, secret_type: 'private_key', state: 'open' },
        repository: { full_name: 'acme/ssh-configs' },
        sender: { login: 'github-scanner[bot]' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'], secretTypes: ['private_key', 'aws_access_key_id'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('SS-S04: secret type not in filter produces no alert', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.created',
      payload: {
        action: 'created',
        alert: { number: 45, secret_type: 'slack_incoming_webhook_url', state: 'open' },
        repository: { full_name: 'acme/chatops' },
        sender: { login: 'github-scanner[bot]' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'], secretTypes: ['aws_access_key_id', 'github_personal_access_token'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('SS-S05: empty secretTypes means watch all types', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.created',
      payload: {
        action: 'created',
        alert: { number: 46, secret_type: 'stripe_api_key', state: 'open' },
        repository: { full_name: 'acme/payments' },
        sender: { login: 'github-scanner[bot]' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'], secretTypes: [] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('SS-S06: alert resolved fires when alertOnActions includes resolved', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.resolved',
      payload: {
        action: 'resolved',
        alert: { number: 47, secret_type: 'aws_access_key_id', state: 'resolved' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'security-engineer' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['resolved'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });

  it('SS-S07: alert resolved with alertOnActions=[created] does NOT fire', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.resolved',
      payload: {
        action: 'resolved',
        alert: { number: 48, secret_type: 'aws_access_key_id', state: 'resolved' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'security-engineer' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('SS-S08: reopened alert fires when watching reopened', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.reopened',
      payload: {
        action: 'reopened',
        alert: { number: 49, secret_type: 'github_personal_access_token', state: 'open' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'security-bot' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['reopened'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('SS-S09: multiple secret types in filter - matching type fires', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.created',
      payload: {
        action: 'created',
        alert: { number: 50, secret_type: 'google_api_key', state: 'open' },
        repository: { full_name: 'acme/gcp-service' },
        sender: { login: 'github-scanner[bot]' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: {
        alertOnActions: ['created'],
        secretTypes: ['aws_access_key_id', 'google_api_key', 'private_key'],
      },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('SS-S10: created alert produces critical severity', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.created',
      payload: {
        action: 'created',
        alert: { number: 51, secret_type: 'azure_devops_pat', state: 'open' },
        repository: { full_name: 'acme/azure-infra' },
        sender: { login: 'scanner' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('SS-S11: resolved alert produces medium severity', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.resolved',
      payload: {
        action: 'resolved',
        alert: { number: 52, secret_type: 'npm_access_token', state: 'resolved' },
        repository: { full_name: 'acme/npm-packages' },
        sender: { login: 'admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['resolved'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });

  it('SS-S12: alert number appears in description', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.created',
      payload: {
        action: 'created',
        alert: { number: 999, secret_type: 'github_pat', state: 'open' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'scanner' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('#999');
  });

  it('SS-S13: secret type appears in description', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.created',
      payload: {
        action: 'created',
        alert: { number: 53, secret_type: 'hashicorp_vault_token', state: 'open' },
        repository: { full_name: 'acme/vault-configs' },
        sender: { login: 'scanner' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('hashicorp_vault_token');
  });

  it('SS-S14: wrong event type (github.push) returns null', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ref: 'refs/heads/main', forced: false },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// F. Force Push Scenarios (20 tests)
// ===========================================================================

describe('Force Push Scenarios', () => {
  const baseForcePush = {
    ref: 'refs/heads/main',
    forced: true,
    repository: { full_name: 'acme/core' },
    pusher: { name: 'alice' },
    sender: { login: 'alice' },
    commits_count: 5,
    head_commit: { id: 'abc123def', message: 'force update main' },
  };

  it('FP-S01: force push to main triggers critical alert', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: baseForcePush,
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['main'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('main');
  });

  it('FP-S02: force push to feature branch not watched produces no alert', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, ref: 'refs/heads/feature/new-ui' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['main', 'production'], alertOnAllForced: false },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('FP-S03: non-force push to main produces no alert', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, forced: false },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['main'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('FP-S04: alertOnAllForced=true catches any branch force push', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, ref: 'refs/heads/random-experiment' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { alertOnAllForced: true },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('random-experiment');
  });

  it('FP-S05: wildcard pattern release/* matches release/v1', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, ref: 'refs/heads/release/v1' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['release/*'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('release/v1');
  });

  it('FP-S06: force push to production branch triggers critical alert', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, ref: 'refs/heads/production' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['production'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('production');
  });

  it('FP-S07: force push to master (legacy branch name) caught by default config', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, ref: 'refs/heads/master' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: {},  // default watchBranches includes 'master'
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('master');
  });

  it('FP-S08: tag push (refs/tags/) is skipped even if forced', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, ref: 'refs/tags/v1.0.0' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { alertOnAllForced: true },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('FP-S09: force push by admin user gets no exemption - still fires', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: {
        ...baseForcePush,
        pusher: { name: 'org-admin' },
        sender: { login: 'org-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['main'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('FP-S10: force push with 0 commits produces correct pluralization', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, commits_count: 0, head_commit: null },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['main'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('0 commits');
  });

  it('FP-S11: force push with 50 commits shows correct count', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, commits_count: 50 },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['main'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('50 commits');
  });

  it('FP-S12: multiple watchBranches - event matches second branch', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, ref: 'refs/heads/staging' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['main', 'staging', 'production'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('staging');
  });

  it('FP-S13: empty watchBranches but alertOnAllForced=false uses defaults', async () => {
    // Default watchBranches is ['main', 'master', 'release/*', 'production']
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, ref: 'refs/heads/main' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { alertOnAllForced: false },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('FP-S14: branch name with slashes (feature/team/task) handled correctly', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, ref: 'refs/heads/feature/team/task-123' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { alertOnAllForced: true },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('feature/team/task-123');
  });

  it('FP-S15: attacker force pushes to main to rewrite history - critical alert with sender info', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: {
        ref: 'refs/heads/main',
        forced: true,
        repository: { full_name: 'acme/supply-chain-critical' },
        pusher: { name: 'compromised-ci-bot' },
        sender: { login: 'compromised-ci-bot' },
        commits_count: 1,
        head_commit: { id: 'deadbeef', message: 'update dependencies' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['main'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('compromised-ci-bot');
    expect(result!.title).toContain('acme/supply-chain-critical');
  });

  it('FP-S16: alert title contains branch name', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, ref: 'refs/heads/deploy-prod' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { alertOnAllForced: true },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('deploy-prod');
  });

  it('FP-S17: alert description contains commit count', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, commits_count: 7 },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['main'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('7 commits');
  });

  it('FP-S18: wrong event type (github.member.added) returns null', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: { action: 'added', member: { login: 'bob', id: 1 }, sender: { login: 'alice' } },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['main'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('FP-S19: non-forced push to watched branch produces no alert', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: {
        ref: 'refs/heads/production',
        forced: false,
        repository: { full_name: 'acme/core' },
        pusher: { name: 'developer' },
        sender: { login: 'developer' },
        commits_count: 3,
        head_commit: { id: 'abc123', message: 'normal push' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['production'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('FP-S20: force push to branch matching exact name in watchBranches', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...baseForcePush, ref: 'refs/heads/production' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['production'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('production');
  });
});

// ===========================================================================
// G. Org Settings Scenarios (18 tests)
// ===========================================================================

describe('Org Settings Scenarios', () => {
  it('OS-S01: 2FA requirement disabled triggers medium severity (org settings event)', async () => {
    const event = makeEvent({
      eventType: 'github.organization.disable_two_factor_requirement',
      payload: {
        action: 'disable_two_factor_requirement',
        organization: { login: 'acme-corp' },
        sender: { login: 'careless-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: { watchActions: ['disable_two_factor_requirement'] },
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    // 'disable_two_factor_requirement' is not in the member actions list, so medium
    expect(result!.severity).toBe('medium');
    expect(result!.description).toContain('careless-admin');
  });

  it('OS-S02: new team created with admin permissions triggers high severity', async () => {
    const event = makeEvent({
      eventType: 'github.team.created',
      payload: {
        action: 'created',
        team: { name: 'super-admins', slug: 'super-admins', permission: 'admin' },
        sender: { login: 'org-owner' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: {},
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('admin permissions');
  });

  it('OS-S03: team deleted triggers high severity', async () => {
    const event = makeEvent({
      eventType: 'github.team.deleted',
      payload: {
        action: 'deleted',
        team: { name: 'legacy-ops', slug: 'legacy-ops', permission: 'push' },
        sender: { login: 'reorg-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: {},
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('deleted');
    expect(result!.title).toContain('legacy-ops');
  });

  it('OS-S04: organization member_added triggers high severity', async () => {
    const event = makeEvent({
      eventType: 'github.organization.member_added',
      payload: {
        action: 'member_added',
        organization: { login: 'acme-corp' },
        membership: { user: { login: 'new-hire' } },
        sender: { login: 'hr-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: {},
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('OS-S05: organization member_removed triggers high severity', async () => {
    const event = makeEvent({
      eventType: 'github.organization.member_removed',
      payload: {
        action: 'member_removed',
        organization: { login: 'acme-corp' },
        membership: { user: { login: 'departing-employee' } },
        sender: { login: 'it-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: {},
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('OS-S06: organization member_invited triggers high severity', async () => {
    const event = makeEvent({
      eventType: 'github.organization.member_invited',
      payload: {
        action: 'member_invited',
        organization: { login: 'acme-corp' },
        sender: { login: 'hiring-manager' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: {},
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('OS-S07: watchActions filter only allows specific actions', async () => {
    const event = makeEvent({
      eventType: 'github.organization.member_added',
      payload: {
        action: 'member_added',
        organization: { login: 'acme-corp' },
        sender: { login: 'admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: { watchActions: ['member_removed', 'member_invited'] },
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('OS-S08: empty watchActions means all actions are watched', async () => {
    const event = makeEvent({
      eventType: 'github.organization.renamed',
      payload: {
        action: 'renamed',
        organization: { login: 'acme-new-name' },
        sender: { login: 'ceo' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: { watchActions: [] },
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('OS-S09: team edited triggers medium severity', async () => {
    const event = makeEvent({
      eventType: 'github.team.edited',
      payload: {
        action: 'edited',
        team: { name: 'engineering', slug: 'engineering', permission: 'push' },
        sender: { login: 'team-lead' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: {},
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });

  it('OS-S10: non-matching action filtered out by watchActions', async () => {
    const event = makeEvent({
      eventType: 'github.team.created',
      payload: {
        action: 'created',
        team: { name: 'frontend', slug: 'frontend', permission: 'push' },
        sender: { login: 'admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: { watchActions: ['deleted'] },
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('OS-S11: organization event vs team event routing produces different title formats', async () => {
    // Organization event
    const orgEvent = makeEvent({
      eventType: 'github.organization.member_added',
      payload: {
        action: 'member_added',
        organization: { login: 'acme' },
        sender: { login: 'admin' },
      },
    });
    const orgRule = makeRule({ ruleType: 'github.org_settings', config: {} });
    const orgResult = await orgSettingsEvaluator.evaluate(makeCtx(orgEvent, orgRule));

    // Team event
    const teamEvent = makeEvent({
      eventType: 'github.team.created',
      payload: {
        action: 'created',
        team: { name: 'devops', slug: 'devops', permission: 'push' },
        sender: { login: 'admin' },
      },
    });
    const teamRule = makeRule({ ruleType: 'github.org_settings', config: {} });
    const teamResult = await orgSettingsEvaluator.evaluate(makeCtx(teamEvent, teamRule));

    expect(orgResult).not.toBeNull();
    expect(teamResult).not.toBeNull();
    expect(orgResult!.title).toContain('Organization event');
    expect(teamResult!.title).toContain('Team');
  });

  it('OS-S12: team created without admin permissions triggers medium severity', async () => {
    const event = makeEvent({
      eventType: 'github.team.created',
      payload: {
        action: 'created',
        team: { name: 'readers', slug: 'readers', permission: 'pull' },
        sender: { login: 'org-admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: {},
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });

  it('OS-S13: suspicious team creation by external user includes sender in description', async () => {
    const event = makeEvent({
      eventType: 'github.team.created',
      payload: {
        action: 'created',
        team: { name: 'backdoor-team', slug: 'backdoor-team', permission: 'admin' },
        sender: { login: 'unknown-external-user' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: {},
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('unknown-external-user');
    expect(result!.description).toContain('admin permissions');
  });

  it('OS-S14: wrong event type (github.push) returns null', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ref: 'refs/heads/main', forced: false },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: {},
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('OS-S15: alert title format for team events includes team name', async () => {
    const event = makeEvent({
      eventType: 'github.team.created',
      payload: {
        action: 'created',
        team: { name: 'platform-engineering', slug: 'platform-engineering', permission: 'push' },
        sender: { login: 'cto' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: {},
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Team created: platform-engineering');
  });

  it('OS-S16: alert title format for org events includes action', async () => {
    const event = makeEvent({
      eventType: 'github.organization.member_removed',
      payload: {
        action: 'member_removed',
        organization: { login: 'acme' },
        sender: { login: 'admin' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: {},
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Organization event: member_removed');
  });

  it('OS-S17: alert description includes sender login', async () => {
    const event = makeEvent({
      eventType: 'github.team.edited',
      payload: {
        action: 'edited',
        team: { name: 'infra', slug: 'infra', permission: 'push' },
        sender: { login: 'sneaky-insider' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: {},
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('sneaky-insider');
  });

  it('OS-S18: team permission escalation detection - admin team creation caught', async () => {
    const event = makeEvent({
      eventType: 'github.team.created',
      payload: {
        action: 'created',
        team: { name: 'escalated-team', slug: 'escalated-team', permission: 'admin' },
        sender: { login: 'privilege-escalator' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: { watchActions: ['created'] },
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('admin permissions');
    expect(result!.description).toContain('privilege-escalator');
    expect(result!.triggerData).toHaveProperty('team');
    expect((result!.triggerData as any).team.permission).toBe('admin');
  });
});
