/**
 * Infra Module E2E Tests
 *
 * Integration tests that exercise infrastructure security evaluators against a
 * real Postgres DB and Redis instance via the RuleEngine. Covers certificate
 * expiry, certificate issues, host unreachable, DNS changes, subdomain
 * discovery, TLS weaknesses, WHOIS expiry, and score degradation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTestDb,
  getTestRedis,
  cleanTables,
  resetCounters,
  createTestUser,
  createTestOrg,
  addMembership,
  createTestDetection,
  createTestRule,
  createTestEvent,
} from '../../test/helpers/setup.js';

import { RuleEngine } from '@sentinel/shared/rule-engine';
import type { NormalizedEvent, RuleEvaluator } from '@sentinel/shared/rules';
import { certExpiryEvaluator } from '../../modules/infra/src/evaluators/cert-expiry.js';
import { certIssuesEvaluator } from '../../modules/infra/src/evaluators/cert-issues.js';
import { hostUnreachableEvaluator } from '../../modules/infra/src/evaluators/host-unreachable.js';
import { dnsChangeEvaluator } from '../../modules/infra/src/evaluators/dns-change.js';
import { newSubdomainEvaluator } from '../../modules/infra/src/evaluators/new-subdomain.js';
import { tlsWeaknessEvaluator } from '../../modules/infra/src/evaluators/tls-weakness.js';
import { whoisExpiryEvaluator } from '../../modules/infra/src/evaluators/whois-expiry.js';
import { scoreDegradationEvaluator } from '../../modules/infra/src/evaluators/score-degradation.js';

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

  user = await createTestUser({ username: 'infra-module-tester' });
  org = await createTestOrg({ name: 'Infra Module Org', slug: 'infra-module-org' });
  await addMembership(org.id, user.id, 'admin');
});

// ==========================================================================
// 1. Certificate Expiry Boundary
// ==========================================================================

describe('Certificate Expiry Boundary', () => {
  it('should alert when daysRemaining equals thresholdDays (30 == 30)', async () => {
    const evaluators = buildRegistry(certExpiryEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Cert Expiry Monitor',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.cert_expiry',
      config: { thresholdDays: 30 },
      action: 'alert',
    });

    const payload = {
      hostname: 'example.com',
      daysRemaining: 30,
      notAfter: '2026-04-27T00:00:00Z',
      subject: 'example.com',
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.cert.expiring',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert when daysRemaining exceeds thresholdDays (31 > 30)', async () => {
    const evaluators = buildRegistry(certExpiryEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Cert Expiry Monitor',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.cert_expiry',
      config: { thresholdDays: 30 },
      action: 'alert',
    });

    const payload = {
      hostname: 'example.com',
      daysRemaining: 31,
      notAfter: '2026-04-28T00:00:00Z',
      subject: 'example.com',
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.cert.expiring',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });

  it('should alert when daysRemaining is below thresholdDays (29 < 30)', async () => {
    const evaluators = buildRegistry(certExpiryEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Cert Expiry Monitor',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.cert_expiry',
      config: { thresholdDays: 30 },
      action: 'alert',
    });

    const payload = {
      hostname: 'example.com',
      daysRemaining: 29,
      notAfter: '2026-04-26T00:00:00Z',
      subject: 'example.com',
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.cert.expiring',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });
});

// ==========================================================================
// 2. Certificate Issue - Self-Signed
// ==========================================================================

describe('Certificate Issue - Self-Signed', () => {
  it('should alert on self_signed when issueTypes is empty (all issues)', async () => {
    const evaluators = buildRegistry(certIssuesEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Cert Issues Monitor',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.cert_issues',
      config: { issueTypes: [] },
      action: 'alert',
    });

    const payload = {
      hostname: 'example.com',
      issueType: 'self_signed',
      detail: 'Certificate is self-signed',
      issuer: 'example.com',
      subject: 'example.com',
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.cert.issue',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert on self_signed when issueTypes only includes weak_key', async () => {
    const evaluators = buildRegistry(certIssuesEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Cert Issues Monitor',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.cert_issues',
      config: { issueTypes: ['weak_key'] },
      action: 'alert',
    });

    const payload = {
      hostname: 'example.com',
      issueType: 'self_signed',
      detail: 'Certificate is self-signed',
      issuer: 'example.com',
      subject: 'example.com',
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.cert.issue',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});

// ==========================================================================
// 3. Host Unreachable - Consecutive Failures
// ==========================================================================

describe('Host Unreachable - Consecutive Failures', () => {
  it('should NOT alert when consecutiveFailures is below threshold (2 < 3)', async () => {
    const evaluators = buildRegistry(hostUnreachableEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Host Unreachable Monitor',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.host_unreachable',
      config: { consecutiveFailures: 3, thresholdMs: 1000 },
      action: 'alert',
    });

    const payload = {
      hostname: 'api.example.com',
      consecutiveFailures: 2,
      isReachable: false,
      errorMessage: 'Connection refused',
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.host.unreachable',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });

  it('should alert when consecutiveFailures meets threshold (3 == 3)', async () => {
    const evaluators = buildRegistry(hostUnreachableEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Host Unreachable Monitor',
      severity: 'critical',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.host_unreachable',
      config: { consecutiveFailures: 3, thresholdMs: 1000 },
      action: 'alert',
    });

    const payload = {
      hostname: 'api.example.com',
      consecutiveFailures: 3,
      isReachable: false,
      errorMessage: 'Connection refused',
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.host.unreachable',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });
});

// ==========================================================================
// 4. Host Slow But Reachable
// ==========================================================================

describe('Host Slow But Reachable', () => {
  it('should alert when responseTimeMs exceeds thresholdMs (600 > 500)', async () => {
    const evaluators = buildRegistry(hostUnreachableEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Host Slow Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.host_unreachable',
      config: { thresholdMs: 500, consecutiveFailures: 1 },
      action: 'alert',
    });

    const payload = {
      hostname: 'api.example.com',
      responseTimeMs: 600,
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.host.slow',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert when responseTimeMs is below thresholdMs (400 < 500)', async () => {
    const evaluators = buildRegistry(hostUnreachableEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Host Slow Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.host_unreachable',
      config: { thresholdMs: 500, consecutiveFailures: 1 },
      action: 'alert',
    });

    const payload = {
      hostname: 'api.example.com',
      responseTimeMs: 400,
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.host.slow',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});

// ==========================================================================
// 5. DNS Record Change Detection
// ==========================================================================

describe('DNS Record Change Detection', () => {
  it('should alert when recordType and changeType both match config', async () => {
    const evaluators = buildRegistry(dnsChangeEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'DNS Change Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.dns_change',
      config: { watchRecordTypes: ['A', 'CNAME'], watchChangeTypes: ['modified', 'added'] },
      action: 'alert',
    });

    const payload = {
      hostname: 'example.com',
      changes: [
        { recordType: 'A', changeType: 'modified', oldValue: '1.2.3.4', newValue: '5.6.7.8' },
      ],
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.dns.change',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert when recordType is not in watchRecordTypes (MX)', async () => {
    const evaluators = buildRegistry(dnsChangeEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'DNS Change Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.dns_change',
      config: { watchRecordTypes: ['A', 'CNAME'], watchChangeTypes: ['modified', 'added'] },
      action: 'alert',
    });

    const payload = {
      hostname: 'example.com',
      changes: [
        { recordType: 'MX', changeType: 'modified', oldValue: 'mail1.example.com', newValue: 'mail2.example.com' },
      ],
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.dns.change',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });

  it('should NOT alert when changeType is not in watchChangeTypes (removed)', async () => {
    const evaluators = buildRegistry(dnsChangeEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'DNS Change Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.dns_change',
      config: { watchRecordTypes: ['A', 'CNAME'], watchChangeTypes: ['modified', 'added'] },
      action: 'alert',
    });

    const payload = {
      hostname: 'example.com',
      changes: [
        { recordType: 'A', changeType: 'removed', oldValue: '1.2.3.4' },
      ],
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.dns.change',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});

// ==========================================================================
// 6. New Subdomain Discovery with Ignore Pattern
// ==========================================================================

describe('New Subdomain Discovery with Ignore Pattern', () => {
  it('should NOT alert when subdomain matches an ignore pattern (dev.*)', async () => {
    const evaluators = buildRegistry(newSubdomainEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'New Subdomain Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.new_subdomain',
      config: { ignorePatterns: ['dev.*', 'staging.*'] },
      action: 'alert',
    });

    const payload = {
      parentHostname: 'example.com',
      subdomain: 'dev.example.com',
      source: 'ct_log',
      firstSeenAt: new Date().toISOString(),
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.subdomain.discovered',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });

  it('should alert when subdomain does not match any ignore pattern', async () => {
    const evaluators = buildRegistry(newSubdomainEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'New Subdomain Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.new_subdomain',
      config: { ignorePatterns: ['dev.*', 'staging.*'] },
      action: 'alert',
    });

    const payload = {
      parentHostname: 'example.com',
      subdomain: 'api.example.com',
      source: 'ct_log',
      firstSeenAt: new Date().toISOString(),
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.subdomain.discovered',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });
});

// ==========================================================================
// 7. TLS Weakness - Selective Alerting
// ==========================================================================

describe('TLS Weakness - Selective Alerting', () => {
  it('should alert on legacy_version when alertOnLegacyVersions is true', async () => {
    const evaluators = buildRegistry(tlsWeaknessEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'TLS Weakness Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.tls_weakness',
      config: {
        alertOnLegacyVersions: true,
        alertOnWeakCiphers: false,
        alertOnMissingTls13: false,
      },
      action: 'alert',
    });

    const payload = {
      hostname: 'example.com',
      hasTls10: true,
      hasTls11: false,
      hasTls13: true,
      hasWeakCiphers: false,
      weakCipherList: [],
      legacyVersions: ['TLSv1.0'],
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.tls.weakness',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert on weak_cipher when alertOnWeakCiphers is false', async () => {
    const evaluators = buildRegistry(tlsWeaknessEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'TLS Weakness Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.tls_weakness',
      config: {
        alertOnLegacyVersions: true,
        alertOnWeakCiphers: false,
        alertOnMissingTls13: false,
      },
      action: 'alert',
    });

    const payload = {
      hostname: 'example.com',
      hasTls10: false,
      hasTls11: false,
      hasTls13: true,
      hasWeakCiphers: true,
      weakCipherList: ['RC4-SHA'],
      legacyVersions: [],
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.tls.weakness',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});

// ==========================================================================
// 8. Domain Expiry (WHOIS)
// ==========================================================================

describe('Domain Expiry (WHOIS)', () => {
  it('should alert when daysRemaining is below thresholdDays (15 < 30)', async () => {
    const evaluators = buildRegistry(whoisExpiryEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Domain Expiry Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.whois_expiry',
      config: { thresholdDays: 30 },
      action: 'alert',
    });

    const payload = {
      hostname: 'example.com',
      daysRemaining: 15,
      expiryDate: '2026-04-12T00:00:00Z',
      registrar: 'Namecheap',
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.whois.expiring',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert when daysRemaining exceeds thresholdDays (45 > 30)', async () => {
    const evaluators = buildRegistry(whoisExpiryEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Domain Expiry Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.whois_expiry',
      config: { thresholdDays: 30 },
      action: 'alert',
    });

    const payload = {
      hostname: 'example.com',
      daysRemaining: 45,
      expiryDate: '2026-05-12T00:00:00Z',
      registrar: 'Namecheap',
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.whois.expiring',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});

// ==========================================================================
// 9. Score Degradation
// ==========================================================================

describe('Score Degradation', () => {
  it('should alert when both score below minScore AND drop exceeds minDrop (mode=both)', async () => {
    const evaluators = buildRegistry(scoreDegradationEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Score Degradation Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.score_degradation',
      config: { minScore: 70, minDrop: 10, mode: 'both' },
      action: 'alert',
    });

    // previousScore=85, currentScore=60 => drop=25 (>=10), score 60 (<70)
    const payload = {
      hostname: 'example.com',
      previousScore: 85,
      currentScore: 60,
      grade: 'D',
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.score.degraded',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].detectionId).toBe(det.id);
  });

  it('should NOT alert when drop is below minDrop even if score is low (mode=both)', async () => {
    const evaluators = buildRegistry(scoreDegradationEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Score Degradation Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.score_degradation',
      config: { minScore: 70, minDrop: 10, mode: 'both' },
      action: 'alert',
    });

    // previousScore=85, currentScore=80 => drop=5 (<10), score 80 (>70), so mode=both fails
    const payload = {
      hostname: 'example.com',
      previousScore: 85,
      currentScore: 80,
      grade: 'B',
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.score.degraded',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });

  it('should NOT alert when score is above minScore even if drop is large (mode=both)', async () => {
    const evaluators = buildRegistry(scoreDegradationEvaluator);
    const engine = new RuleEngine({ evaluators, redis, db });

    const det = await createTestDetection(org.id, user.id, {
      moduleId: 'infra',
      name: 'Score Degradation Monitor',
      severity: 'high',
    });
    await createTestRule(det.id, org.id, {
      moduleId: 'infra',
      ruleType: 'infra.score_degradation',
      config: { minScore: 70, minDrop: 10, mode: 'both' },
      action: 'alert',
    });

    // previousScore=85, currentScore=80 => drop=5 (<10), score 80 (>70)
    // mode=both means EITHER condition — neither is met here so no alert
    const payload = {
      hostname: 'example.com',
      previousScore: 85,
      currentScore: 80,
      grade: 'B',
    };
    const evt = await createTestEvent(org.id, {
      moduleId: 'infra',
      eventType: 'infra.score.degraded',
      payload,
    });
    const normalizedEvent = toNormalizedEvent(evt, payload);

    const result = await engine.evaluate(normalizedEvent);
    expect(result.candidates.length).toBe(0);
  });
});
