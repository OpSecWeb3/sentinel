import { describe, it, expect } from 'vitest';
import { certExpiryEvaluator } from '../evaluators/cert-expiry.js';
import { certIssuesEvaluator } from '../evaluators/cert-issues.js';
import { tlsWeaknessEvaluator } from '../evaluators/tls-weakness.js';
import { dnsChangeEvaluator } from '../evaluators/dns-change.js';
import { headerMissingEvaluator } from '../evaluators/header-missing.js';
import { hostUnreachableEvaluator } from '../evaluators/host-unreachable.js';
import { scoreDegradationEvaluator } from '../evaluators/score-degradation.js';
import { newSubdomainEvaluator } from '../evaluators/new-subdomain.js';
import { whoisExpiryEvaluator } from '../evaluators/whois-expiry.js';
import { ctNewEntryEvaluator } from '../evaluators/ct-new-entry.js';
import type { EvalContext, NormalizedEvent, RuleRow } from '@sentinel/shared/rules';
import Redis from 'ioredis-mock';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const redis = new Redis();

let eventCounter = 0;

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  eventCounter++;
  return {
    id: `evt-${eventCounter}`,
    orgId: 'org-1',
    moduleId: 'infra',
    eventType: 'infra.cert.expiring',
    externalId: `scan-${eventCounter}`,
    payload: {},
    occurredAt: new Date('2026-03-27T12:00:00Z'),
    receivedAt: new Date('2026-03-27T12:00:01Z'),
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
  return { event, rule, redis: redis as any };
}

// ===========================================================================
// 1. Certificate Expiry Evaluator (14 tests)
// ===========================================================================

