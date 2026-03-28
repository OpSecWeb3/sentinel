import { describe, it, expect } from 'vitest';
import type { EvalContext, NormalizedEvent, RuleRow } from '@sentinel/shared/rules';
import { certExpiryEvaluator } from '../evaluators/cert-expiry.js';
import { certIssuesEvaluator } from '../evaluators/cert-issues.js';
import { tlsWeaknessEvaluator } from '../evaluators/tls-weakness.js';
import { dnsChangeEvaluator } from '../evaluators/dns-change.js';
import { headerMissingEvaluator } from '../evaluators/header-missing.js';
import { hostUnreachableEvaluator } from '../evaluators/host-unreachable.js';
import { scoreDegradationEvaluator } from '../evaluators/score-degradation.js';
import { newSubdomainEvaluator } from '../evaluators/new-subdomain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'evt-1',
    orgId: 'org-1',
    moduleId: 'infra',
    eventType: 'infra.cert.expiring',
    externalId: 'scan-1',
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
    moduleId: 'infra',
    ruleType: 'infra.cert_expiry',
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
// cert-expiry evaluator
// ===========================================================================

describe('certExpiryEvaluator', () => {
  const baseCertPayload = {
    hostname: 'app.example.com',
    daysRemaining: 5,
    notAfter: '2026-03-31T00:00:00Z',
    subject: 'CN=app.example.com',
  };

  it('cert expiring in 5 days -> critical', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: { ...baseCertPayload, daysRemaining: 5 },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('5 days');
    expect(result!.title).toContain('app.example.com');
  });

  it('cert expiring in 10 days -> high', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: { ...baseCertPayload, daysRemaining: 10 },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('cert expiring in 20 days -> medium', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: { ...baseCertPayload, daysRemaining: 20 },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });

  it('cert expiring in 60 days -> null (outside default threshold of 30)', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: { ...baseCertPayload, daysRemaining: 60 },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('already expired cert -> critical', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expired',
      payload: {
        ...baseCertPayload,
        daysRemaining: -3,
        notAfter: '2026-03-23T00:00:00Z',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('expired');
  });

  it('custom threshold works (thresholdDays: 90 catches 60-day cert)', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: { ...baseCertPayload, daysRemaining: 60 },
    });
    const rule = makeRule({
      ruleType: 'infra.cert_expiry',
      config: { thresholdDays: 90 },
    });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });
});

// ===========================================================================
// cert-issues evaluator
// ===========================================================================

describe('certIssuesEvaluator', () => {
  it('self-signed cert triggers with high severity', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.issue',
      payload: {
        hostname: 'api.example.com',
        issueType: 'self_signed',
        detail: 'Certificate is self-signed and not trusted by standard CAs',
        subject: 'CN=api.example.com',
        issuer: 'CN=api.example.com',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_issues', config: {} });
    const result = await certIssuesEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('Self-signed');
    expect(result!.title).toContain('api.example.com');
  });

  it('weak key (RSA 1024) triggers with high severity', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.issue',
      payload: {
        hostname: 'legacy.example.com',
        issueType: 'weak_key',
        detail: 'Certificate uses RSA 1024-bit key which is considered insecure',
        subject: 'CN=legacy.example.com',
        issuer: 'CN=DigiCert SHA2 Extended Validation Server CA',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_issues', config: {} });
    const result = await certIssuesEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('Weak certificate key');
  });

  it('SHA-1 signature triggers with medium severity', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.issue',
      payload: {
        hostname: 'old.example.com',
        issueType: 'sha1_signature',
        detail: 'Certificate uses SHA-1 signature algorithm which is deprecated',
        subject: 'CN=old.example.com',
        issuer: 'CN=Old CA',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_issues', config: {} });
    const result = await certIssuesEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.title).toContain('SHA-1');
  });

  it('valid cert (unrelated event type) returns null', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: {
        hostname: 'secure.example.com',
        issueType: 'none',
        detail: 'No issues',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_issues', config: {} });
    const result = await certIssuesEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('issue type filter works (only alert on self_signed)', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.issue',
      payload: {
        hostname: 'old.example.com',
        issueType: 'sha1_signature',
        detail: 'SHA-1 signature',
        subject: 'CN=old.example.com',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.cert_issues',
      config: { issueTypes: ['self_signed'] },
    });
    const result = await certIssuesEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// tls-weakness evaluator
// ===========================================================================

describe('tlsWeaknessEvaluator', () => {
  const baseTlsPayload = {
    hostname: 'app.example.com',
    hasTls10: false,
    hasTls11: false,
    hasTls13: true,
    hasWeakCiphers: false,
    weakCipherList: [],
    legacyVersions: [],
  };

  it('TLS 1.0 enabled -> critical', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        ...baseTlsPayload,
        hasTls10: true,
        legacyVersions: ['TLS 1.0'],
      },
    });
    const rule = makeRule({ ruleType: 'infra.tls_weakness', config: {} });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('TLS 1.0');
  });

  it('TLS 1.1 enabled -> critical (legacy version)', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        ...baseTlsPayload,
        hasTls11: true,
        legacyVersions: ['TLS 1.1'],
      },
    });
    const rule = makeRule({ ruleType: 'infra.tls_weakness', config: {} });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('TLS 1.1');
  });

  it('weak ciphers -> critical', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        ...baseTlsPayload,
        hasWeakCiphers: true,
        weakCipherList: ['TLS_RSA_WITH_RC4_128_SHA', 'TLS_RSA_WITH_3DES_EDE_CBC_SHA'],
      },
    });
    const rule = makeRule({ ruleType: 'infra.tls_weakness', config: {} });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('Weak cipher suites');
  });

  it('only TLS 1.2/1.3 with strong ciphers -> null', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: baseTlsPayload,
    });
    const rule = makeRule({ ruleType: 'infra.tls_weakness', config: {} });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('requireTls13 mode triggers when TLS 1.3 not supported', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        ...baseTlsPayload,
        hasTls13: false,
      },
    });
    const rule = makeRule({
      ruleType: 'infra.tls_weakness',
      config: { alertOnMissingTls13: true },
    });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.description).toContain('TLS 1.3 not supported');
  });
});

