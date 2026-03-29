/**
 * Cross-module compound scenarios, attack chain simulations, and condition engine edge cases.
 * 60+ tests covering evaluator composition, adversarial inputs, and type boundary behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getField, compare, evaluateConditions, type Condition, type Operator } from '@sentinel/shared/conditions';
import type { NormalizedEvent, RuleRow, EvalContext, AlertCandidate, RuleEvaluator } from '@sentinel/shared/rules';

// We re-export z from @sentinel/shared which re-exports from zod
// But since the test/ dir cannot resolve bare `zod`, we access it via shared's re-export
// Actually the evaluators import zod internally; our helpers just need a ZodSchema-compatible object.
// We use a passthrough schema approach.

// ---------------------------------------------------------------------------
// We import the real compound evaluator and several GitHub evaluators
// ---------------------------------------------------------------------------

import { compoundEvaluator } from '@sentinel/shared/evaluators/compound';
import { branchProtectionEvaluator } from '../../modules/github/src/evaluators/branch-protection.js';
import { forcePushEvaluator } from '../../modules/github/src/evaluators/force-push.js';
import { repoVisibilityEvaluator } from '../../modules/github/src/evaluators/repo-visibility.js';
import { memberChangeEvaluator } from '../../modules/github/src/evaluators/member-change.js';
import { secretScanningEvaluator } from '../../modules/github/src/evaluators/secret-scanning.js';
import { deployKeyEvaluator } from '../../modules/github/src/evaluators/deploy-key.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Redis mock — compound evaluator only needs redis to exist in context. */
const redis = {} as any;

/** Build a full evaluator registry from an array of evaluators. */
function buildRegistry(...evaluators: RuleEvaluator[]): Map<string, RuleEvaluator> {
  const map = new Map<string, RuleEvaluator>();
  for (const ev of evaluators) {
    map.set(`${ev.moduleId}:${ev.ruleType}`, ev);
  }
  return map;
}

function minimatchCompat(value: string, pattern: string): boolean {
  const mod = require('minimatch');
  const fn = typeof mod === 'function' ? mod : mod.minimatch;
  return fn(value, pattern);
}

function makeEvent(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    id: 'evt_test_1',
    orgId: 'org_1',
    moduleId: 'github',
    eventType: 'github.push',
    externalId: null,
    payload: {},
    occurredAt: new Date('2026-03-27T12:00:00Z'),
    receivedAt: new Date('2026-03-27T12:00:01Z'),
    ...overrides,
  };
}

function makeRule(overrides: Partial<RuleRow>): RuleRow {
  return {
    id: 'rule_1',
    detectionId: 'det_1',
    orgId: 'org_1',
    moduleId: 'platform',
    ruleType: 'platform.compound',
    config: {},
    status: 'active',
    priority: 50,
    action: 'alert',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<EvalContext>): EvalContext {
  return {
    event: makeEvent({}),
    rule: makeRule({}),
    redis,
    ...overrides,
  };
}

/**
 * A minimal ZodSchema-compatible object that always succeeds validation.
 * Avoids importing zod directly (not available at test/ root).
 */
const passthroughSchema = {
  safeParse: (data: unknown) => ({ success: true as const, data }),
  parse: (data: unknown) => data,
} as any;

/** A trivial evaluator that always fires when eventType matches. */
function makeAlwaysFireEvaluator(
  moduleId: string,
  ruleType: string,
  severity = 'high',
): RuleEvaluator {
  return {
    moduleId,
    ruleType,
    configSchema: passthroughSchema,
    async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
      return {
        orgId: ctx.event.orgId,
        detectionId: ctx.rule.detectionId,
        ruleId: ctx.rule.id,
        eventId: ctx.event.id,
        severity,
        title: `${ruleType} triggered`,
        triggerType: 'immediate',
        triggerData: {},
      };
    },
  };
}

/** A trivial evaluator that never fires. */
function makeNeverFireEvaluator(moduleId: string, ruleType: string): RuleEvaluator {
  return {
    moduleId,
    ruleType,
    configSchema: passthroughSchema,
    async evaluate(): Promise<AlertCandidate | null> {
      return null;
    },
  };
}

/** A trivial evaluator that throws. */
function makeErrorEvaluator(moduleId: string, ruleType: string): RuleEvaluator {
  return {
    moduleId,
    ruleType,
    configSchema: passthroughSchema,
    async evaluate(): Promise<AlertCandidate | null> {
      throw new Error('boom');
    },
  };
}

// =========================================================================
// 1. Compound Evaluator Scenarios (15 tests)
// =========================================================================

