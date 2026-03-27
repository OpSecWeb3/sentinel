import { describe, it, expect, vi } from 'vitest';
import type { EvalContext, NormalizedEvent, RuleRow } from '@sentinel/shared/rules';
import { digestChangeEvaluator } from '../evaluators/digest-change.js';
import { attributionEvaluator } from '../evaluators/attribution.js';
import { securityPolicyEvaluator } from '../evaluators/security-policy.js';
import { npmChecksEvaluator } from '../evaluators/npm-checks.js';
import { anomalyDetectionEvaluator } from '../evaluators/anomaly-detection.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'evt-1',
    orgId: 'org-1',
    moduleId: 'registry',
    eventType: 'registry.docker.digest_change',
    externalId: null,
    payload: {},
    occurredAt: new Date('2026-03-26T14:00:00Z'),
    receivedAt: new Date('2026-03-26T14:00:01Z'),
    ...overrides,
  };
}

function makeRule(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: 'rule-1',
    detectionId: 'det-1',
    orgId: 'org-1',
    moduleId: 'registry',
    ruleType: 'registry.digest_change',
    config: {},
    status: 'active',
    priority: 1,
    action: 'alert',
    ...overrides,
  };
}

function makeMockRedis(overrides: Record<string, any> = {}) {
  const pipelineObj = {
    zadd: vi.fn().mockReturnThis(),
    zremrangebyscore: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([
      [null, 1],    // zadd
      [null, 0],    // zremrangebyscore
      [null, 1],    // zcard — 1 change (under default limit)
      [null, 1],    // expire
    ]),
    ...overrides,
  };
  return {
    pipeline: vi.fn().mockReturnValue(pipelineObj),
    _pipeline: pipelineObj,
  } as any;
}

function makeCtx(event: NormalizedEvent, rule: RuleRow, redis?: any): EvalContext {
  return { event, rule, redis: redis ?? ({} as any) };
}

// ===========================================================================
// digest-change evaluator
// ===========================================================================

describe('digestChangeEvaluator', () => {
  it('triggers on digest_change event with medium severity', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: {
        artifact: 'library/nginx',
        tag: 'latest',
        eventType: 'digest_change',
        oldDigest: 'sha256:aaaa1111222233334444555566667777',
        newDigest: 'sha256:bbbb1111222233334444555566667777',
        source: 'poll',
        pusher: null,
      },
    });
    const rule = makeRule({ config: {} });
    const result = await digestChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.triggerType).toBe('immediate');
    expect(result!.title).toContain('Digest changed');
    expect(result!.title).toContain('library/nginx');
  });

  it('filters by tag pattern', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: {
        artifact: 'library/nginx',
        tag: 'nightly',
        eventType: 'digest_change',
        oldDigest: 'sha256:aaaa',
        newDigest: 'sha256:bbbb',
        source: 'poll',
        pusher: null,
      },
    });
    const rule = makeRule({ config: { tagPatterns: ['v*'] } });
    const result = await digestChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('triggers on new_tag with low severity', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.new_tag',
      payload: {
        artifact: 'library/nginx',
        tag: 'v1.25.0',
        eventType: 'new_tag',
        oldDigest: null,
        newDigest: 'sha256:cccc1111222233334444555566667777',
        source: 'webhook',
        pusher: 'deploy-bot',
      },
    });
    const rule = makeRule({ config: { changeTypes: ['new_tag'] } });
    const result = await digestChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('low');
    expect(result!.title).toContain('New tag');
  });

  it('triggers on tag_removed with high severity', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.tag_removed',
      payload: {
        artifact: 'library/nginx',
        tag: 'v1.24.0',
        eventType: 'tag_removed',
        oldDigest: 'sha256:aaaa',
        newDigest: null,
        source: 'poll',
        pusher: null,
      },
    });
    const rule = makeRule({ config: { changeTypes: ['tag_removed'] } });
    const result = await digestChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('removed');
  });

  it('alerts on unexpected tag name via expectedTagPattern', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.new_tag',
      payload: {
        artifact: 'library/nginx',
        tag: 'yolo',
        eventType: 'new_tag',
        oldDigest: null,
        newDigest: 'sha256:cccc',
        source: 'webhook',
        pusher: 'attacker',
      },
    });
    const rule = makeRule({
      config: {
        changeTypes: ['new_tag'],
        expectedTagPattern: 'v*',
      },
    });
    const result = await digestChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.title).toContain('Unexpected tag');
  });

  it('does not alert when tag matches expectedTagPattern', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.new_tag',
      payload: {
        artifact: 'library/nginx',
        tag: 'v2.0.0',
        eventType: 'new_tag',
        oldDigest: null,
        newDigest: 'sha256:cccc',
        source: 'webhook',
        pusher: 'deploy-bot',
      },
    });
    const rule = makeRule({
      config: {
        changeTypes: ['new_tag'],
        expectedTagPattern: 'v*',
      },
    });
    const result = await digestChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('skips when changeType is not in config', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.tag_removed',
      payload: {
        artifact: 'library/nginx',
        tag: 'v1.0.0',
        eventType: 'tag_removed',
        oldDigest: 'sha256:aaaa',
        newDigest: null,
        source: 'poll',
        pusher: null,
      },
    });
    // Default changeTypes = ['digest_change', 'new_tag', 'tag_removed'] -- this is included
    // But let's explicitly exclude it
    const rule = makeRule({ config: { changeTypes: ['digest_change'] } });
    const result = await digestChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null for unrelated event types', async () => {
    const event = makeEvent({ eventType: 'registry.npm.version_published' });
    const rule = makeRule({ config: {} });
    const result = await digestChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// attribution evaluator