// ===========================================================================
// dns-change evaluator
// ===========================================================================

describe('dnsChangeEvaluator', () => {
  it('record added triggers', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          {
            recordType: 'A',
            changeType: 'added',
            newValue: '203.0.113.50',
          },
        ],
      },
    });
    const rule = makeRule({ ruleType: 'infra.dns_change', config: {} });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('1 change');
  });

  it('record modified triggers', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          {
            recordType: 'A',
            changeType: 'modified',
            oldValue: '203.0.113.10',
            newValue: '203.0.113.50',
          },
        ],
      },
    });
    const rule = makeRule({ ruleType: 'infra.dns_change', config: {} });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('modified A');
  });

  it('record removed triggers', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          {
            recordType: 'MX',
            changeType: 'removed',
            oldValue: 'mail.example.com',
          },
        ],
      },
    });
    const rule = makeRule({ ruleType: 'infra.dns_change', config: {} });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('NS change -> critical (auto-promoted)', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          {
            recordType: 'NS',
            changeType: 'modified',
            oldValue: 'ns1.originaldns.com',
            newValue: 'ns1.attackerdns.com',
          },
        ],
      },
    });
    const rule = makeRule({ ruleType: 'infra.dns_change', config: {} });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('record type filter works (only watch MX)', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          { recordType: 'A', changeType: 'modified', oldValue: '1.2.3.4', newValue: '5.6.7.8' },
        ],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.dns_change',
      config: { watchRecordTypes: ['MX'] },
    });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('change type filter works (only watch removed)', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          { recordType: 'A', changeType: 'added', newValue: '1.2.3.4' },
        ],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.dns_change',
      config: { watchChangeTypes: ['removed'] },
    });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// header-missing evaluator
// ===========================================================================