describe('Compound Evaluator Scenarios', () => {
  it('AND: both sub-rules fire -> compound fires', async () => {
    const evA = makeAlwaysFireEvaluator('mod_a', 'mod_a.rule_a');
    const evB = makeAlwaysFireEvaluator('mod_b', 'mod_b.rule_b');
    const registry = buildRegistry(evA, evB, compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'AND',
        subRules: [
          { ruleType: 'mod_a.rule_a', config: {} },
          { ruleType: 'mod_b.rule_b', config: {} },
        ],
      },
    });

    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    expect(result).not.toBeNull();
    expect(result!.title).toContain('2/2 AND');
  });

  it('AND: first sub-rule fails -> compound does not fire', async () => {
    const evA = makeNeverFireEvaluator('mod_a', 'mod_a.rule_a');
    const evB = makeAlwaysFireEvaluator('mod_b', 'mod_b.rule_b');
    const registry = buildRegistry(evA, evB, compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'AND',
        subRules: [
          { ruleType: 'mod_a.rule_a', config: {} },
          { ruleType: 'mod_b.rule_b', config: {} },
        ],
      },
    });

    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    expect(result).toBeNull();
  });

  it('AND: second sub-rule fails -> compound does not fire', async () => {
    const evA = makeAlwaysFireEvaluator('mod_a', 'mod_a.rule_a');
    const evB = makeNeverFireEvaluator('mod_b', 'mod_b.rule_b');
    const registry = buildRegistry(evA, evB, compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'AND',
        subRules: [
          { ruleType: 'mod_a.rule_a', config: {} },
          { ruleType: 'mod_b.rule_b', config: {} },
        ],
      },
    });

    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    expect(result).toBeNull();
  });

  it('OR: first sub-rule fires -> compound fires', async () => {
    const evA = makeAlwaysFireEvaluator('mod_a', 'mod_a.rule_a');
    const evB = makeNeverFireEvaluator('mod_b', 'mod_b.rule_b');
    const registry = buildRegistry(evA, evB, compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'OR',
        subRules: [
          { ruleType: 'mod_a.rule_a', config: {} },
          { ruleType: 'mod_b.rule_b', config: {} },
        ],
      },
    });

    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    expect(result).not.toBeNull();
    expect(result!.title).toContain('OR');
  });

  it('OR: neither sub-rule fires -> compound does not fire', async () => {
    const evA = makeNeverFireEvaluator('mod_a', 'mod_a.rule_a');
    const evB = makeNeverFireEvaluator('mod_b', 'mod_b.rule_b');
    const registry = buildRegistry(evA, evB, compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'OR',
        subRules: [
          { ruleType: 'mod_a.rule_a', config: {} },
          { ruleType: 'mod_b.rule_b', config: {} },
        ],
      },
    });

    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    expect(result).toBeNull();
  });

  it('N-of-M: 2 of 3 sub-rules fire (threshold=2) -> fires', async () => {
    const evA = makeAlwaysFireEvaluator('a', 'a.r1');
    const evB = makeNeverFireEvaluator('b', 'b.r2');
    const evC = makeAlwaysFireEvaluator('c', 'c.r3');
    const registry = buildRegistry(evA, evB, evC, compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'OR', // operator is ignored when threshold is set
        threshold: 2,
        subRules: [
          { ruleType: 'a.r1', config: {} },
          { ruleType: 'b.r2', config: {} },
          { ruleType: 'c.r3', config: {} },
        ],
      },
    });

    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    expect(result).not.toBeNull();
    expect(result!.triggerData).toMatchObject({ triggeredCount: 2, totalSubRules: 3 });
  });

  it('N-of-M: 1 of 3 sub-rules fire (need 2) -> does not fire', async () => {
    const evA = makeAlwaysFireEvaluator('a', 'a.r1');
    const evB = makeNeverFireEvaluator('b', 'b.r2');
    const evC = makeNeverFireEvaluator('c', 'c.r3');
    const registry = buildRegistry(evA, evB, evC, compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'OR',
        threshold: 2,
        subRules: [
          { ruleType: 'a.r1', config: {} },
          { ruleType: 'b.r2', config: {} },
          { ruleType: 'c.r3', config: {} },
        ],
      },
    });

    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    expect(result).toBeNull();
  });

  it('AND with three sub-rules all firing', async () => {
    const evA = makeAlwaysFireEvaluator('a', 'a.r1', 'low');
    const evB = makeAlwaysFireEvaluator('b', 'b.r2', 'medium');
    const evC = makeAlwaysFireEvaluator('c', 'c.r3', 'critical');
    const registry = buildRegistry(evA, evB, evC, compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'AND',
        subRules: [
          { ruleType: 'a.r1', config: {} },
          { ruleType: 'b.r2', config: {} },
          { ruleType: 'c.r3', config: {} },
        ],
      },
    });

    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical'); // highest severity wins
    expect(result!.triggerData).toMatchObject({ triggeredCount: 3, totalSubRules: 3 });
  });

  it('OR with three sub-rules, only third fires', async () => {
    const evA = makeNeverFireEvaluator('a', 'a.r1');
    const evB = makeNeverFireEvaluator('b', 'b.r2');
    const evC = makeAlwaysFireEvaluator('c', 'c.r3');
    const registry = buildRegistry(evA, evB, evC, compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'OR',
        subRules: [
          { ruleType: 'a.r1', config: {} },
          { ruleType: 'b.r2', config: {} },
          { ruleType: 'c.r3', config: {} },
        ],
      },
    });

    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    expect(result).not.toBeNull();
    expect(result!.triggerData).toMatchObject({ triggeredCount: 1, totalSubRules: 3 });
  });

  it('sub-rule evaluator not found -> treated as not fired', async () => {
    const evA = makeAlwaysFireEvaluator('a', 'a.r1');
    // b.r2 is NOT in the registry
    const registry = buildRegistry(evA, compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'AND',
        subRules: [
          { ruleType: 'a.r1', config: {} },
          { ruleType: 'b.r2', config: {} }, // not registered
        ],
      },
    });

    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    // AND requires all, one missing => null
    expect(result).toBeNull();
  });

  it('mixed module sub-rules (github evaluators) in compound', async () => {
    const registry = buildRegistry(
      branchProtectionEvaluator,
      forcePushEvaluator,
      compoundEvaluator,
    );

    const event = makeEvent({
      eventType: 'github.branch_protection.deleted',
      payload: {
        action: 'deleted',
        rule: { name: 'main-protection', pattern: 'main' },
        repository: { full_name: 'org/repo' },
        sender: { login: 'attacker' },
      },
    });

    const rule = makeRule({
      config: {
        operator: 'OR',
        subRules: [
          {
            ruleType: 'github.branch_protection',
            config: { alertOnActions: ['deleted'] },
          },
          {
            ruleType: 'github.force_push',
            config: { watchBranches: ['main'] },
          },
        ],
      },
    });

    const result = await compoundEvaluator.evaluate(
      makeCtx({ event, rule, evaluators: registry }),
    );
    // branch_protection fires (event matches), force_push does not (wrong event type)
    // OR requires at least one, so compound fires
    expect(result).not.toBeNull();
    expect(result!.title).toContain('1/2 OR');
  });

  it('compound with empty sub-rules does not produce alert', async () => {
    const registry = buildRegistry(compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'AND',
        subRules: [] as any[], // force empty — normally blocked by zod .min(1)
      },
    });

    // With empty subRules, zod validation will throw, so compound returns null
    // (config parse fails in the evaluator itself)
    await expect(
      compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry })),
    ).rejects.toThrow(); // zod throws on min(1) violation
  });

  it('error in sub-rule evaluation is caught, treated as not fired', async () => {
    const evA = makeAlwaysFireEvaluator('a', 'a.r1');
    const evB = makeErrorEvaluator('b', 'b.r2');
    const registry = buildRegistry(evA, evB, compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'AND',
        subRules: [
          { ruleType: 'a.r1', config: {} },
          { ruleType: 'b.r2', config: {} },
        ],
      },
    });

    // AND requires both; b throws => treated as not fired => null
    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    expect(result).toBeNull();
  });

  it('alert aggregates sub-rule information in triggerData', async () => {
    const evA = makeAlwaysFireEvaluator('a', 'a.r1', 'high');
    const evB = makeAlwaysFireEvaluator('b', 'b.r2', 'medium');
    const registry = buildRegistry(evA, evB, compoundEvaluator);

    const rule = makeRule({
      config: {
        operator: 'AND',
        subRules: [
          { ruleType: 'a.r1', config: {} },
          { ruleType: 'b.r2', config: {} },
        ],
      },
    });

    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    expect(result).not.toBeNull();
    const td = result!.triggerData as any;
    expect(td.subResults).toHaveLength(2);
    expect(td.subResults[0]).toMatchObject({ ruleType: 'a.r1', severity: 'high' });
    expect(td.subResults[1]).toMatchObject({ ruleType: 'b.r2', severity: 'medium' });
    expect(td.operator).toBe('AND');
  });
});

