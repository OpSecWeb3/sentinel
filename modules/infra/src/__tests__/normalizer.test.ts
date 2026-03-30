import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeScanResult, normalizeProbeResult } from '../normalizer.js';
import type { ScanResult } from '../scanner/orchestrator.js';
import type { StepResult, ProbeResult } from '../scanner/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ID = 'org-infra-1';

function step(name: string, data?: Record<string, unknown>): StepResult {
  return {
    step: name as StepResult['step'],
    status: 'success',
    data,
    startedAt: new Date(),
    completedAt: new Date(),
  };
}

function baseScanResult(overrides?: Partial<ScanResult>): ScanResult {
  return {
    hostId: 'host-1',
    hostName: 'example.com',
    scanType: 'full',
    status: 'success',
    score: 92,
    grade: 'A',
    details: {},
    stepResults: [],
    errors: [],
    startedAt: new Date(),
    completedAt: new Date(),
    ...overrides,
  };
}

function baseProbeResult(overrides?: Partial<ProbeResult>): ProbeResult {
  return {
    hostId: 'host-1',
    hostName: 'example.com',
    dnsResolved: true,
    isReachable: true,
    httpStatus: 200,
    responseTimeMs: 120,
    dnsChanged: false,
    dnsChangesCount: 0,
    dnsChanges: [],
    alerted: false,
    ...overrides,
  };
}

// ===========================================================================
// normalizeScanResult — always emits scan.completed
// ===========================================================================

describe('normalizeScanResult — scan.completed baseline', () => {
  it('always emits infra.scan.completed even with no issues', () => {
    const result = normalizeScanResult(baseScanResult({ score: 95, grade: 'A' }), ORG_ID);

    expect(result.length).toBe(1);
    expect(result[0].eventType).toBe('infra.scan.completed');
    expect(result[0].payload).toMatchObject({
      hostname: 'example.com',
      hostId: 'host-1',
      scanType: 'full',
      score: 95,
      grade: 'A',
      status: 'success',
    });
  });
});

// ===========================================================================
// Certificate events
// ===========================================================================