describe('certExpiryEvaluator - scenarios', () => {
  const baseCertPayload = {
    hostname: 'app.example.com',
    daysRemaining: 5,
    notAfter: '2026-04-01T00:00:00Z',
    subject: 'CN=app.example.com',
  };

  it('cert expires in 5 days - critical alert', async () => {
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

  it('cert expires in 10 days - high severity', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: { ...baseCertPayload, daysRemaining: 10 },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('cert expires in 25 days - medium severity', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: { ...baseCertPayload, daysRemaining: 25 },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });

  it('cert already expired (0 days) - critical', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expired',
      payload: {
        ...baseCertPayload,
        daysRemaining: 0,
        notAfter: '2026-03-27T00:00:00Z',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('expired');
  });

  it('cert expired -5 days ago - critical', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expired',
      payload: {
        ...baseCertPayload,
        daysRemaining: -5,
        notAfter: '2026-03-22T00:00:00Z',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('expired');
    expect(result!.description).toContain('expired on');
  });

  it('cert expires in 31 days (threshold 30) - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: { ...baseCertPayload, daysRemaining: 31 },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('custom threshold 90 days - catches cert at 60 days', async () => {
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
    expect(result!.description).toContain('threshold: 90d');
  });

  it('cert expires in 1 day - critical emergency', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: {
        ...baseCertPayload,
        daysRemaining: 1,
        notAfter: '2026-03-28T00:00:00Z',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('1 days');
  });

  it('multiple certs on same host produce separate alerts', async () => {
    const subjects = ['CN=app.example.com', 'CN=*.example.com'];
    const results = [];

    for (const subject of subjects) {
      const event = makeEvent({
        eventType: 'infra.cert.expiring',
        payload: { ...baseCertPayload, daysRemaining: 3, subject },
      });
      const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
      results.push(await certExpiryEvaluator.evaluate(makeCtx(event, rule)));
    }

    expect(results[0]).not.toBeNull();
    expect(results[1]).not.toBeNull();
    expect(results[0]!.description).toContain('CN=app.example.com');
    expect(results[1]!.description).toContain('CN=*.example.com');
  });

  it('alert includes subject and notAfter in description', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: {
        hostname: 'secure.example.com',
        daysRemaining: 14,
        notAfter: '2026-04-10T00:00:00Z',
        subject: 'CN=secure.example.com, O=Example Corp',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('CN=secure.example.com, O=Example Corp');
    expect(result!.description).toContain('2026-04-10T00:00:00Z');
  });

  it('wrong event type - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.issue',
      payload: { ...baseCertPayload, daysRemaining: 5 },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('cert on production API host', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: {
        hostname: 'api.prod.example.com',
        daysRemaining: 7,
        notAfter: '2026-04-03T00:00:00Z',
        subject: 'CN=api.prod.example.com',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('api.prod.example.com');
  });

  it('cert on staging host', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: {
        hostname: 'staging.example.com',
        daysRemaining: 12,
        notAfter: '2026-04-08T00:00:00Z',
        subject: 'CN=staging.example.com',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('wildcard cert about to expire', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: {
        hostname: '*.example.com',
        daysRemaining: 2,
        notAfter: '2026-03-29T00:00:00Z',
        subject: 'CN=*.example.com',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('*.example.com');
    expect(result!.description).toContain('CN=*.example.com');
  });
});

// ===========================================================================
// 2. Certificate Issues Evaluator (10 tests)
// ===========================================================================

describe('certIssuesEvaluator - scenarios', () => {
  it('self-signed cert detected - high', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.issue',
      payload: {
        hostname: 'dev.example.com',
        issueType: 'self_signed',
        detail: 'Certificate is self-signed and not trusted by standard CAs',
        subject: 'CN=dev.example.com',
        issuer: 'CN=dev.example.com',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_issues', config: {} });
    const result = await certIssuesEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('Self-signed');
    expect(result!.title).toContain('dev.example.com');
  });

  it('chain validation error - critical', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.issue',
      payload: {
        hostname: 'api.example.com',
        issueType: 'chain_error',
        detail: 'Unable to verify the first certificate in the chain',
        subject: 'CN=api.example.com',
        issuer: 'CN=Unknown CA',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_issues', config: {} });
    const result = await certIssuesEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('chain validation error');
  });

  it('revoked certificate - critical', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.issue',
      payload: {
        hostname: 'compromised.example.com',
        issueType: 'revoked',
        detail: 'Certificate has been revoked by the issuing CA due to key compromise',
        subject: 'CN=compromised.example.com',
        issuer: 'CN=DigiCert SHA2 Extended Validation Server CA',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_issues', config: {} });
    const result = await certIssuesEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('revoked');
  });

  it('weak key (1024-bit RSA) - high', async () => {
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

  it('SHA-1 signature - medium', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.issue',
      payload: {
        hostname: 'old.example.com',
        issueType: 'sha1_signature',
        detail: 'Certificate uses deprecated SHA-1 signature algorithm',
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

  it('filter by issueTypes - only watch chain_error', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.issue',
      payload: {
        hostname: 'app.example.com',
        issueType: 'chain_error',
        detail: 'Certificate chain is incomplete',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.cert_issues',
      config: { issueTypes: ['chain_error'] },
    });
    const result = await certIssuesEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('empty issueTypes = all types watched', async () => {
    const issueTypes = ['chain_error', 'self_signed', 'weak_key', 'sha1_signature', 'revoked'] as const;
    const results = [];

    for (const issueType of issueTypes) {
      const event = makeEvent({
        eventType: 'infra.cert.issue',
        payload: {
          hostname: 'test.example.com',
          issueType,
          detail: `Test ${issueType}`,
        },
      });
      const rule = makeRule({
        ruleType: 'infra.cert_issues',
        config: { issueTypes: [] },
      });
      results.push(await certIssuesEvaluator.evaluate(makeCtx(event, rule)));
    }

    for (const r of results) {
      expect(r).not.toBeNull();
    }
  });

  it('issue type not in filter - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.issue',
      payload: {
        hostname: 'old.example.com',
        issueType: 'sha1_signature',
        detail: 'SHA-1 signature detected',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.cert_issues',
      config: { issueTypes: ['self_signed', 'revoked'] },
    });
    const result = await certIssuesEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('alert includes detail and hostname', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.issue',
      payload: {
        hostname: 'web.example.com',
        issueType: 'weak_key',
        detail: 'RSA key is only 1024 bits, minimum recommended is 2048',
        subject: 'CN=web.example.com',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_issues', config: {} });
    const result = await certIssuesEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('web.example.com');
    expect(result!.description).toBe('RSA key is only 1024 bits, minimum recommended is 2048');
  });

  it('wrong event type - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        hostname: 'test.example.com',
        issueType: 'self_signed',
        detail: 'Self-signed',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_issues', config: {} });
    const result = await certIssuesEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// 3. TLS Weakness Evaluator (12 tests)
// ===========================================================================

describe('tlsWeaknessEvaluator - scenarios', () => {
  const baseTlsPayload = {
    hostname: 'app.example.com',
    hasTls10: false,
    hasTls11: false,
    hasTls13: true,
    hasWeakCiphers: false,
    weakCipherList: [] as string[],
    legacyVersions: [] as string[],
  };

  it('TLS 1.0 enabled - critical', async () => {
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

  it('TLS 1.1 only - critical', async () => {
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

  it('both TLS 1.0 and 1.1 - critical', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        ...baseTlsPayload,
        hasTls10: true,
        hasTls11: true,
        legacyVersions: ['TLS 1.0', 'TLS 1.1'],
      },
    });
    const rule = makeRule({ ruleType: 'infra.tls_weakness', config: {} });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('TLS 1.0');
    expect(result!.description).toContain('TLS 1.1');
  });

  it('weak ciphers (RC4, DES) - critical', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        ...baseTlsPayload,
        hasWeakCiphers: true,
        weakCipherList: ['TLS_RSA_WITH_RC4_128_SHA', 'TLS_RSA_WITH_DES_CBC_SHA'],
      },
    });
    const rule = makeRule({ ruleType: 'infra.tls_weakness', config: {} });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('Weak cipher suites');
    expect(result!.description).toContain('RC4');
  });

  it('missing TLS 1.3 only - medium (when alertOnMissingTls13=true)', async () => {
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

  it('modern config (only TLS 1.2/1.3) - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: baseTlsPayload,
    });
    const rule = makeRule({ ruleType: 'infra.tls_weakness', config: {} });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('alertOnLegacyVersions=false - ignores TLS 1.0', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        ...baseTlsPayload,
        hasTls10: true,
        legacyVersions: ['TLS 1.0'],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.tls_weakness',
      config: { alertOnLegacyVersions: false },
    });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('alertOnWeakCiphers=false - ignores weak ciphers', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        ...baseTlsPayload,
        hasWeakCiphers: true,
        weakCipherList: ['TLS_RSA_WITH_RC4_128_SHA'],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.tls_weakness',
      config: { alertOnWeakCiphers: false },
    });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('all checks disabled - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        ...baseTlsPayload,
        hasTls10: true,
        hasTls11: true,
        hasTls13: false,
        hasWeakCiphers: true,
        weakCipherList: ['TLS_RSA_WITH_RC4_128_SHA'],
        legacyVersions: ['TLS 1.0', 'TLS 1.1'],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.tls_weakness',
      config: {
        alertOnLegacyVersions: false,
        alertOnWeakCiphers: false,
        alertOnMissingTls13: false,
      },
    });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('multiple issues combined', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        ...baseTlsPayload,
        hasTls10: true,
        hasTls13: false,
        hasWeakCiphers: true,
        weakCipherList: ['TLS_RSA_WITH_3DES_EDE_CBC_SHA'],
        legacyVersions: ['TLS 1.0'],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.tls_weakness',
      config: { alertOnMissingTls13: true },
    });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('Legacy TLS versions');
    expect(result!.description).toContain('Weak cipher suites');
    expect(result!.description).toContain('TLS 1.3 not supported');
  });

  it('specific weak cipher names in description', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        ...baseTlsPayload,
        hasWeakCiphers: true,
        weakCipherList: [
          'TLS_RSA_WITH_RC4_128_SHA',
          'TLS_RSA_WITH_RC4_128_MD5',
          'TLS_RSA_WITH_3DES_EDE_CBC_SHA',
        ],
      },
    });
    const rule = makeRule({ ruleType: 'infra.tls_weakness', config: {} });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('TLS_RSA_WITH_RC4_128_SHA');
    expect(result!.description).toContain('TLS_RSA_WITH_RC4_128_MD5');
    expect(result!.description).toContain('TLS_RSA_WITH_3DES_EDE_CBC_SHA');
  });

  it('PCI-DSS compliance scenario (no TLS 1.0/1.1 allowed)', async () => {
    // Clean config: TLS 1.2+1.3 only, no weak ciphers, should pass
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        hostname: 'payments.example.com',
        hasTls10: false,
        hasTls11: false,
        hasTls13: true,
        hasWeakCiphers: false,
        weakCipherList: [],
        legacyVersions: [],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.tls_weakness',
      config: { alertOnMissingTls13: true },
    });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// 4. DNS Change Evaluator (12 tests)