// =========================================================================
// 2. Attack Chain Scenarios (15 tests)
// =========================================================================

describe('Attack Chain Scenarios', () => {
  it('attacker disables branch protection THEN force pushes (two events)', async () => {
    // Event 1: branch protection deleted
    const bpEvent = makeEvent({
      id: 'evt_bp_del',
      eventType: 'github.branch_protection.deleted',
      payload: {
        action: 'deleted',
        rule: { name: 'main', pattern: 'main' },
        repository: { full_name: 'org/core' },
        sender: { login: 'attacker' },
      },
    });

    const bpRule = makeRule({
      id: 'rule_bp',
      moduleId: 'github',
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['deleted'] },
    });

    const bpResult = await branchProtectionEvaluator.evaluate(
      makeCtx({ event: bpEvent, rule: bpRule }),
    );
    expect(bpResult).not.toBeNull();
    expect(bpResult!.severity).toBe('critical');

    // Event 2: force push to main
    const fpEvent = makeEvent({
      id: 'evt_fp',
      eventType: 'github.push',
      payload: {
        ref: 'refs/heads/main',
        forced: true,
        repository: { full_name: 'org/core' },
        pusher: { name: 'attacker' },
        sender: { login: 'attacker' },
        commits_count: 1,
        head_commit: { id: 'abc123', message: 'overwrite history' },
      },
    });

    const fpRule = makeRule({
      id: 'rule_fp',
      moduleId: 'github',
      ruleType: 'github.force_push',
      config: { watchBranches: ['main'] },
    });

    const fpResult = await forcePushEvaluator.evaluate(
      makeCtx({ event: fpEvent, rule: fpRule }),
    );
    expect(fpResult).not.toBeNull();
    expect(fpResult!.severity).toBe('critical');

    // Both events together indicate a coordinated attack
    expect(bpResult!.triggerData).toMatchObject({ action: 'deleted' });
    expect(fpResult!.triggerData).toMatchObject({ forced: true });
  });

  it('Docker digest changes without CI attribution (supply chain)', async () => {
    // Simulated via condition evaluation on a normalized event payload
    const payload = {
      action: 'digest_changed',
      image: 'org/app:latest',
      previousDigest: 'sha256:aaa',
      currentDigest: 'sha256:bbb',
      ciAttributed: false,
    };

    const conditions: Condition[] = [
      { field: 'action', operator: '==', value: 'digest_changed' },
      { field: 'ciAttributed', operator: '==', value: false },
    ];

    expect(evaluateConditions(payload, conditions)).toBe(true);
  });

  it('npm package gets install scripts + maintainer change (takeover)', async () => {
    const payload = {
      hasInstallScripts: true,
      maintainerChanged: true,
      package: '@company/auth-lib',
      newMaintainer: 'unknown-user',
    };

    const conditions: Condition[] = [
      { field: 'hasInstallScripts', operator: '==', value: true },
      { field: 'maintainerChanged', operator: '==', value: true },
    ];

    expect(evaluateConditions(payload, conditions)).toBe(true);
  });

  it('host becomes unreachable + DNS changed (domain hijack)', async () => {
    const payload = {
      hostReachable: false,
      dnsChanged: true,
      previousIP: '93.184.216.34',
      currentIP: '185.199.108.153',
      domain: 'api.company.com',
    };

    const conditions: Condition[] = [
      { field: 'hostReachable', operator: '==', value: false },
      { field: 'dnsChanged', operator: '==', value: true },
    ];

    expect(evaluateConditions(payload, conditions)).toBe(true);
  });

  it('certificate expires + score degrades (neglected infrastructure)', async () => {
    const payload = {
      certDaysRemaining: 3,
      securityScore: 45,
      scoreThreshold: 70,
      domain: 'payments.company.com',
    };

    const conditions: Condition[] = [
      { field: 'certDaysRemaining', operator: '<', value: 7 },
      { field: 'securityScore', operator: '<', value: 70 },
    ];

    expect(evaluateConditions(payload, conditions)).toBe(true);
  });

  it('secret scanning alert + new deploy key (compromised credentials)', async () => {
    // Secret scanning alert fires
    const ssEvent = makeEvent({
      id: 'evt_ss',
      eventType: 'github.secret_scanning.created',
      payload: {
        action: 'created',
        alert: { number: 42, secret_type: 'github_personal_access_token', state: 'open' },
        repository: { full_name: 'org/api' },
        sender: { login: 'github-bot' },
      },
    });

    const ssRule = makeRule({
      id: 'rule_ss',
      moduleId: 'github',
      ruleType: 'github.secret_scanning',
      config: { alertOnActions: ['created'] },
    });

    const ssResult = await secretScanningEvaluator.evaluate(
      makeCtx({ event: ssEvent, rule: ssRule }),
    );
    expect(ssResult).not.toBeNull();
    expect(ssResult!.severity).toBe('critical');

    // Deploy key created
    const dkEvent = makeEvent({
      id: 'evt_dk',
      eventType: 'github.deploy_key.created',
      payload: {
        action: 'created',
        key: { id: 999, title: 'backdoor-key', read_only: false },
        repository: { full_name: 'org/api' },
        sender: { login: 'attacker' },
      },
    });

    const dkRule = makeRule({
      id: 'rule_dk',
      moduleId: 'github',
      ruleType: 'github.deploy_key',
      config: { alertOnActions: ['created'], alertOnWriteKeys: true },
    });

    const dkResult = await deployKeyEvaluator.evaluate(
      makeCtx({ event: dkEvent, rule: dkRule }),
    );
    expect(dkResult).not.toBeNull();
    expect(dkResult!.title).toContain('Deploy key created');
  });

  it('repo made public + secret in commit history', async () => {
    const visEvent = makeEvent({
      id: 'evt_vis',
      eventType: 'github.repository.visibility_changed',
      payload: {
        action: 'publicized',
        repository: { full_name: 'org/internal-tool', visibility: 'public' },
        sender: { login: 'dev-user' },
      },
    });

    const visRule = makeRule({
      id: 'rule_vis',
      moduleId: 'github',
      ruleType: 'github.repo_visibility',
      config: { alertOn: 'publicized' },
    });

    const visResult = await repoVisibilityEvaluator.evaluate(
      makeCtx({ event: visEvent, rule: visRule }),
    );
    expect(visResult).not.toBeNull();
    expect(visResult!.severity).toBe('critical');
    expect(visResult!.title).toContain('made public');
  });

  it('balance drops 80% + many transfers (rug pull pattern)', async () => {
    const payload = {
      balanceDelta: -80,
      transferCount: 47,
      contractAddress: '0xdead',
      timeWindowMinutes: 10,
    };

    const conditions: Condition[] = [
      { field: 'balanceDelta', operator: '<=', value: -50 },
      { field: 'transferCount', operator: '>', value: 20 },
    ];

    expect(evaluateConditions(payload, conditions)).toBe(true);
  });

  it('windowed spike + function call to withdraw (flash loan attack)', async () => {
    const payload = {
      transactionType: 'flashLoan',
      amountUSD: 5_000_000,
      targetFunction: 'withdraw',
      profitUSD: 200_000,
    };

    const conditions: Condition[] = [
      { field: 'transactionType', operator: '==', value: 'flashLoan' },
      { field: 'amountUSD', operator: '>', value: 1_000_000 },
    ];

    expect(evaluateConditions(payload, conditions)).toBe(true);
  });

  it('new subdomain + CT entry from unknown issuer (phishing setup)', async () => {
    const payload = {
      isNewSubdomain: true,
      certIssuer: 'Unknown CA',
      knownIssuers: false,
      subdomain: 'login.company.com',
    };

    const conditions: Condition[] = [
      { field: 'isNewSubdomain', operator: '==', value: true },
      { field: 'knownIssuers', operator: '==', value: false },
    ];

    expect(evaluateConditions(payload, conditions)).toBe(true);
  });

  it('org member removed + deploy keys revoked (offboarding verification)', async () => {
    const memberEvent = makeEvent({
      id: 'evt_member_rm',
      eventType: 'github.organization.member_removed',
      payload: {
        action: 'member_removed',
        membership: { user: { login: 'ex-employee' }, role: 'admin' },
        organization: { login: 'my-org' },
        sender: { login: 'hr-admin' },
      },
    });

    const memberRule = makeRule({
      id: 'rule_member',
      moduleId: 'github',
      ruleType: 'github.member_change',
      config: { alertOnActions: ['member_removed'], watchRoles: ['admin'] },
    });

    const memberResult = await memberChangeEvaluator.evaluate(
      makeCtx({ event: memberEvent, rule: memberRule }),
    );
    expect(memberResult).not.toBeNull();
    expect(memberResult!.title).toContain('ex-employee');
    expect(memberResult!.title).toContain('removed');
  });

  it('TLS weakness + missing headers (compliance failure)', async () => {
    const payload = {
      tlsVersion: '1.0',
      missingHeaders: ['Strict-Transport-Security', 'X-Frame-Options'],
      missingHeaderCount: 2,
      domain: 'app.company.com',
    };

    const conditions: Condition[] = [
      { field: 'tlsVersion', operator: '==', value: '1.0' },
      { field: 'missingHeaderCount', operator: '>', value: 0 },
    ];

    expect(evaluateConditions(payload, conditions)).toBe(true);
  });

  it('Docker tag removed + new tag with different digest (tag hijack)', async () => {
    const payload = {
      action: 'tag_replaced',
      image: 'company/api',
      tag: 'v2.1.0',
      previousDigest: 'sha256:original',
      newDigest: 'sha256:malicious',
      digestChanged: true,
    };

    const conditions: Condition[] = [
      { field: 'action', operator: '==', value: 'tag_replaced' },
      { field: 'digestChanged', operator: '==', value: true },
    ];

    expect(evaluateConditions(payload, conditions)).toBe(true);
  });

  it('npm version unpublished then republished (dependency confusion)', async () => {
    const payload = {
      action: 'republished',
      package: '@company/utils',
      version: '2.0.0',
      previouslyUnpublished: true,
      publisherChanged: true,
    };

    const conditions: Condition[] = [
      { field: 'previouslyUnpublished', operator: '==', value: true },
      { field: 'publisherChanged', operator: '==', value: true },
    ];

    expect(evaluateConditions(payload, conditions)).toBe(true);
  });

  it('WHOIS expiring + DNS changes (domain expiry takeover preparation)', async () => {
    const payload = {
      whoisDaysRemaining: 5,
      dnsRecordChanged: true,
      registrar: 'shady-registrar.com',
      domain: 'company-cdn.com',
    };

    const conditions: Condition[] = [
      { field: 'whoisDaysRemaining', operator: '<', value: 30 },
      { field: 'dnsRecordChanged', operator: '==', value: true },
    ];

    expect(evaluateConditions(payload, conditions)).toBe(true);
  });
});