// ===========================================================================

describe('attributionEvaluator', () => {
  const basePayload = {
    artifact: 'library/nginx',
    tag: 'latest',
    eventType: 'digest_change',
    newDigest: 'sha256:abcd1234',
    source: 'webhook',
  };

  it('alerts when attribution is unattributed (must_match)', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: {
        ...basePayload,
        attribution: {
          status: 'unattributed',
          workflow: null,
          actor: null,
          branch: null,
          runId: null,
          commit: null,
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.attribution',
      config: { attributionCondition: 'must_match' },
    });
    const result = await attributionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.triggerType).toBe('immediate');
    expect(result!.title).toContain('Unattributed');
  });

  it('returns deferred when attribution is pending (must_match)', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: {
        ...basePayload,
        attribution: {
          status: 'pending',
          workflow: null,
          actor: null,
          branch: null,
          runId: null,
          commit: null,
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.attribution',
      config: { attributionCondition: 'must_match' },
    });
    const result = await attributionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.triggerType).toBe('deferred');
    expect(result!.severity).toBe('high');
  });

  it('does not alert when attribution is verified and matches (must_match)', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: {
        ...basePayload,
        attribution: {
          status: 'verified',
          workflow: '.github/workflows/deploy.yml',
          actor: 'deploy-bot',
          branch: 'main',
          runId: 12345,
          commit: 'abc123',
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.attribution',
      config: {
        attributionCondition: 'must_match',
        workflows: ['deploy.yml'],
        actors: ['deploy-bot'],
        branches: ['main'],
      },
    });
    const result = await attributionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('alerts when actor does not match (must_match)', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: {
        ...basePayload,
        attribution: {
          status: 'verified',
          workflow: '.github/workflows/deploy.yml',
          actor: 'rogue-user',
          branch: 'main',
          runId: 99,
          commit: 'xyz',
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.attribution',
      config: {
        attributionCondition: 'must_match',
        actors: ['deploy-bot'],
      },
    });
    const result = await attributionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('actor');
  });

  it('alerts when attribution matches blocked criteria (must_not_match)', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: {
        ...basePayload,
        attribution: {
          status: 'verified',
          workflow: '.github/workflows/deploy.yml',
          actor: 'deploy-bot',
          branch: 'main',
          runId: 12345,
          commit: 'abc123',
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.attribution',
      config: {
        attributionCondition: 'must_not_match',
        actors: ['deploy-bot'],
      },
    });
    const result = await attributionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('Unexpected CI attribution');
  });

  it('filters by tag pattern', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: {
        ...basePayload,
        tag: 'nightly',
        attribution: {
          status: 'unattributed',
          workflow: null,
          actor: null,
          branch: null,
          runId: null,
          commit: null,
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.attribution',
      config: {
        attributionCondition: 'must_match',
        tagPatterns: ['v*'],
      },
    });
    const result = await attributionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null for unrelated event types', async () => {
    const event = makeEvent({ eventType: 'registry.docker.tag_removed' });
    const rule = makeRule({
      ruleType: 'registry.attribution',
      config: { attributionCondition: 'must_match' },
    });
    const result = await attributionEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// security-policy evaluator
// ===========================================================================

describe('securityPolicyEvaluator', () => {
  const basePayload = {
    artifact: 'library/nginx',
    tag: 'v1.25.0',
    newDigest: 'sha256:abcd1234567890',
  };

  it('alerts on missing signature when requireSignature=true', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.new_tag',
      payload: {
        ...basePayload,
        verification: {
          signature: { hasSignature: false },
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.security_policy',
      config: { requireSignature: true },
    });
    const result = await securityPolicyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('Missing signature');
  });

  it('passes when signature is present and requireSignature=true', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.new_tag',
      payload: {
        ...basePayload,
        verification: {
          signature: { hasSignature: true },
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.security_policy',
      config: { requireSignature: true },
    });
    const result = await securityPolicyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('alerts on pinned digest mismatch', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: {
        ...basePayload,
        newDigest: 'sha256:different1234567890',
      },
    });
    const rule = makeRule({
      ruleType: 'registry.security_policy',
      config: {
        pinnedDigest: 'sha256:abcd1234567890',
      },
    });
    const result = await securityPolicyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('Pinned digest violation');
  });

  it('passes when digest matches pinned value', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: {
        ...basePayload,
        newDigest: 'sha256:abcd1234567890',
      },
    });
    const rule = makeRule({
      ruleType: 'registry.security_policy',
      config: {
        pinnedDigest: 'sha256:abcd1234567890',
      },
    });
    const result = await securityPolicyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('alerts on missing provenance when requireProvenance=true', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.new_tag',
      payload: {
        ...basePayload,
        verification: {
          signature: { hasSignature: true },
          provenance: { hasProvenance: false },
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.security_policy',
      config: { requireSignature: true, requireProvenance: true },
    });
    const result = await securityPolicyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('Missing SLSA provenance');
  });

  it('alerts on provenance source repo mismatch', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.new_tag',
      payload: {
        ...basePayload,
        verification: {
          signature: { hasSignature: true },
          provenance: {
            hasProvenance: true,
            provenanceSourceRepo: 'github.com/evil-org/nginx',
          },
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.security_policy',
      config: {
        requireSignature: true,
        requireProvenance: true,
        provenanceSourceRepo: 'github.com/acme/nginx',
      },
    });
    const result = await securityPolicyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('Provenance source mismatch');
  });

  it('passes all security checks when everything is valid', async () => {
    const event = makeEvent({
      eventType: 'registry.docker.new_tag',
      payload: {
        ...basePayload,
        verification: {
          signature: { hasSignature: true },
          provenance: {
            hasProvenance: true,
            provenanceSourceRepo: 'github.com/acme/nginx',
          },
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.security_policy',
      config: {
        requireSignature: true,
        requireProvenance: true,
        provenanceSourceRepo: 'acme/nginx',
      },
    });
    const result = await securityPolicyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null for unrelated event types', async () => {
    const event = makeEvent({ eventType: 'registry.docker.tag_removed' });
    const rule = makeRule({
      ruleType: 'registry.security_policy',
      config: {},
    });
    const result = await securityPolicyEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// npm-checks evaluator
// ===========================================================================

describe('npmChecksEvaluator', () => {
  it('alerts on install scripts detection', async () => {
    const event = makeEvent({
      eventType: 'registry.npm.version_published',
      payload: {
        artifact: 'lodash',
        tag: '5.0.0',
        newDigest: 'sha256:abc123',
        metadata: {
          hasInstallScripts: true,
          installScripts: ['preinstall', 'postinstall'],
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.npm_checks',
      config: { checkInstallScripts: true },
    });
    const result = await npmChecksEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('Install scripts detected');
    expect(result!.description).toContain('preinstall');
  });

  it('does not alert when no install scripts present', async () => {
    const event = makeEvent({
      eventType: 'registry.npm.version_published',
      payload: {
        artifact: 'lodash',
        tag: '5.0.0',
        newDigest: 'sha256:abc123',
        metadata: {
          hasInstallScripts: false,
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.npm_checks',
      config: { checkInstallScripts: true },
    });
    const result = await npmChecksEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('alerts on major version jump', async () => {
    const event = makeEvent({
      eventType: 'registry.npm.version_published',
      payload: {
        artifact: 'express',
        tag: '6.0.0',
        newDigest: 'sha256:abc123',
        metadata: {
          isMajorVersionJump: true,
          previousVersion: '4.21.0',
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.npm_checks',
      config: { checkMajorVersionJump: true },
    });
    const result = await npmChecksEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('Major version jump');
    expect(result!.title).toContain('4.21.0');
  });

  it('does not alert on non-major version bump', async () => {
    const event = makeEvent({
      eventType: 'registry.npm.version_published',
      payload: {
        artifact: 'express',
        tag: '4.22.0',
        newDigest: 'sha256:abc123',
        metadata: {
          isMajorVersionJump: false,
          previousVersion: '4.21.0',
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.npm_checks',
      config: { checkMajorVersionJump: true },
    });
    const result = await npmChecksEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null when neither npm check is enabled', async () => {
    const event = makeEvent({
      eventType: 'registry.npm.version_published',
      payload: {
        artifact: 'lodash',
        tag: '5.0.0',
        newDigest: 'sha256:abc123',
        metadata: {
          hasInstallScripts: true,
          isMajorVersionJump: true,
          previousVersion: '4.0.0',
        },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.npm_checks',
      config: { checkInstallScripts: false, checkMajorVersionJump: false },
    });
    const result = await npmChecksEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('filters by tag pattern', async () => {
    const event = makeEvent({
      eventType: 'registry.npm.version_published',
      payload: {
        artifact: 'lodash',
        tag: 'beta-1.0.0',
        newDigest: 'sha256:abc123',
        metadata: { hasInstallScripts: true },
      },
    });
    const rule = makeRule({
      ruleType: 'registry.npm_checks',
      config: { checkInstallScripts: true, tagPatterns: ['v*'] },
    });
    const result = await npmChecksEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('returns null for unrelated event types', async () => {
    const event = makeEvent({ eventType: 'registry.docker.tag_removed' });
    const rule = makeRule({
      ruleType: 'registry.npm_checks',
      config: { checkInstallScripts: true },
    });
    const result = await npmChecksEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// anomaly-detection evaluator
// ===========================================================================

describe('anomalyDetectionEvaluator', () => {
  const basePayload = {
    artifact: 'library/nginx',
    tag: 'latest',
    eventType: 'digest_change',
    source: 'webhook',
    pusher: 'deploy-bot',
  };

  it('alerts when pusher is not in allowlist', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: { ...basePayload, pusher: 'rogue-user' },
    });
    const rule = makeRule({
      ruleType: 'registry.anomaly_detection',
      config: { pusherAllowlist: ['deploy-bot', 'ci-bot'] },
    });
    const result = await anomalyDetectionEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('Unauthorized pusher');
    expect(result!.description).toContain('rogue-user');
  });

  it('alerts when pusher is null and allowlist is set', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: { ...basePayload, pusher: null },
    });
    const rule = makeRule({
      ruleType: 'registry.anomaly_detection',
      config: { pusherAllowlist: ['deploy-bot'] },
    });
    const result = await anomalyDetectionEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('unknown');
  });

  it('passes when pusher is in allowlist', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: basePayload,
    });
    const rule = makeRule({
      ruleType: 'registry.anomaly_detection',
      config: { pusherAllowlist: ['deploy-bot'] },
    });
    const result = await anomalyDetectionEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('alerts on source mismatch', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: { ...basePayload, source: 'poll' },
    });
    const rule = makeRule({
      ruleType: 'registry.anomaly_detection',
      config: { expectedSource: 'webhook' },
    });
    const result = await anomalyDetectionEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.title).toContain('Source mismatch');
  });

  it('passes when source matches expected', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: basePayload, // source = 'webhook'
    });
    const rule = makeRule({
      ruleType: 'registry.anomaly_detection',
      config: { expectedSource: 'webhook' },
    });
    const result = await anomalyDetectionEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('alerts when event is outside allowed time window', async () => {
    const redis = makeMockRedis();
    // Saturday at 3am UTC
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      occurredAt: new Date('2026-03-28T03:00:00Z'), // Saturday
      payload: basePayload,
    });
    const rule = makeRule({
      ruleType: 'registry.anomaly_detection',
      config: {
        allowedHoursStart: '09:00',
        allowedHoursEnd: '18:00',
        timezone: 'UTC',
        allowedDays: [1, 2, 3, 4, 5], // Mon-Fri only
      },
    });
    const result = await anomalyDetectionEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('Off-hours');
  });

  it('passes when event is within allowed time window', async () => {
    const redis = makeMockRedis();
    // Thursday at 2pm UTC
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      occurredAt: new Date('2026-03-26T14:00:00Z'), // Thursday
      payload: basePayload,
    });
    const rule = makeRule({
      ruleType: 'registry.anomaly_detection',
      config: {
        allowedHoursStart: '09:00',
        allowedHoursEnd: '18:00',
        timezone: 'UTC',
        allowedDays: [1, 2, 3, 4, 5],
      },
    });
    const result = await anomalyDetectionEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('alerts when rate limit is exceeded via Redis', async () => {
    const redis = makeMockRedis();
    // Override zcard to return count > maxChanges
    redis._pipeline.exec.mockResolvedValue([
      [null, 1],    // zadd
      [null, 0],    // zremrangebyscore
      [null, 11],   // zcard — 11 changes (over limit of 10)
      [null, 1],    // expire
    ]);
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: basePayload,
    });
    const rule = makeRule({
      ruleType: 'registry.anomaly_detection',
      config: { maxChanges: 10, windowMinutes: 60 },
    });
    const result = await anomalyDetectionEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.triggerType).toBe('windowed');
    expect(result!.title).toContain('Rapid changes');
    expect(redis.pipeline).toHaveBeenCalled();
  });

  it('passes when under rate limit', async () => {
    const redis = makeMockRedis();
    // zcard returns 3 (under limit of 10)
    redis._pipeline.exec.mockResolvedValue([
      [null, 1],
      [null, 0],
      [null, 3],
      [null, 1],
    ]);
    const event = makeEvent({
      eventType: 'registry.docker.digest_change',
      payload: basePayload,
    });
    const rule = makeRule({
      ruleType: 'registry.anomaly_detection',
      config: { maxChanges: 10, windowMinutes: 60 },
    });
    const result = await anomalyDetectionEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });

  it('returns null for unrelated event types', async () => {
    const redis = makeMockRedis();
    const event = makeEvent({ eventType: 'registry.npm.version_published' });
    const rule = makeRule({
      ruleType: 'registry.anomaly_detection',
      config: {},
    });
    const result = await anomalyDetectionEvaluator.evaluate(makeCtx(event, rule, redis));

    expect(result).toBeNull();
  });
});