// ===========================================================================

describe('dnsChangeEvaluator - scenarios', () => {
  it('A record changed (IP migration)', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'www.example.com',
        changes: [
          {
            recordType: 'A',
            changeType: 'modified',
            oldValue: '93.184.216.34',
            newValue: '198.51.100.10',
          },
        ],
      },
    });
    const rule = makeRule({ ruleType: 'infra.dns_change', config: {} });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('93.184.216.34');
    expect(result!.description).toContain('198.51.100.10');
  });

  it('NS record changed - critical (domain hijack?)', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          {
            recordType: 'NS',
            changeType: 'modified',
            oldValue: 'ns1.legit-dns.com',
            newValue: 'ns1.suspicious-dns.net',
          },
        ],
      },
    });
    const rule = makeRule({ ruleType: 'infra.dns_change', config: {} });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('MX record added (email routing change)', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          {
            recordType: 'MX',
            changeType: 'added',
            newValue: '10 mail.attacker.com',
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

  it('CNAME modified', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'cdn.example.com',
        changes: [
          {
            recordType: 'CNAME',
            changeType: 'modified',
            oldValue: 'cdn.cloudflare.com',
            newValue: 'cdn.othercdn.com',
          },
        ],
      },
    });
    const rule = makeRule({ ruleType: 'infra.dns_change', config: {} });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('CNAME');
  });

  it('multiple changes in one event', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          { recordType: 'A', changeType: 'modified', oldValue: '1.2.3.4', newValue: '5.6.7.8' },
          { recordType: 'AAAA', changeType: 'added', newValue: '2001:db8::1' },
          { recordType: 'TXT', changeType: 'removed', oldValue: 'v=spf1 include:old.com' },
        ],
      },
    });
    const rule = makeRule({ ruleType: 'infra.dns_change', config: {} });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('3 changes');
    expect(result!.severity).toBe('high');
  });

  it('filter by record type (only watch A/AAAA)', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          { recordType: 'TXT', changeType: 'modified', oldValue: 'old', newValue: 'new' },
          { recordType: 'MX', changeType: 'added', newValue: 'mail.example.com' },
        ],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.dns_change',
      config: { watchRecordTypes: ['A', 'AAAA'] },
    });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('filter by change type (only watch removed)', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          { recordType: 'A', changeType: 'added', newValue: '1.2.3.4' },
          { recordType: 'CNAME', changeType: 'modified', oldValue: 'old.com', newValue: 'new.com' },
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

  it('DNS takeover scenario (all records removed)', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          { recordType: 'A', changeType: 'removed', oldValue: '93.184.216.34' },
          { recordType: 'AAAA', changeType: 'removed', oldValue: '2606:2800:220:1:248:1893:25c8:1946' },
          { recordType: 'MX', changeType: 'removed', oldValue: '10 mail.example.com' },
          { recordType: 'NS', changeType: 'removed', oldValue: 'ns1.example.com' },
        ],
      },
    });
    const rule = makeRule({ ruleType: 'infra.dns_change', config: {} });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical'); // NS record present
    expect(result!.title).toContain('4 changes');
  });

  it('new CNAME pointing to attacker domain', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'login.example.com',
        changes: [
          {
            recordType: 'CNAME',
            changeType: 'modified',
            oldValue: 'login.example.com.cdn.cloudflare.net',
            newValue: 'phishing-example.evil.com',
          },
        ],
      },
    });
    const rule = makeRule({ ruleType: 'infra.dns_change', config: {} });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('phishing-example.evil.com');
  });

  it('changes not matching any filter - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          { recordType: 'TXT', changeType: 'added', newValue: 'v=spf1 include:new.com' },
        ],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.dns_change',
      config: { watchRecordTypes: ['A'], watchChangeTypes: ['removed'] },
    });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('empty filters = watch all', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          { recordType: 'SRV', changeType: 'added', newValue: '_sip._tcp.example.com' },
        ],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.dns_change',
      config: { watchRecordTypes: [], watchChangeTypes: [] },
    });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('change with critical severity flag', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [
          {
            recordType: 'A',
            changeType: 'modified',
            oldValue: '1.2.3.4',
            newValue: '5.6.7.8',
            severity: 'critical',
          },
        ],
      },
    });
    const rule = makeRule({ ruleType: 'infra.dns_change', config: {} });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });
});

// ===========================================================================
// 5. Missing Headers Evaluator (10 tests)
// ===========================================================================