describe('normalizeScanResult — certificate events', () => {
  it('emits infra.cert.expiring when cert expires within 30 days', () => {
    const notAfter = new Date(Date.now() + 15 * 86_400_000).toISOString(); // 15 days out
    const scan = baseScanResult({
      stepResults: [
        step('certificate', {
          notAfter,
          subject: 'CN=example.com',
          issuer: "CN=Let's Encrypt",
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const certEvent = events.find((e) => e.eventType === 'infra.cert.expiring');

    expect(certEvent).toBeDefined();
    expect(certEvent!.payload.hostname).toBe('example.com');
    expect(certEvent!.payload.daysRemaining).toBeLessThanOrEqual(15);
    expect(certEvent!.payload.notAfter).toBe(notAfter);
    expect(certEvent!.payload.subject).toBe('CN=example.com');
  });

  it('emits infra.cert.expired when cert is already expired', () => {
    const notAfter = new Date(Date.now() - 2 * 86_400_000).toISOString(); // 2 days ago
    const scan = baseScanResult({
      stepResults: [
        step('certificate', {
          notAfter,
          subject: 'CN=expired.com',
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const expired = events.find((e) => e.eventType === 'infra.cert.expired');

    expect(expired).toBeDefined();
    expect(expired!.payload.daysRemaining).toBeLessThanOrEqual(0);
  });

  it('does not emit cert events when expiry is far in the future', () => {
    const notAfter = new Date(Date.now() + 90 * 86_400_000).toISOString(); // 90 days
    const scan = baseScanResult({
      stepResults: [
        step('certificate', { notAfter, subject: 'CN=healthy.com' }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const certEvents = events.filter(
      (e) => e.eventType === 'infra.cert.expiring' || e.eventType === 'infra.cert.expired',
    );
    expect(certEvents).toHaveLength(0);
  });

  it('emits infra.cert.issue for chain error issues', () => {
    const scan = baseScanResult({
      stepResults: [
        step('certificate', {
          notAfter: new Date(Date.now() + 90 * 86_400_000).toISOString(),
          subject: 'CN=example.com',
          issuer: 'CN=BadCA',
          issues: [{ issue: 'Incomplete certificate chain', severity: 'high' }],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const issueEvent = events.find((e) => e.eventType === 'infra.cert.issue');

    expect(issueEvent).toBeDefined();
    expect(issueEvent!.payload.issueType).toBe('chain_error');
    expect(issueEvent!.payload.detail).toBe('Incomplete certificate chain');
  });

  it('skips cert issues that mention "expired" (handled by expiry logic)', () => {
    const scan = baseScanResult({
      stepResults: [
        step('certificate', {
          notAfter: new Date(Date.now() - 1 * 86_400_000).toISOString(),
          subject: 'CN=example.com',
          issues: [{ issue: 'Certificate expires soon', severity: 'high' }],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const issueEvents = events.filter((e) => e.eventType === 'infra.cert.issue');
    expect(issueEvents).toHaveLength(0);
  });
});

// ===========================================================================
// TLS weakness
// ===========================================================================

describe('normalizeScanResult — TLS weakness', () => {
  it('emits infra.tls.weakness when legacy TLS versions are present', () => {
    const scan = baseScanResult({
      stepResults: [
        step('tls_analysis', {
          hasTls10: true,
          hasTls11: false,
          hasTls13: true,
          hasWeakCiphers: false,
          weakCipherList: [],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const tlsEvent = events.find((e) => e.eventType === 'infra.tls.weakness');

    expect(tlsEvent).toBeDefined();
    expect(tlsEvent!.payload.hasTls10).toBe(true);
    expect(tlsEvent!.payload.hasTls11).toBe(false);
    expect(tlsEvent!.payload.legacyVersions).toEqual(['TLS 1.0']);
  });

  it('emits infra.tls.weakness when weak ciphers are present', () => {
    const scan = baseScanResult({
      stepResults: [
        step('tls_analysis', {
          hasTls10: false,
          hasTls11: false,
          hasTls13: true,
          hasWeakCiphers: true,
          weakCipherList: ['RC4-SHA', 'DES-CBC3-SHA'],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const tlsEvent = events.find((e) => e.eventType === 'infra.tls.weakness');

    expect(tlsEvent).toBeDefined();
    expect(tlsEvent!.payload.hasWeakCiphers).toBe(true);
    expect(tlsEvent!.payload.weakCipherList).toEqual(['RC4-SHA', 'DES-CBC3-SHA']);
  });

  it('does not emit TLS weakness when all versions are modern and ciphers are strong', () => {
    const scan = baseScanResult({
      stepResults: [
        step('tls_analysis', {
          hasTls10: false,
          hasTls11: false,
          hasTls13: true,
          hasWeakCiphers: false,
          weakCipherList: [],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const tlsEvents = events.filter((e) => e.eventType === 'infra.tls.weakness');
    expect(tlsEvents).toHaveLength(0);
  });
});

// ===========================================================================
// DNS change
// ===========================================================================

describe('normalizeScanResult — DNS change', () => {
  it('emits infra.dns.change when DNS changes are detected', () => {
    const scan = baseScanResult({
      stepResults: [
        step('dns_records', {
          changes: [
            { recordType: 'A', changeType: 'modified', oldValue: '1.2.3.4', newValue: '5.6.7.8', severity: 'high' },
            { recordType: 'MX', changeType: 'added', newValue: 'mail.example.com', severity: 'medium' },
          ],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const dnsEvent = events.find((e) => e.eventType === 'infra.dns.change');

    expect(dnsEvent).toBeDefined();
    expect(dnsEvent!.payload.hostname).toBe('example.com');
    const changes = dnsEvent!.payload.changes as Array<Record<string, unknown>>;
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      recordType: 'A',
      changeType: 'modified',
      oldValue: '1.2.3.4',
      newValue: '5.6.7.8',
    });
  });

  it('does not emit DNS change when changes array is empty', () => {
    const scan = baseScanResult({
      stepResults: [step('dns_records', { changes: [] })],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const dnsEvents = events.filter((e) => e.eventType === 'infra.dns.change');
    expect(dnsEvents).toHaveLength(0);
  });
});

// ===========================================================================
// Missing headers
// ===========================================================================

describe('normalizeScanResult — missing headers', () => {
  it('emits infra.header.missing when security headers are absent', () => {
    const scan = baseScanResult({
      stepResults: [
        step('headers', {
          scores: [
            { header: 'Strict-Transport-Security', present: false, severity: 'high' },
            { header: 'Content-Security-Policy', present: false, severity: 'medium' },
            { header: 'X-Content-Type-Options', present: true, severity: 'pass' },
          ],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const headerEvent = events.find((e) => e.eventType === 'infra.header.missing');

    expect(headerEvent).toBeDefined();
    expect(headerEvent!.payload.missingHeaders).toEqual([
      'Strict-Transport-Security',
      'Content-Security-Policy',
    ]);
  });

  it('does not emit header.missing when all headers are present or pass severity', () => {
    const scan = baseScanResult({
      stepResults: [
        step('headers', {
          scores: [
            { header: 'HSTS', present: true, severity: 'pass' },
            { header: 'X-Frame-Options', present: false, severity: 'pass' },
          ],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const headerEvents = events.filter((e) => e.eventType === 'infra.header.missing');
    expect(headerEvents).toHaveLength(0);
  });
});

// ===========================================================================
// Subdomain discovery
// ===========================================================================

describe('normalizeScanResult — subdomain discovery', () => {
  it('emits infra.subdomain.discovered for new subdomains from CT logs', () => {
    const scan = baseScanResult({
      stepResults: [
        step('ct_logs', {
          entries: [
            { nameValue: 'api.example.com' },
            { nameValue: 'staging.example.com\ndev.example.com' },
            { nameValue: '*.example.com' }, // wildcard should be stripped to example.com (same host, skipped)
          ],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const subEvents = events.filter((e) => e.eventType === 'infra.subdomain.discovered');

    expect(subEvents).toHaveLength(3);
    const subdomains = subEvents.map((e) => e.payload.subdomain);
    expect(subdomains).toContain('api.example.com');
    expect(subdomains).toContain('staging.example.com');
    expect(subdomains).toContain('dev.example.com');

    for (const ev of subEvents) {
      expect(ev.payload.parentHostname).toBe('example.com');
      expect(ev.payload.source).toBe('crt_sh');
    }
  });

  it('deduplicates subdomains', () => {
    const scan = baseScanResult({
      stepResults: [
        step('ct_logs', {
          entries: [
            { nameValue: 'api.example.com' },
            { nameValue: 'api.example.com' },
          ],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const subEvents = events.filter((e) => e.eventType === 'infra.subdomain.discovered');
    expect(subEvents).toHaveLength(1);
  });

  it('does not emit subdomain events for the hostname itself', () => {
    const scan = baseScanResult({
      stepResults: [
        step('ct_logs', {
          entries: [{ nameValue: 'example.com' }],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const subEvents = events.filter((e) => e.eventType === 'infra.subdomain.discovered');
    expect(subEvents).toHaveLength(0);
  });
});

// ===========================================================================
// VirusTotal subdomain discovery
// ===========================================================================

describe('normalizeScanResult — VT subdomain discovery', () => {
  it('emits VT subdomains with source virustotal', () => {
    const scan = baseScanResult({
      stepResults: [
        step('ct_logs', {
          entries: [],
          vtSubdomains: ['api.example.com', 'internal.example.com'],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const subEvents = events.filter((e) => e.eventType === 'infra.subdomain.discovered');

    expect(subEvents).toHaveLength(2);
    expect(subEvents[0].payload.source).toBe('virustotal');
    expect(subEvents[1].payload.source).toBe('virustotal');
  });

  it('deduplicates VT subdomains against crt.sh subdomains', () => {
    const scan = baseScanResult({
      stepResults: [
        step('ct_logs', {
          entries: [{ nameValue: 'api.example.com' }],
          vtSubdomains: ['api.example.com', 'new.example.com'],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const subEvents = events.filter((e) => e.eventType === 'infra.subdomain.discovered');

    expect(subEvents).toHaveLength(2);
    expect(subEvents[0].payload).toMatchObject({ subdomain: 'api.example.com', source: 'crt_sh' });
    expect(subEvents[1].payload).toMatchObject({ subdomain: 'new.example.com', source: 'virustotal' });
  });

  it('produces no VT events when vtSubdomains is absent', () => {
    const scan = baseScanResult({
      stepResults: [
        step('ct_logs', {
          entries: [{ nameValue: 'api.example.com' }],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const vtEvents = events.filter(
      (e) => e.eventType === 'infra.subdomain.discovered' && e.payload.source === 'virustotal',
    );
    expect(vtEvents).toHaveLength(0);
  });

  it('reads VT data even when ct_logs step errored', () => {
    const scan = baseScanResult({
      stepResults: [
        {
          step: 'ct_logs' as const,
          status: 'error',
          error: 'crt.sh timeout',
          data: { vtSubdomains: ['recovered.example.com'] },
          startedAt: new Date(),
          completedAt: new Date(),
        },
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const vtEvents = events.filter(
      (e) => e.eventType === 'infra.subdomain.discovered' && e.payload.source === 'virustotal',
    );
    expect(vtEvents).toHaveLength(1);
    expect(vtEvents[0].payload.subdomain).toBe('recovered.example.com');
  });

  it('filters out VT subdomains that do not match the apex domain', () => {
    const scan = baseScanResult({
      stepResults: [
        step('ct_logs', {
          entries: [],
          vtSubdomains: ['api.example.com', 'evil.attacker.com', 'example.com'],
        }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);
    const vtEvents = events.filter(
      (e) => e.eventType === 'infra.subdomain.discovered' && e.payload.source === 'virustotal',
    );
    expect(vtEvents).toHaveLength(1);
    expect(vtEvents[0].payload.subdomain).toBe('api.example.com');
  });
});

// ===========================================================================
// Score degradation
// ===========================================================================

describe('normalizeScanResult — score degradation', () => {
  it('emits infra.score.degraded when score is below 70', () => {
    const scan = baseScanResult({ score: 55, grade: 'D' });

    const events = normalizeScanResult(scan, ORG_ID);
    const scoreEvent = events.find((e) => e.eventType === 'infra.score.degraded');

    expect(scoreEvent).toBeDefined();
    expect(scoreEvent!.payload).toMatchObject({
      hostname: 'example.com',
      currentScore: 55,
      previousScore: null,
      grade: 'D',
    });
  });

  it('does not emit score.degraded when score is 70 or above', () => {
    const scan = baseScanResult({ score: 70, grade: 'C' });

    const events = normalizeScanResult(scan, ORG_ID);
    const scoreEvents = events.filter((e) => e.eventType === 'infra.score.degraded');
    expect(scoreEvents).toHaveLength(0);
  });

  it('does not emit score.degraded when score is undefined', () => {
    const scan = baseScanResult({ score: undefined });

    const events = normalizeScanResult(scan, ORG_ID);
    const scoreEvents = events.filter((e) => e.eventType === 'infra.score.degraded');
    expect(scoreEvents).toHaveLength(0);
  });
});

// ===========================================================================
// Successful scan with no issues
// ===========================================================================

describe('normalizeScanResult — clean scan', () => {
  it('returns only infra.scan.completed when there are no issues', () => {
    const scan = baseScanResult({
      score: 95,
      grade: 'A',
      stepResults: [
        step('certificate', {
          notAfter: new Date(Date.now() + 180 * 86_400_000).toISOString(),
          subject: 'CN=example.com',
        }),
        step('tls_analysis', {
          hasTls10: false,
          hasTls11: false,
          hasTls13: true,
          hasWeakCiphers: false,
          weakCipherList: [],
        }),
        step('dns_records', { changes: [] }),
        step('headers', {
          scores: [
            { header: 'HSTS', present: true, severity: 'pass' },
            { header: 'CSP', present: true, severity: 'pass' },
          ],
        }),
        step('ct_logs', { entries: [] }),
      ],
    });

    const events = normalizeScanResult(scan, ORG_ID);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('infra.scan.completed');
  });
});

// ===========================================================================
// normalizeProbeResult — host unreachable
// ===========================================================================

describe('normalizeProbeResult — host unreachable', () => {
  it('emits infra.host.unreachable when host is not reachable', async () => {
    const probe = baseProbeResult({
      isReachable: false,
      httpStatus: null,
      responseTimeMs: null,
      dnsResolved: false,
    });

    const events = await normalizeProbeResult(probe, ORG_ID);

    const probeCompleted = events.find((e) => e.eventType === 'infra.probe.completed');
    expect(probeCompleted).toBeDefined();
    expect(probeCompleted!.payload.isReachable).toBe(false);

    const unreachable = events.find((e) => e.eventType === 'infra.host.unreachable');
    expect(unreachable).toBeDefined();
    expect(unreachable!.payload).toMatchObject({
      hostname: 'example.com',
      isReachable: false,
      dnsResolved: false,
      httpStatus: null,
      consecutiveFailures: 1,
    });
  });

  it('does not emit host.unreachable when host is reachable', async () => {
    const probe = baseProbeResult({ isReachable: true });

    const events = await normalizeProbeResult(probe, ORG_ID);
    const unreachable = events.filter((e) => e.eventType === 'infra.host.unreachable');
    expect(unreachable).toHaveLength(0);
  });
});

describe('normalizeProbeResult — slow response', () => {
  it('emits infra.host.slow when response time >= 5000ms', async () => {
    const probe = baseProbeResult({ responseTimeMs: 6500, isReachable: true });

    const events = await normalizeProbeResult(probe, ORG_ID);
    const slow = events.find((e) => e.eventType === 'infra.host.slow');

    expect(slow).toBeDefined();
    expect(slow!.payload.responseTimeMs).toBe(6500);
  });

  it('does not emit slow for unreachable hosts even with high responseTimeMs', async () => {
    const probe = baseProbeResult({ responseTimeMs: 10000, isReachable: false });

    const events = await normalizeProbeResult(probe, ORG_ID);
    const slow = events.filter((e) => e.eventType === 'infra.host.slow');
    expect(slow).toHaveLength(0);
  });
});

describe('normalizeProbeResult — DNS changes from probe', () => {
  it('emits infra.dns.change when probe detects DNS changes', async () => {
    const probe = baseProbeResult({
      dnsChanged: true,
      dnsChangesCount: 1,
      dnsChanges: [
        { recordType: 'A', oldValue: '1.2.3.4', newValue: '9.8.7.6', changeType: 'modified', severity: 'high' as const },
      ],
    });

    const events = await normalizeProbeResult(probe, ORG_ID);
    const dnsEvent = events.find((e) => e.eventType === 'infra.dns.change');

    expect(dnsEvent).toBeDefined();
    expect(dnsEvent!.payload.hostname).toBe('example.com');
    const changes = dnsEvent!.payload.changes as Array<Record<string, unknown>>;
    expect(changes).toHaveLength(1);
    expect(changes[0].recordType).toBe('A');
  });
});