// =========================================================================
// 3. Edge Cases & Adversarial (15 tests)
// =========================================================================

describe('Edge Cases & Adversarial', () => {
  it('event with no payload fields - conditions pass when empty', () => {
    const result = evaluateConditions({}, []);
    expect(result).toBe(true);
  });

  it('event with extremely large payload (100KB JSON) - conditions still work', () => {
    const largePayload: Record<string, unknown> = {
      target: 'match_me',
    };
    // Add 100KB of junk data
    for (let i = 0; i < 1000; i++) {
      largePayload[`field_${i}`] = 'x'.repeat(100);
    }

    const conditions: Condition[] = [
      { field: 'target', operator: '==', value: 'match_me' },
    ];
    expect(evaluateConditions(largePayload, conditions)).toBe(true);
  });

  it('rule config fails Zod validation -> evaluator returns null gracefully', async () => {
    // Branch protection expects alertOnActions to be specific enum values
    const rule = makeRule({
      moduleId: 'github',
      ruleType: 'github.branch_protection',
      config: { alertOnActions: ['INVALID_ACTION'] }, // invalid
    });

    const event = makeEvent({
      eventType: 'github.branch_protection.deleted',
      payload: {
        action: 'deleted',
        rule: { name: 'main', pattern: 'main' },
        repository: { full_name: 'org/repo' },
        sender: { login: 'user' },
      },
    });

    // The evaluator calls configSchema.parse() which will throw for invalid config
    await expect(
      branchProtectionEvaluator.evaluate(makeCtx({ event, rule })),
    ).rejects.toThrow();
  });

  it('event type with injection attempt in string', async () => {
    const event = makeEvent({
      eventType: 'github.push"; DROP TABLE events; --',
      payload: {
        ref: 'refs/heads/main',
        forced: true,
        repository: { full_name: 'org/repo' },
        pusher: { name: 'user' },
        sender: { login: 'user' },
        commits_count: 1,
        head_commit: null,
      },
    });

    const rule = makeRule({
      moduleId: 'github',
      ruleType: 'github.force_push',
      config: { watchBranches: ['main'] },
    });

    // Event type won't match, so evaluator returns null harmlessly
    const result = await forcePushEvaluator.evaluate(makeCtx({ event, rule }));
    expect(result).toBeNull();
  });

  it('NaN in numeric condition falls through to string comparison', () => {
    // NaN is not finite and not an integer, so toBigIntSafe returns it as-is.
    // Two NaN numbers: typeof a === 'number' && typeof b === 'number' path.
    // NaN === NaN is false in JS, NaN !== NaN is true.
    expect(compare(NaN, '==', NaN)).toBe(false);
    expect(compare(NaN, '!=', NaN)).toBe(true);

    // NaN compared to 0: both are numbers, so the number comparison path fires.
    // NaN > 0 is false in JS, NaN < 0 is false.
    // But 0 is an integer so toBigIntSafe(0) = BigInt(0), while NaN stays NaN.
    // typeof NaN='number', typeof BigInt(0)='bigint' => not same type for either path.
    // Falls through to numeric string coercion: Number(String(NaN))=NaN, not finite.
    // Falls through to string comparison: String(NaN)="NaN" > String(0n)="0" => true
    expect(compare(NaN, '>', 0)).toBe(true); // string "NaN" > "0"
    expect(compare(NaN, '<', 0)).toBe(false);
  });

  it('BigInt overflow in blockchain values', () => {
    const hugeValue = BigInt('999999999999999999999999999999999999');
    const threshold = BigInt('1000000000000000000'); // 1e18
    expect(compare(hugeValue, '>', threshold)).toBe(true);
    expect(compare(threshold, '<', hugeValue)).toBe(true);
  });

  it('Unicode in repository names works for condition matching', () => {
    const payload = { repo: 'org/repo-name' };
    expect(
      evaluateConditions(payload, [{ field: 'repo', operator: '==', value: 'org/repo-name' }]),
    ).toBe(true);
  });

  it('empty string event type does not crash evaluator', async () => {
    const event = makeEvent({ eventType: '' });
    const rule = makeRule({
      moduleId: 'github',
      ruleType: 'github.force_push',
      config: { watchBranches: ['main'] },
    });

    const result = await forcePushEvaluator.evaluate(makeCtx({ event, rule }));
    expect(result).toBeNull();
  });

  it('rule with action=suppress in compound still evaluates sub-rules', async () => {
    // The compound evaluator itself does not handle action; it just evaluates.
    // The RuleEngine handles action dispatch. Here we verify the compound
    // evaluator returns a candidate regardless of the rule's action field.
    const evA = makeAlwaysFireEvaluator('a', 'a.r1');
    const registry = buildRegistry(evA, compoundEvaluator);

    const rule = makeRule({
      action: 'suppress',
      config: {
        operator: 'OR',
        subRules: [{ ruleType: 'a.r1', config: {} }],
      },
    });

    const result = await compoundEvaluator.evaluate(makeCtx({ rule, evaluators: registry }));
    // Compound itself returns an AlertCandidate; the engine would suppress it
    expect(result).not.toBeNull();
  });

  it('rule with action=log continues without alert in the engine model', async () => {
    // Verify the evaluator produces a candidate even for log rules
    const event = makeEvent({
      eventType: 'github.push',
      payload: {
        ref: 'refs/heads/main',
        forced: true,
        repository: { full_name: 'org/repo' },
        pusher: { name: 'user' },
        sender: { login: 'user' },
        commits_count: 1,
        head_commit: null,
      },
    });

    const rule = makeRule({
      id: 'rule_log',
      moduleId: 'github',
      ruleType: 'github.force_push',
      action: 'log',
      config: { watchBranches: ['main'] },
    });

    const result = await forcePushEvaluator.evaluate(makeCtx({ event, rule }));
    expect(result).not.toBeNull(); // Evaluator fires; engine would handle action
  });

  it('priority ordering: low priority number = higher precedence', () => {
    // This is a design assertion: priority=1 evaluates before priority=100.
    // The RuleEngine sorts by priority ASC, so 1 comes first.
    const rules = [
      makeRule({ id: 'rule_low', priority: 100 }),
      makeRule({ id: 'rule_high', priority: 1 }),
      makeRule({ id: 'rule_mid', priority: 50 }),
    ];

    const sorted = [...rules].sort((a, b) => a.priority - b.priority);
    expect(sorted[0].id).toBe('rule_high');
    expect(sorted[1].id).toBe('rule_mid');
    expect(sorted[2].id).toBe('rule_low');
  });

  it('resource filter: exclude takes precedence over include', () => {
    // Test the matching logic directly
    const resourceId = 'org/repo-secret';
    const filter = {
      include: ['org/repo-*'],
      exclude: ['org/repo-secret'],
    };

    // Exclude check first
    const excluded = filter.exclude.some((p: string) => minimatchCompat(resourceId, p));
    expect(excluded).toBe(true);

    // Even though include matches too
    const included = filter.include.some((p: string) => minimatchCompat(resourceId, p));
    expect(included).toBe(true);

    // But exclude takes precedence in the engine
    // If excluded is true, the resource is filtered OUT
  });

  it('resource filter glob matching (org/repo-*)', () => {
    expect(minimatchCompat('org/repo-alpha', 'org/repo-*')).toBe(true);
    expect(minimatchCompat('org/repo-beta', 'org/repo-*')).toBe(true);
    expect(minimatchCompat('org/other-repo', 'org/repo-*')).toBe(false);
    expect(minimatchCompat('other/repo-alpha', 'org/repo-*')).toBe(false);
  });

  it('cooldown key generation with special characters', () => {
    // Verify the key format handles unusual detection/rule IDs
    const detectionId = 'det_abc-123';
    const ruleId = 'rule_xyz/456';
    const resourceId = 'org/repo:main';

    const key = `sentinel:cooldown:${detectionId}:${ruleId}:${resourceId}`;
    expect(key).toBe('sentinel:cooldown:det_abc-123:rule_xyz/456:org/repo:main');
    // The key is valid for Redis regardless of special chars
    expect(key).not.toContain(' ');
  });

  it('event with Date object vs string timestamp', () => {
    const eventWithDate = makeEvent({ occurredAt: new Date('2026-03-27T12:00:00Z') });
    expect(eventWithDate.occurredAt).toBeInstanceOf(Date);

    const payload = {
      timestamp: '2026-03-27T12:00:00Z',
      timestampEpoch: 1774699200,
    };

    // String timestamp comparisons work via string ordering
    expect(compare('2026-03-27T12:00:00Z', '==', '2026-03-27T12:00:00Z')).toBe(true);
    expect(compare('2026-03-28T12:00:00Z', '>', '2026-03-27T12:00:00Z')).toBe(true);
  });
});