describe('headerMissingEvaluator', () => {
  it('missing HSTS -> high', async () => {
    const event = makeEvent({
      eventType: 'infra.header.missing',
      payload: {
        hostname: 'app.example.com',
        missingHeaders: ['HSTS'],
      },
    });
    const rule = makeRule({ ruleType: 'infra.header_missing', config: {} });
    const result = await headerMissingEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('HSTS');
  });

  it('missing CSP -> high', async () => {
    const event = makeEvent({
      eventType: 'infra.header.missing',
      payload: {
        hostname: 'app.example.com',
        missingHeaders: ['CSP'],
      },
    });
    const rule = makeRule({ ruleType: 'infra.header_missing', config: {} });
    const result = await headerMissingEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('missing X-Frame-Options only -> medium', async () => {
    const event = makeEvent({
      eventType: 'infra.header.missing',
      payload: {
        hostname: 'app.example.com',
        missingHeaders: ['X-Frame-Options'],
      },
    });
    const rule = makeRule({ ruleType: 'infra.header_missing', config: {} });
    const result = await headerMissingEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });

  it('all headers present -> null', async () => {
    const event = makeEvent({
      eventType: 'infra.header.missing',
      payload: {
        hostname: 'secure.example.com',
        missingHeaders: [],
      },
    });
    const rule = makeRule({ ruleType: 'infra.header_missing', config: {} });
    const result = await headerMissingEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('custom required headers list filters correctly', async () => {
    const event = makeEvent({
      eventType: 'infra.header.missing',
      payload: {
        hostname: 'app.example.com',
        missingHeaders: ['HSTS', 'CSP', 'X-Frame-Options'],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.header_missing',
      config: { requiredHeaders: ['X-Frame-Options'] },
    });
    const result = await headerMissingEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    // Only X-Frame-Options is required, and it is not HSTS/CSP, so severity is medium
    expect(result!.severity).toBe('medium');
    expect(result!.description).toContain('X-Frame-Options');
    // HSTS and CSP should not be in the alert since they are not in requiredHeaders
    expect(result!.triggerData).toEqual({
      hostname: 'app.example.com',
      missingHeaders: ['X-Frame-Options'],
    });
  });
});

// ===========================================================================
// host-unreachable evaluator
// ===========================================================================

describe('hostUnreachableEvaluator', () => {
  it('host unreachable triggers with critical severity', async () => {
    const event = makeEvent({
      eventType: 'infra.host.unreachable',
      payload: {
        hostname: 'api.example.com',
        consecutiveFailures: 3,
        isReachable: false,
        dnsResolved: true,
        errorMessage: 'Connection refused',
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('unreachable');
    expect(result!.title).toContain('api.example.com');
    expect(result!.description).toContain('Connection refused');
  });

  it('host slow (above threshold) triggers with high severity', async () => {
    const event = makeEvent({
      eventType: 'infra.host.slow',
      payload: {
        hostname: 'slow.example.com',
        responseTimeMs: 8000,
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('Slow response');
    expect(result!.description).toContain('8000ms');
  });

  it('host slow (below default threshold) -> null', async () => {
    const event = makeEvent({
      eventType: 'infra.host.slow',
      payload: {
        hostname: 'fast.example.com',
        responseTimeMs: 2000,
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('custom threshold_ms works', async () => {
    const event = makeEvent({
      eventType: 'infra.host.slow',
      payload: {
        hostname: 'app.example.com',
        responseTimeMs: 2000,
      },
    });
    const rule = makeRule({
      ruleType: 'infra.host_unreachable',
      config: { thresholdMs: 1000 },
    });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('threshold: 1000ms');
  });

  it('consecutive failure threshold filters low counts', async () => {
    const event = makeEvent({
      eventType: 'infra.host.unreachable',
      payload: {
        hostname: 'flaky.example.com',
        consecutiveFailures: 1,
        isReachable: false,
      },
    });
    // Default consecutiveFailures is 2, so 1 failure should not trigger
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// score-degradation evaluator
// ===========================================================================

describe('scoreDegradationEvaluator', () => {
  it('score below threshold triggers', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 55,
        previousScore: 80,
        grade: 'F',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'score', minScore: 70 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('below threshold');
  });

  it('score above threshold -> null (mode=below)', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 85,
        previousScore: 90,
        grade: 'B',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'score', minScore: 70 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('score dropped by N points triggers (mode=drop)', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 65,
        previousScore: 85,
        grade: 'D',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'drop', minDrop: 15 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical'); // drop of 20 >= 20 threshold
    expect(result!.description).toContain('dropped 20 points');
  });

  it('combined mode (both checks) triggers on either condition', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 60,
        previousScore: 75,
        grade: 'D',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'both', minScore: 70, minDrop: 10 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    // Both conditions should match: below 70 AND dropped 15 points (>= 10)
    expect(result!.description).toContain('below threshold');
    expect(result!.description).toContain('dropped');
  });
});

// ===========================================================================
// new-subdomain evaluator
// ===========================================================================

describe('newSubdomainEvaluator', () => {
  it('new subdomain triggers with medium severity', async () => {
    const event = makeEvent({
      eventType: 'infra.subdomain.discovered',
      payload: {
        parentHostname: 'example.com',
        subdomain: 'admin.example.com',
        source: 'crt_sh',
      },
    });
    const rule = makeRule({ ruleType: 'infra.new_subdomain', config: {} });
    const result = await newSubdomainEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.title).toContain('admin.example.com');
    expect(result!.description).toContain('crt_sh');
  });

  it('ignored pattern (staging*) -> null', async () => {
    const event = makeEvent({
      eventType: 'infra.subdomain.discovered',
      payload: {
        parentHostname: 'example.com',
        subdomain: 'staging-v2.example.com',
        source: 'dns_zone',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.new_subdomain',
      config: { ignorePatterns: ['staging*'] },
    });
    const result = await newSubdomainEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('multiple new subdomains each trigger independently', async () => {
    const subdomains = ['api-v2.example.com', 'dashboard.example.com', 'metrics.example.com'];
    const results = [];

    for (const sub of subdomains) {
      const event = makeEvent({
        eventType: 'infra.subdomain.discovered',
        payload: {
          parentHostname: 'example.com',
          subdomain: sub,
          source: 'brute_force',
        },
      });
      const rule = makeRule({ ruleType: 'infra.new_subdomain', config: {} });
      results.push(await newSubdomainEvaluator.evaluate(makeCtx(event, rule)));
    }

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r).not.toBeNull();
      expect(r!.severity).toBe('medium');
    }
    expect(results[0]!.title).toContain('api-v2.example.com');
    expect(results[1]!.title).toContain('dashboard.example.com');
    expect(results[2]!.title).toContain('metrics.example.com');
  });
});
