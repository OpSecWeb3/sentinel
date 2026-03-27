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
    id: 'evt-1',
    orgId: 'org-1',
    moduleId: 'github',
    eventType: 'github.push',
    externalId: 'delivery-1',
    payload: {},
    occurredAt: new Date('2026-03-26T12:00:00Z'),
    receivedAt: new Date('2026-03-26T12:00:01Z'),
    ...overrides,
  };
}

function makeRule(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: 'rule-1',
    detectionId: 'det-1',
    orgId: 'org-1',
    moduleId: 'github',
    ruleType: 'github.repo_visibility',
    config: {},
    status: 'active',
    priority: 1,
    action: 'alert',
    ...overrides,
  };
}

function makeCtx(event: NormalizedEvent, rule: RuleRow): EvalContext {
  return { event, rule, redis: {} as any };
}

// ===========================================================================
// repo-visibility evaluator
// ===========================================================================

describe('repoVisibilityEvaluator', () => {
  it('triggers on publicized when config is publicized (default)', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/core', visibility: 'public', id: 1 },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({ ruleType: 'github.repo_visibility', config: {} });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.triggerType).toBe('immediate');
    expect(result!.title).toContain('acme/core');
    expect(result!.title).toContain('public');
  });

  it('does not trigger on privatized when config is publicized', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'privatized',
        repository: { full_name: 'acme/core', visibility: 'private', id: 1 },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({ ruleType: 'github.repo_visibility', config: { alertOn: 'publicized' } });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('triggers on privatized when config is privatized', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'privatized',
        repository: { full_name: 'acme/core', visibility: 'private', id: 1 },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({ ruleType: 'github.repo_visibility', config: { alertOn: 'privatized' } });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('triggers on either direction when config is any', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'privatized',
        repository: { full_name: 'acme/core', visibility: 'private', id: 1 },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({ ruleType: 'github.repo_visibility', config: { alertOn: 'any' } });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('excludes repos matching excludeRepos glob pattern', async () => {
    const event = makeEvent({
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'acme/test-sandbox', visibility: 'public', id: 1 },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({
      ruleType: 'github.repo_visibility',
      config: { excludeRepos: ['acme/test-*'] },
    });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null for unrelated event types', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ref: 'refs/heads/main', forced: false },
    });
    const rule = makeRule({ ruleType: 'github.repo_visibility', config: {} });
    const result = await repoVisibilityEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// branch-protection evaluator
// ===========================================================================

describe('branchProtectionEvaluator', () => {
  const baseBPPayload = {
    action: 'edited',
    rule: { name: 'main', pattern: 'main' },
    repository: { full_name: 'acme/core' },
    sender: { login: 'alice', id: 42 },
    changes: { enforcement_level: { from: 'everyone' } },
  };

  it('triggers on edited action (default config)', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.edited',
      payload: baseBPPayload,
    });
    const rule = makeRule({ ruleType: 'github.branch_protection', config: {} });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.triggerType).toBe('immediate');
    expect(result!.title).toContain('modified');
  });

  it('triggers on deleted action with critical severity', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.deleted',
      payload: { ...baseBPPayload, action: 'deleted' },
    });
    const rule = makeRule({ ruleType: 'github.branch_protection', config: {} });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('removed');
  });

  it('does not trigger on created when default config (edited+deleted)', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.created',
      payload: { ...baseBPPayload, action: 'created' },
    });
    const rule = makeRule({ ruleType: 'github.branch_protection', config: {} });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('filters by watchBranches', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.edited',
      payload: {
        ...baseBPPayload,
        rule: { name: 'develop', pattern: 'develop' },
      },
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { watchBranches: ['main', 'release/*'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('passes branch filter when pattern matches watchBranches', async () => {
    const event = makeEvent({
      eventType: 'github.branch_protection.edited',
      payload: baseBPPayload, // pattern = 'main'
    });
    const rule = makeRule({
      ruleType: 'github.branch_protection',
      config: { watchBranches: ['main'] },
    });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('returns null for unrelated event types', async () => {
    const event = makeEvent({ eventType: 'github.push', payload: {} });
    const rule = makeRule({ ruleType: 'github.branch_protection', config: {} });
    const result = await branchProtectionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// member-change evaluator
// ===========================================================================

describe('memberChangeEvaluator', () => {
  it('triggers on added action (default config)', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: {
        action: 'added',
        member: { login: 'bob', id: 99, role: 'admin' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({ ruleType: 'github.member_change', config: {} });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('bob');
    expect(result!.title).toContain('added');
  });

  it('triggers on removed action (default config)', async () => {
    const event = makeEvent({
      eventType: 'github.member.removed',
      payload: {
        action: 'removed',
        member: { login: 'bob', id: 99 },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({ ruleType: 'github.member_change', config: {} });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('in organization');
  });

  it('does not trigger on edited when only added/removed configured', async () => {
    const event = makeEvent({
      eventType: 'github.member.edited',
      payload: {
        action: 'edited',
        member: { login: 'bob', id: 99 },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { alertOnActions: ['added', 'removed'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('filters by watchRoles', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: {
        action: 'added',
        member: { login: 'bob', id: 99, role: 'member' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { watchRoles: ['admin'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('passes role filter when role matches', async () => {
    const event = makeEvent({
      eventType: 'github.member.added',
      payload: {
        action: 'added',
        member: { login: 'bob', id: 99, role: 'admin' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({
      ruleType: 'github.member_change',
      config: { watchRoles: ['admin'] },
    });
    const result = await memberChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });
});

// ===========================================================================
// deploy-key evaluator
// ===========================================================================

describe('deployKeyEvaluator', () => {
  it('triggers on write-access key created when alertOnWriteKeys=true', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 1, title: 'deploy-bot', read_only: false },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnWriteKeys: true },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('created');
  });

  it('does not trigger on read-only key when alertOnWriteKeys=true', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 2, title: 'read-deploy', read_only: true },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnWriteKeys: true },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('triggers on read-only key when alertOnWriteKeys=false', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 2, title: 'read-deploy', read_only: true },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnWriteKeys: false },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });

  it('does not trigger on deleted when only created configured', async () => {
    const event = makeEvent({
      eventType: 'github.deploy_key.deleted',
      payload: {
        action: 'deleted',
        key: { id: 1, title: 'deploy-bot', read_only: false },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'] },
    });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null for unrelated event types', async () => {
    const event = makeEvent({ eventType: 'github.push', payload: {} });
    const rule = makeRule({ ruleType: 'github.deploy_key', config: {} });
    const result = await deployKeyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// secret-scanning evaluator
// ===========================================================================

describe('secretScanningEvaluator', () => {
  it('triggers on created action with critical severity', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.created',
      payload: {
        action: 'created',
        alert: { number: 1, secret_type: 'github_personal_access_token', state: 'open' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({ ruleType: 'github.secret_scanning', config: {} });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.triggerType).toBe('immediate');
    expect(result!.title).toContain('created');
  });

  it('triggers on resolved action with medium severity', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.resolved',
      payload: {
        action: 'resolved',
        alert: { number: 1, secret_type: 'github_personal_access_token', state: 'resolved' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created', 'resolved'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });

  it('filters by secretTypes', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.created',
      payload: {
        action: 'created',
        alert: { number: 2, secret_type: 'aws_access_key_id', state: 'open' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({
      ruleType: 'github.secret_scanning',
      config: { secretTypes: ['github_personal_access_token'] },
    });
    const result = await secretScanningEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('does not trigger on resolved when only created configured', async () => {
    const event = makeEvent({
      eventType: 'github.secret_scanning.resolved',
      payload: {
        action: 'resolved',
        alert: { number: 1, secret_type: 'github_personal_access_token', state: 'resolved' },
        repository: { full_name: 'acme/core' },
        sender: { login: 'alice', id: 42 },
      },
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
// force-push evaluator
// ===========================================================================

describe('forcePushEvaluator', () => {
  const basePushPayload = {
    ref: 'refs/heads/main',
    forced: true,
    repository: { full_name: 'acme/core' },
    pusher: { name: 'alice' },
    sender: { login: 'alice', id: 42 },
    commits_count: 3,
    head_commit: { id: 'abc123', message: 'force update' },
  };

  it('triggers on forced push to watched branch (main)', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: basePushPayload,
    });
    const rule = makeRule({ ruleType: 'github.force_push', config: {} });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.triggerType).toBe('immediate');
    expect(result!.title).toContain('main');
  });

  it('does not trigger on non-forced push', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...basePushPayload, forced: false },
    });
    const rule = makeRule({ ruleType: 'github.force_push', config: {} });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('does not trigger on unwatched branch', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...basePushPayload, ref: 'refs/heads/feature/xyz' },
    });
    const rule = makeRule({ ruleType: 'github.force_push', config: {} });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('matches branch glob patterns (release/*)', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...basePushPayload, ref: 'refs/heads/release/v2.0' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { watchBranches: ['release/*'] },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('release/v2.0');
  });

  it('triggers on any branch when alertOnAllForced=true', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ...basePushPayload, ref: 'refs/heads/my-random-branch' },
    });
    const rule = makeRule({
      ruleType: 'github.force_push',
      config: { alertOnAllForced: true },
    });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
  });

  it('returns null for non-push event types', async () => {
    const event = makeEvent({ eventType: 'github.member.added', payload: {} });
    const rule = makeRule({ ruleType: 'github.force_push', config: {} });
    const result = await forcePushEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// org-settings evaluator
// ===========================================================================

describe('orgSettingsEvaluator', () => {
  it('triggers on organization events', async () => {
    const event = makeEvent({
      eventType: 'github.organization.member_added',
      payload: {
        action: 'member_added',
        organization: { login: 'acme', id: 1 },
        membership: { user: { login: 'bob' } },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({ ruleType: 'github.org_settings', config: {} });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high'); // member_added is high
    expect(result!.triggerType).toBe('immediate');
  });

  it('triggers on team events', async () => {
    const event = makeEvent({
      eventType: 'github.team.created',
      payload: {
        action: 'created',
        team: { name: 'devops', slug: 'devops', permission: 'push' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({ ruleType: 'github.org_settings', config: {} });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('devops');
  });

  it('assigns high severity to team with admin permissions on created', async () => {
    const event = makeEvent({
      eventType: 'github.team.created',
      payload: {
        action: 'created',
        team: { name: 'super-admins', slug: 'super-admins', permission: 'admin' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({ ruleType: 'github.org_settings', config: {} });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('admin permissions');
  });

  it('filters by watchActions', async () => {
    const event = makeEvent({
      eventType: 'github.organization.member_added',
      payload: {
        action: 'member_added',
        organization: { login: 'acme', id: 1 },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({
      ruleType: 'github.org_settings',
      config: { watchActions: ['member_removed'] },
    });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null for unrelated event types', async () => {
    const event = makeEvent({ eventType: 'github.push', payload: {} });
    const rule = makeRule({ ruleType: 'github.org_settings', config: {} });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('assigns high severity to team deleted', async () => {
    const event = makeEvent({
      eventType: 'github.team.deleted',
      payload: {
        action: 'deleted',
        team: { name: 'devops', slug: 'devops', permission: 'push' },
        sender: { login: 'alice', id: 42 },
      },
    });
    const rule = makeRule({ ruleType: 'github.org_settings', config: {} });
    const result = await orgSettingsEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });
});