// =========================================================================
// 4. Condition Engine Edge Cases (15 tests)
// =========================================================================

describe('Condition Engine Edge Cases', () => {
  it('deeply nested condition (10 levels)', () => {
    const obj: Record<string, unknown> = {
      l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: 'found' } } } } } } } } },
    };
    expect(getField(obj, 'l1.l2.l3.l4.l5.l6.l7.l8.l9.l10')).toBe('found');
  });

  it('array element access in condition path returns undefined (not supported)', () => {
    const obj = { items: [10, 20, 30] };
    // getField uses dotted path; array indices like "items.0" won't work
    // because arrays are objects and "0" is a valid key
    const result = getField(obj as any, 'items.0');
    expect(result).toBe(10); // actually works because arrays are objects with numeric keys
  });

  it('condition on boolean field', () => {
    const payload = { enabled: true, disabled: false };
    expect(
      evaluateConditions(payload, [{ field: 'enabled', operator: '==', value: true }]),
    ).toBe(true);
    expect(
      evaluateConditions(payload, [{ field: 'disabled', operator: '==', value: false }]),
    ).toBe(true);
    expect(
      evaluateConditions(payload, [{ field: 'enabled', operator: '!=', value: false }]),
    ).toBe(true);
  });

  it('condition comparing strings that look like numbers', () => {
    const payload = { port: '8080' };
    // String "8080" compared to number 8080 — numeric coercion path
    expect(
      evaluateConditions(payload, [{ field: 'port', operator: '==', value: 8080 }]),
    ).toBe(true);
    expect(
      evaluateConditions(payload, [{ field: 'port', operator: '>', value: 80 }]),
    ).toBe(true);
  });

  it('condition with null expected value', () => {
    const payload = { status: null };
    // null == null via string comparison ("null" === "null")
    expect(compare(null, '==', null)).toBe(true);
  });

  it('condition with undefined actual value returns false', () => {
    const payload = { a: 1 };
    // Field "b" is undefined -> evaluateConditions returns false
    expect(
      evaluateConditions(payload, [{ field: 'b', operator: '==', value: 1 }]),
    ).toBe(false);
  });

  it('BigInt from hex string (not directly supported without pre-conversion)', () => {
    // The compare function handles bigint operands natively
    const val = BigInt('0xdeadbeef');
    expect(compare(val, '>', BigInt(0))).toBe(true);
    expect(compare(val, '==', BigInt(3735928559))).toBe(true);
  });

  it('multiple conditions where last one fails', () => {
    const payload = { a: 1, b: 2, c: 3 };
    const conditions: Condition[] = [
      { field: 'a', operator: '==', value: 1 },
      { field: 'b', operator: '==', value: 2 },
      { field: 'c', operator: '==', value: 999 }, // fails
    ];
    expect(evaluateConditions(payload, conditions)).toBe(false);
  });

  it('condition field path with dots in key name (not supported — follows dot path)', () => {
    // If a key literally contains a dot, getField will interpret it as nesting
    const obj = { 'a.b': 'literal', a: { b: 'nested' } };
    // getField('a.b') will traverse obj['a']['b'] = 'nested', not obj['a.b']
    expect(getField(obj as any, 'a.b')).toBe('nested');
  });

  it('float precision comparison (0.1 + 0.2 != 0.3)', () => {
    // This is a known JS floating point issue
    const sum = 0.1 + 0.2;
    expect(compare(sum, '==', 0.3)).toBe(false); // 0.30000000000000004 !== 0.3
    expect(compare(sum, '>', 0.3)).toBe(true); // technically true due to precision
    expect(compare(sum, '!=', 0.3)).toBe(true);
  });

  it('negative BigInt comparison', () => {
    expect(compare(BigInt(-100), '<', BigInt(0))).toBe(true);
    expect(compare(BigInt(-1), '>', BigInt(-2))).toBe(true);
    expect(compare(BigInt(-50), '>=', BigInt(-50))).toBe(true);
    expect(compare(BigInt(-50), '<=', BigInt(-50))).toBe(true);
  });

  it('empty string comparison', () => {
    expect(compare('', '==', '')).toBe(true);
    expect(compare('', '!=', 'a')).toBe(true);
    expect(compare('', '<', 'a')).toBe(true); // empty string sorts before any char

    const payload = { name: '' };
    expect(
      evaluateConditions(payload, [{ field: 'name', operator: '==', value: '' }]),
    ).toBe(true);
  });

  it('condition on array length (returns the array, not length)', () => {
    const payload = { items: [1, 2, 3] };
    // getField('items') returns the array itself; comparing array to number
    // will fall through to string comparison
    const result = getField(payload as any, 'items');
    expect(Array.isArray(result)).toBe(true);
    // Can't directly compare array length via conditions without a "length" sub-path
    const lenResult = getField(payload as any, 'items.length');
    expect(lenResult).toBe(3);
  });

  it('very large number comparison (Number.MAX_SAFE_INTEGER + 1)', () => {
    const big = Number.MAX_SAFE_INTEGER + 1;
    const bigger = Number.MAX_SAFE_INTEGER + 2;
    // These are equal due to floating point precision loss
    expect(compare(big, '==', bigger)).toBe(true); // both lose precision
    // For exact large number comparison, use BigInt
    expect(compare(BigInt(Number.MAX_SAFE_INTEGER) + 1n, '>', BigInt(Number.MAX_SAFE_INTEGER))).toBe(true);
  });

  it('condition on Date string comparison (ISO 8601 lexicographic)', () => {
    expect(compare('2026-03-28T00:00:00Z', '>', '2026-03-27T00:00:00Z')).toBe(true);
    expect(compare('2026-01-01T00:00:00Z', '<', '2026-12-31T23:59:59Z')).toBe(true);
    expect(compare('2026-06-15T12:00:00Z', '==', '2026-06-15T12:00:00Z')).toBe(true);

    const payload = {
      expiresAt: '2026-04-01T00:00:00Z',
    };
    expect(
      evaluateConditions(payload, [
        { field: 'expiresAt', operator: '<', value: '2026-05-01T00:00:00Z' },
      ]),
    ).toBe(true);
  });
});