describe('headerMissingEvaluator - scenarios', () => {
  it('HSTS missing - high severity', async () => {
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

  it('CSP missing - high severity', async () => {
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
    expect(result!.description).toContain('CSP');
  });

  it('both HSTS and CSP missing', async () => {
    const event = makeEvent({
      eventType: 'infra.header.missing',
      payload: {
        hostname: 'insecure.example.com',
        missingHeaders: ['HSTS', 'CSP'],
      },
    });
    const rule = makeRule({ ruleType: 'infra.header_missing', config: {} });
    const result = await headerMissingEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.description).toContain('HSTS');
    expect(result!.description).toContain('CSP');
  });

  it('only X-Frame-Options missing - medium', async () => {
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

  it('all headers present - no alert', async () => {
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

  it('custom requiredHeaders (only HSTS)', async () => {
    const event = makeEvent({
      eventType: 'infra.header.missing',
      payload: {
        hostname: 'app.example.com',
        missingHeaders: ['HSTS', 'CSP', 'X-Frame-Options'],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.header_missing',
      config: { requiredHeaders: ['HSTS'] },
    });
    const result = await headerMissingEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    // Only HSTS should be reported since that is the only required header
    expect(result!.triggerData).toEqual({
      hostname: 'app.example.com',
      missingHeaders: ['HSTS'],
    });
  });

  it('missing Referrer-Policy and Permissions-Policy - medium', async () => {
    const event = makeEvent({
      eventType: 'infra.header.missing',
      payload: {
        hostname: 'app.example.com',
        missingHeaders: ['Referrer-Policy', 'Permissions-Policy'],
      },
    });
    const rule = makeRule({ ruleType: 'infra.header_missing', config: {} });
    const result = await headerMissingEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.description).toContain('Referrer-Policy');
    expect(result!.description).toContain('Permissions-Policy');
  });

  it('production site missing HSTS (PCI requirement)', async () => {
    const event = makeEvent({
      eventType: 'infra.header.missing',
      payload: {
        hostname: 'checkout.example.com',
        missingHeaders: ['HSTS'],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.header_missing',
      config: { requiredHeaders: ['HSTS'] },
    });
    const result = await headerMissingEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('checkout.example.com');
  });

  it('requiredHeaders case insensitive matching', async () => {
    const event = makeEvent({
      eventType: 'infra.header.missing',
      payload: {
        hostname: 'app.example.com',
        missingHeaders: ['hsts'],
      },
    });
    const rule = makeRule({
      ruleType: 'infra.header_missing',
      config: { requiredHeaders: ['HSTS'] },
    });
    const result = await headerMissingEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('wrong event type - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        hostname: 'app.example.com',
        missingHeaders: ['HSTS', 'CSP'],
      },
    });
    const rule = makeRule({ ruleType: 'infra.header_missing', config: {} });
    const result = await headerMissingEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// 6. Host Unreachable Evaluator (10 tests)
// ===========================================================================

describe('hostUnreachableEvaluator - scenarios', () => {
  it('host down 3 consecutive failures (threshold=2) - fires', async () => {
    const event = makeEvent({
      eventType: 'infra.host.unreachable',
      payload: {
        hostname: 'api.example.com',
        consecutiveFailures: 3,
        isReachable: false,
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('unreachable');
    expect(result!.description).toContain('3 consecutive');
  });

  it('host down 1 failure (threshold=2) - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.host.unreachable',
      payload: {
        hostname: 'flaky.example.com',
        consecutiveFailures: 1,
        isReachable: false,
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('slow response 6000ms (threshold=5000ms) - fires', async () => {
    const event = makeEvent({
      eventType: 'infra.host.slow',
      payload: {
        hostname: 'slow.example.com',
        responseTimeMs: 6000,
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
    expect(result!.title).toContain('Slow response');
    expect(result!.description).toContain('6000ms');
  });

  it('response 4000ms (threshold=5000ms) - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.host.slow',
      payload: {
        hostname: 'ok.example.com',
        responseTimeMs: 4000,
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('DNS resolution failed', async () => {
    const event = makeEvent({
      eventType: 'infra.host.unreachable',
      payload: {
        hostname: 'ghost.example.com',
        consecutiveFailures: 5,
        isReachable: false,
        dnsResolved: false,
        errorMessage: 'NXDOMAIN: Domain does not exist',
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('NXDOMAIN');
  });

  it('HTTP 500 error', async () => {
    const event = makeEvent({
      eventType: 'infra.host.unreachable',
      payload: {
        hostname: 'broken.example.com',
        consecutiveFailures: 3,
        isReachable: false,
        dnsResolved: true,
        httpStatus: 500,
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('HTTP 500');
  });

  it('connection timeout with error message', async () => {
    const event = makeEvent({
      eventType: 'infra.host.unreachable',
      payload: {
        hostname: 'timeout.example.com',
        consecutiveFailures: 4,
        isReachable: false,
        dnsResolved: true,
        errorMessage: 'ETIMEDOUT: Connection timed out after 30000ms',
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('ETIMEDOUT');
  });

  it('production API unreachable - critical', async () => {
    const event = makeEvent({
      eventType: 'infra.host.unreachable',
      payload: {
        hostname: 'api.prod.example.com',
        consecutiveFailures: 10,
        isReachable: false,
        dnsResolved: true,
        errorMessage: 'Connection refused',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.host_unreachable',
      config: { consecutiveFailures: 5 },
    });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('api.prod.example.com');
    expect(result!.description).toContain('10 consecutive');
  });

  it('alert includes consecutive failure count', async () => {
    const event = makeEvent({
      eventType: 'infra.host.unreachable',
      payload: {
        hostname: 'down.example.com',
        consecutiveFailures: 7,
        isReachable: false,
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('7 consecutive');
  });

  it('non-unreachable event type - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: {
        hostname: 'app.example.com',
        consecutiveFailures: 10,
        isReachable: false,
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: {} });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// 7. Score Degradation Evaluator (10 tests)
// ===========================================================================

describe('scoreDegradationEvaluator - scenarios', () => {
  it('score drops from 85 to 40 (mode=both) - critical', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 40,
        previousScore: 85,
        grade: 'F',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'both', minScore: 70, minDrop: 10 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('below threshold');
    expect(result!.description).toContain('dropped 45 points');
  });

  it('score 65 below threshold 70 (mode=below)', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 65,
        previousScore: 68,
        grade: 'D',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'below', minScore: 70 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('below threshold 70');
  });

  it('score drops 15 points (mode=drop, minDrop=10)', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 75,
        previousScore: 90,
        grade: 'C',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'drop', minDrop: 10 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('dropped 15 points');
  });

  it('score unchanged - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 85,
        previousScore: 85,
        grade: 'B',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'both', minScore: 70, minDrop: 10 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('score increased - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 90,
        previousScore: 80,
        grade: 'A',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'both', minScore: 70, minDrop: 10 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('mode=below, score above threshold - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 75,
        previousScore: 90,
        grade: 'C',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'below', minScore: 70 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('mode=drop, small drop (5 < minDrop=10) - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 80,
        previousScore: 85,
        grade: 'B',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'drop', minDrop: 10 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('first scan (previousScore=null) - only below check applies', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'new.example.com',
        currentScore: 55,
        previousScore: null,
        grade: 'F',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'both', minScore: 70, minDrop: 10 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('below threshold');
    // Should not contain "dropped" since previousScore is null
    expect(result!.description).not.toContain('dropped');
  });

  it('score 49 - critical severity (< 50)', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'bad.example.com',
        currentScore: 49,
        previousScore: 55,
        grade: 'F',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'below', minScore: 70 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('drop of 20+ points - critical severity', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'degraded.example.com',
        currentScore: 60,
        previousScore: 82,
        grade: 'D',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'drop', minDrop: 10 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.description).toContain('dropped 22 points');
  });
});

// ===========================================================================
// 8. New Subdomain Evaluator (8 tests)
// ===========================================================================

describe('newSubdomainEvaluator - scenarios', () => {
  it('new subdomain discovered via CT log', async () => {
    const event = makeEvent({
      eventType: 'infra.subdomain.discovered',
      payload: {
        parentHostname: 'example.com',
        subdomain: 'secret-api.example.com',
        source: 'crt_sh',
      },
    });
    const rule = makeRule({ ruleType: 'infra.new_subdomain', config: {} });
    const result = await newSubdomainEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.title).toContain('secret-api.example.com');
    expect(result!.description).toContain('crt_sh');
  });

  it('subdomain matching ignore pattern (staging-*)', async () => {
    const event = makeEvent({
      eventType: 'infra.subdomain.discovered',
      payload: {
        parentHostname: 'example.com',
        subdomain: 'staging-v3.example.com',
        source: 'dns_zone',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.new_subdomain',
      config: { ignorePatterns: ['staging-*'] },
    });
    const result = await newSubdomainEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('subdomain not matching ignore - fires', async () => {
    const event = makeEvent({
      eventType: 'infra.subdomain.discovered',
      payload: {
        parentHostname: 'example.com',
        subdomain: 'prod-api.example.com',
        source: 'brute_force',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.new_subdomain',
      config: { ignorePatterns: ['staging-*', 'test-*'] },
    });
    const result = await newSubdomainEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('prod-api.example.com');
  });

  it('wildcard ignore *.internal', async () => {
    const event = makeEvent({
      eventType: 'infra.subdomain.discovered',
      payload: {
        parentHostname: 'example.com',
        subdomain: 'db.internal',
        source: 'dns_zone',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.new_subdomain',
      config: { ignorePatterns: ['*.internal'] },
    });
    const result = await newSubdomainEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('multiple ignore patterns', async () => {
    const event = makeEvent({
      eventType: 'infra.subdomain.discovered',
      payload: {
        parentHostname: 'example.com',
        subdomain: 'test-deploy.example.com',
        source: 'crt_sh',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.new_subdomain',
      config: { ignorePatterns: ['staging-*', 'test-*', '*.internal'] },
    });
    const result = await newSubdomainEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('typosquatting subdomain detection', async () => {
    const event = makeEvent({
      eventType: 'infra.subdomain.discovered',
      payload: {
        parentHostname: 'example.com',
        subdomain: 'examp1e-login.example.com',
        source: 'crt_sh',
      },
    });
    const rule = makeRule({ ruleType: 'infra.new_subdomain', config: {} });
    const result = await newSubdomainEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.title).toContain('examp1e-login.example.com');
  });

  it('suspicious subdomain (admin.*)', async () => {
    const event = makeEvent({
      eventType: 'infra.subdomain.discovered',
      payload: {
        parentHostname: 'example.com',
        subdomain: 'admin.example.com',
        source: 'brute_force',
      },
    });
    const rule = makeRule({ ruleType: 'infra.new_subdomain', config: {} });
    const result = await newSubdomainEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.title).toContain('admin.example.com');
    expect(result!.description).toContain('brute_force');
  });

  it('wrong event type - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        parentHostname: 'example.com',
        subdomain: 'new.example.com',
        source: 'crt_sh',
      },
    });
    const rule = makeRule({ ruleType: 'infra.new_subdomain', config: {} });
    const result = await newSubdomainEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// 9. WHOIS Expiry Evaluator (8 tests)
// ===========================================================================

describe('whoisExpiryEvaluator - scenarios', () => {
  const baseWhoisPayload = {
    hostname: 'example.com',
    daysRemaining: 5,
    expiryDate: '2026-04-01T00:00:00Z',
    registrar: 'GoDaddy, LLC',
  };

  it('domain expires in 5 days - critical', async () => {
    const event = makeEvent({
      eventType: 'infra.whois.expiring',
      payload: { ...baseWhoisPayload, daysRemaining: 5 },
    });
    const rule = makeRule({ ruleType: 'infra.whois_expiry', config: {} });
    const result = await whoisExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('5 days');
  });

  it('domain expires in 10 days - high', async () => {
    const event = makeEvent({
      eventType: 'infra.whois.expiring',
      payload: { ...baseWhoisPayload, daysRemaining: 10 },
    });
    const rule = makeRule({ ruleType: 'infra.whois_expiry', config: {} });
    const result = await whoisExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('domain expires in 25 days - medium', async () => {
    const event = makeEvent({
      eventType: 'infra.whois.expiring',
      payload: { ...baseWhoisPayload, daysRemaining: 25 },
    });
    const rule = makeRule({ ruleType: 'infra.whois_expiry', config: {} });
    const result = await whoisExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });

  it('domain expires in 35 days (threshold=30) - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.whois.expiring',
      payload: { ...baseWhoisPayload, daysRemaining: 35 },
    });
    const rule = makeRule({ ruleType: 'infra.whois_expiry', config: {} });
    const result = await whoisExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('custom threshold 90 days - catches domain at 60 days', async () => {
    const event = makeEvent({
      eventType: 'infra.whois.expiring',
      payload: { ...baseWhoisPayload, daysRemaining: 60 },
    });
    const rule = makeRule({
      ruleType: 'infra.whois_expiry',
      config: { thresholdDays: 90 },
    });
    const result = await whoisExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.description).toContain('threshold: 90d');
  });

  it('alert includes registrar name', async () => {
    const event = makeEvent({
      eventType: 'infra.whois.expiring',
      payload: {
        hostname: 'mysite.com',
        daysRemaining: 14,
        expiryDate: '2026-04-10T00:00:00Z',
        registrar: 'Namecheap, Inc.',
      },
    });
    const rule = makeRule({ ruleType: 'infra.whois_expiry', config: {} });
    const result = await whoisExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('Namecheap, Inc.');
  });

  it('domain expires tomorrow - critical emergency', async () => {
    const event = makeEvent({
      eventType: 'infra.whois.expiring',
      payload: {
        hostname: 'important.com',
        daysRemaining: 1,
        expiryDate: '2026-03-28T00:00:00Z',
        registrar: 'Cloudflare, Inc.',
      },
    });
    const rule = makeRule({ ruleType: 'infra.whois_expiry', config: {} });
    const result = await whoisExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
    expect(result!.title).toContain('1 days');
  });

  it('wrong event type - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: { ...baseWhoisPayload, daysRemaining: 5 },
    });
    const rule = makeRule({ ruleType: 'infra.whois_expiry', config: {} });
    const result = await whoisExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// 10. CT New Entry Evaluator (6 tests)
// ===========================================================================

describe('ctNewEntryEvaluator - scenarios', () => {
  const baseCtPayload = {
    hostname: 'example.com',
    issuerName: 'DigiCert SHA2 Extended Validation Server CA',
    commonName: 'www.example.com',
    nameValue: 'www.example.com',
    serialNumber: 'AB:CD:EF:01:23:45:67:89',
    notBefore: '2026-03-01T00:00:00Z',
    notAfter: '2027-03-01T00:00:00Z',
    entryTimestamp: '2026-03-27T10:00:00Z',
  };

  it('new cert logged for monitored domain', async () => {
    const event = makeEvent({
      eventType: 'infra.ct.new_entry',
      payload: baseCtPayload,
    });
    const rule = makeRule({ ruleType: 'infra.ct_new_entry', config: {} });
    const result = await ctNewEntryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.title).toContain('example.com');
    expect(result!.title).toContain('www.example.com');
    expect(result!.description).toContain('DigiCert');
  });

  it('issuer matches ignore pattern (Let\'s Encrypt*) - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.ct.new_entry',
      payload: {
        ...baseCtPayload,
        issuerName: "Let's Encrypt Authority X3",
      },
    });
    const rule = makeRule({
      ruleType: 'infra.ct_new_entry',
      config: { ignorePatterns: ["Let's Encrypt*"] },
    });
    const result = await ctNewEntryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('unknown issuer - fires alert', async () => {
    const event = makeEvent({
      eventType: 'infra.ct.new_entry',
      payload: {
        ...baseCtPayload,
        issuerName: 'Unknown Suspicious CA',
        commonName: 'login.example.com',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.ct_new_entry',
      config: { ignorePatterns: ["Let's Encrypt*", 'DigiCert*'] },
    });
    const result = await ctNewEntryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
    expect(result!.description).toContain('Unknown Suspicious CA');
  });

  it('multiple ignore patterns', async () => {
    const event = makeEvent({
      eventType: 'infra.ct.new_entry',
      payload: {
        ...baseCtPayload,
        issuerName: 'Amazon RSA 2048 M01',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.ct_new_entry',
      config: { ignorePatterns: ["Let's Encrypt*", 'DigiCert*', 'Amazon*'] },
    });
    const result = await ctNewEntryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('alert includes issuer and common name', async () => {
    const event = makeEvent({
      eventType: 'infra.ct.new_entry',
      payload: {
        ...baseCtPayload,
        issuerName: 'Sectigo RSA Domain Validation Secure Server CA',
        commonName: 'api.example.com',
      },
    });
    const rule = makeRule({ ruleType: 'infra.ct_new_entry', config: {} });
    const result = await ctNewEntryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('api.example.com');
    expect(result!.description).toContain('Sectigo RSA Domain Validation Secure Server CA');
    expect(result!.description).toContain('api.example.com');
  });

  it('wrong event type - no alert', async () => {
    const event = makeEvent({
      eventType: 'infra.subdomain.discovered',
      payload: baseCtPayload,
    });
    const rule = makeRule({ ruleType: 'infra.ct_new_entry', config: {} });
    const result = await ctNewEntryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });
});

// ===========================================================================
// Cross-cutting / integration-style scenario tests
// ===========================================================================

describe('cross-cutting scenarios', () => {
  it('all evaluators return null for completely unrelated event type', async () => {
    const event = makeEvent({
      eventType: 'github.push',
      payload: { ref: 'refs/heads/main' },
    });

    const evaluators = [
      certExpiryEvaluator,
      certIssuesEvaluator,
      tlsWeaknessEvaluator,
      dnsChangeEvaluator,
      headerMissingEvaluator,
      hostUnreachableEvaluator,
      scoreDegradationEvaluator,
      newSubdomainEvaluator,
      whoisExpiryEvaluator,
      ctNewEntryEvaluator,
    ];

    for (const evaluator of evaluators) {
      const rule = makeRule({ ruleType: evaluator.ruleType, config: {} });
      const result = await evaluator.evaluate(makeCtx(event, rule));
      expect(result).toBeNull();
    }
  });

  it('all evaluators set correct orgId from event', async () => {
    const orgId = 'org-custom-123';

    // cert expiry
    const certEvent = makeEvent({
      orgId,
      eventType: 'infra.cert.expiring',
      payload: {
        hostname: 'x.com',
        daysRemaining: 5,
        notAfter: '2026-04-01',
        subject: 'CN=x.com',
      },
    });
    const certRule = makeRule({ orgId, ruleType: 'infra.cert_expiry', config: {} });
    const certResult = await certExpiryEvaluator.evaluate(makeCtx(certEvent, certRule));
    expect(certResult!.orgId).toBe(orgId);

    // host unreachable
    const hostEvent = makeEvent({
      orgId,
      eventType: 'infra.host.unreachable',
      payload: {
        hostname: 'x.com',
        consecutiveFailures: 5,
        isReachable: false,
      },
    });
    const hostRule = makeRule({ orgId, ruleType: 'infra.host_unreachable', config: {} });
    const hostResult = await hostUnreachableEvaluator.evaluate(makeCtx(hostEvent, hostRule));
    expect(hostResult!.orgId).toBe(orgId);
  });

  it('all evaluators set triggerType to immediate', async () => {
    // cert expiry
    const e1 = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: { hostname: 'h', daysRemaining: 1, notAfter: 'x', subject: 'x' },
    });
    const r1 = await certExpiryEvaluator.evaluate(makeCtx(e1, makeRule({ ruleType: 'infra.cert_expiry' })));
    expect(r1!.triggerType).toBe('immediate');

    // cert issues
    const e2 = makeEvent({
      eventType: 'infra.cert.issue',
      payload: { hostname: 'h', issueType: 'revoked', detail: 'd' },
    });
    const r2 = await certIssuesEvaluator.evaluate(makeCtx(e2, makeRule({ ruleType: 'infra.cert_issues' })));
    expect(r2!.triggerType).toBe('immediate');

    // tls weakness
    const e3 = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: { hostname: 'h', hasTls10: true, hasTls11: false, hasTls13: true, hasWeakCiphers: false, weakCipherList: [], legacyVersions: ['TLS 1.0'] },
    });
    const r3 = await tlsWeaknessEvaluator.evaluate(makeCtx(e3, makeRule({ ruleType: 'infra.tls_weakness' })));
    expect(r3!.triggerType).toBe('immediate');

    // dns change
    const e4 = makeEvent({
      eventType: 'infra.dns.change',
      payload: { hostname: 'h', changes: [{ recordType: 'A', changeType: 'added', newValue: '1.2.3.4' }] },
    });
    const r4 = await dnsChangeEvaluator.evaluate(makeCtx(e4, makeRule({ ruleType: 'infra.dns_change' })));
    expect(r4!.triggerType).toBe('immediate');

    // header missing
    const e5 = makeEvent({
      eventType: 'infra.header.missing',
      payload: { hostname: 'h', missingHeaders: ['HSTS'] },
    });
    const r5 = await headerMissingEvaluator.evaluate(makeCtx(e5, makeRule({ ruleType: 'infra.header_missing' })));
    expect(r5!.triggerType).toBe('immediate');
  });

  it('all evaluators preserve detectionId and ruleId from rule', async () => {
    const detectionId = 'det-custom-abc';
    const ruleId = 'rule-custom-xyz';

    const event = makeEvent({
      eventType: 'infra.whois.expiring',
      payload: {
        hostname: 'example.com',
        daysRemaining: 3,
        expiryDate: '2026-03-30',
        registrar: 'Reg Inc',
      },
    });
    const rule = makeRule({
      id: ruleId,
      detectionId,
      ruleType: 'infra.whois_expiry',
      config: {},
    });
    const result = await whoisExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result!.detectionId).toBe(detectionId);
    expect(result!.ruleId).toBe(ruleId);
  });

  it('all evaluators have correct moduleId', () => {
    const evaluators = [
      certExpiryEvaluator,
      certIssuesEvaluator,
      tlsWeaknessEvaluator,
      dnsChangeEvaluator,
      headerMissingEvaluator,
      hostUnreachableEvaluator,
      scoreDegradationEvaluator,
      newSubdomainEvaluator,
      whoisExpiryEvaluator,
      ctNewEntryEvaluator,
    ];

    for (const evaluator of evaluators) {
      expect(evaluator.moduleId).toBe('infra');
    }
  });

  it('all evaluators have unique ruleType values', () => {
    const evaluators = [
      certExpiryEvaluator,
      certIssuesEvaluator,
      tlsWeaknessEvaluator,
      dnsChangeEvaluator,
      headerMissingEvaluator,
      hostUnreachableEvaluator,
      scoreDegradationEvaluator,
      newSubdomainEvaluator,
      whoisExpiryEvaluator,
      ctNewEntryEvaluator,
    ];

    const ruleTypes = evaluators.map((e) => e.ruleType);
    const unique = new Set(ruleTypes);
    expect(unique.size).toBe(ruleTypes.length);
  });

  it('CT log entry with null issuerName is not filtered and shows unknown', async () => {
    const event = makeEvent({
      eventType: 'infra.ct.new_entry',
      payload: {
        hostname: 'example.com',
        issuerName: null,
        commonName: 'example.com',
        nameValue: null,
        serialNumber: null,
        notBefore: null,
        notAfter: null,
        entryTimestamp: null,
      },
    });
    const rule = makeRule({
      ruleType: 'infra.ct_new_entry',
      config: { ignorePatterns: ["Let's Encrypt*"] },
    });
    const result = await ctNewEntryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('unknown');
  });

  it('CT log entry with null commonName falls back to nameValue', async () => {
    const event = makeEvent({
      eventType: 'infra.ct.new_entry',
      payload: {
        hostname: 'example.com',
        issuerName: 'Some CA',
        commonName: null,
        nameValue: 'alt.example.com',
        serialNumber: null,
        notBefore: null,
        notAfter: null,
        entryTimestamp: null,
      },
    });
    const rule = makeRule({ ruleType: 'infra.ct_new_entry', config: {} });
    const result = await ctNewEntryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('alt.example.com');
  });

  it('whois expiry with null registrar omits registrar from description', async () => {
    const event = makeEvent({
      eventType: 'infra.whois.expiring',
      payload: {
        hostname: 'example.com',
        daysRemaining: 7,
        expiryDate: '2026-04-03T00:00:00Z',
        registrar: null,
      },
    });
    const rule = makeRule({ ruleType: 'infra.whois_expiry', config: {} });
    const result = await whoisExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).not.toContain('Registrar');
  });

  it('cert expiry boundary: exactly 7 days remaining is critical', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: {
        hostname: 'boundary.example.com',
        daysRemaining: 7,
        notAfter: '2026-04-03T00:00:00Z',
        subject: 'CN=boundary.example.com',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('cert expiry boundary: exactly 14 days remaining is high', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: {
        hostname: 'boundary.example.com',
        daysRemaining: 14,
        notAfter: '2026-04-10T00:00:00Z',
        subject: 'CN=boundary.example.com',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('cert expiry boundary: exactly 30 days remaining is medium', async () => {
    const event = makeEvent({
      eventType: 'infra.cert.expiring',
      payload: {
        hostname: 'boundary.example.com',
        daysRemaining: 30,
        notAfter: '2026-04-26T00:00:00Z',
        subject: 'CN=boundary.example.com',
      },
    });
    const rule = makeRule({ ruleType: 'infra.cert_expiry', config: {} });
    const result = await certExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('medium');
  });

  it('whois expiry boundary: exactly 7 days is critical', async () => {
    const event = makeEvent({
      eventType: 'infra.whois.expiring',
      payload: {
        hostname: 'example.com',
        daysRemaining: 7,
        expiryDate: '2026-04-03T00:00:00Z',
        registrar: 'Reg Inc',
      },
    });
    const rule = makeRule({ ruleType: 'infra.whois_expiry', config: {} });
    const result = await whoisExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('whois expiry boundary: exactly 14 days is high', async () => {
    const event = makeEvent({
      eventType: 'infra.whois.expiring',
      payload: {
        hostname: 'example.com',
        daysRemaining: 14,
        expiryDate: '2026-04-10T00:00:00Z',
        registrar: 'Reg Inc',
      },
    });
    const rule = makeRule({ ruleType: 'infra.whois_expiry', config: {} });
    const result = await whoisExpiryEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('host unreachable: exactly at threshold fires', async () => {
    const event = makeEvent({
      eventType: 'infra.host.unreachable',
      payload: {
        hostname: 'edge.example.com',
        consecutiveFailures: 2,
        isReachable: false,
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: { consecutiveFailures: 2 } });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('host slow: exactly at threshold fires', async () => {
    const event = makeEvent({
      eventType: 'infra.host.slow',
      payload: {
        hostname: 'edge.example.com',
        responseTimeMs: 5000,
      },
    });
    const rule = makeRule({ ruleType: 'infra.host_unreachable', config: { thresholdMs: 5000 } });
    const result = await hostUnreachableEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('score degradation: drop of exactly 20 is critical', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 60,
        previousScore: 80,
        grade: 'D',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'drop', minDrop: 10 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('critical');
  });

  it('score degradation: score exactly 50 is high (not critical)', async () => {
    const event = makeEvent({
      eventType: 'infra.score.degraded',
      payload: {
        hostname: 'example.com',
        currentScore: 50,
        previousScore: 55,
        grade: 'F',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.score_degradation',
      config: { mode: 'below', minScore: 70 },
    });
    const result = await scoreDegradationEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.severity).toBe('high');
  });

  it('new subdomain: wildcard pattern * matches everything', async () => {
    const event = makeEvent({
      eventType: 'infra.subdomain.discovered',
      payload: {
        parentHostname: 'example.com',
        subdomain: 'anything-at-all.example.com',
        source: 'crt_sh',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.new_subdomain',
      config: { ignorePatterns: ['*'] },
    });
    const result = await newSubdomainEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('new subdomain: middle wildcard pattern *keyword* matches substring', async () => {
    const event = makeEvent({
      eventType: 'infra.subdomain.discovered',
      payload: {
        parentHostname: 'example.com',
        subdomain: 'my-staging-server.example.com',
        source: 'dns_zone',
      },
    });
    const rule = makeRule({
      ruleType: 'infra.new_subdomain',
      config: { ignorePatterns: ['*staging*'] },
    });
    const result = await newSubdomainEvaluator.evaluate(makeCtx(event, rule));

    expect(result).toBeNull();
  });

  it('dns change: single A record added shows singular "change" in title', async () => {
    const event = makeEvent({
      eventType: 'infra.dns.change',
      payload: {
        hostname: 'example.com',
        changes: [{ recordType: 'A', changeType: 'added', newValue: '1.2.3.4' }],
      },
    });
    const rule = makeRule({ ruleType: 'infra.dns_change', config: {} });
    const result = await dnsChangeEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.title).toContain('1 change)');
    expect(result!.title).not.toContain('changes)');
  });

  it('tls weakness: empty weak cipher list still shows detected', async () => {
    const event = makeEvent({
      eventType: 'infra.tls.weakness',
      payload: {
        hostname: 'app.example.com',
        hasTls10: false,
        hasTls11: false,
        hasTls13: true,
        hasWeakCiphers: true,
        weakCipherList: [],
        legacyVersions: [],
      },
    });
    const rule = makeRule({ ruleType: 'infra.tls_weakness', config: {} });
    const result = await tlsWeaknessEvaluator.evaluate(makeCtx(event, rule));

    expect(result).not.toBeNull();
    expect(result!.description).toContain('detected');
  });
});
