import { describe, it, expect } from 'vitest';
import { calculateScore, applySuppressions } from '../scanner/scoring.js';
import type {
  CertificateInfo,
  DnsHealthData,
  TlsInfo,
  HeaderInfo,
  InfraResult,
  ScoreResult,
} from '../scanner/types.js';

// ---------------------------------------------------------------------------
// Helpers: factory functions for realistic infra payloads
// ---------------------------------------------------------------------------

function makeDnsHealth(overrides: Partial<DnsHealthData> = {}): DnsHealthData {
  return {
    dnssecEnabled: true,
    dnssecDetails: 'DNSSEC validation chain intact',
    caaRecords: JSON.stringify([{ tag: 'issue', value: 'letsencrypt.org' }]),
    dmarcRecord: 'v=DMARC1; p=reject; rua=mailto:dmarc@example.com',
    dmarcPolicy: 'reject',
    spfRecord: 'v=spf1 include:_spf.google.com -all',
    spfValid: true,
    spfTooPermissive: false,
    spfTooManyLookups: false,
    spfLookupCount: 3,
    spfMissingTerminator: false,
    danglingCnames: JSON.stringify([]),
    ...overrides,
  };
}

function makeCertInfo(overrides: Partial<CertificateInfo> = {}): CertificateInfo {
  // Default: certificate valid for another 90 days
  const notAfter = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  return {
    subject: 'CN=example.com',
    issuer: 'CN=Lets Encrypt Authority X3',
    serialNumber: '03:ab:cd:ef:12:34:56:78',
    notBefore: '2025-01-01T00:00:00Z',
    notAfter,
    fingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    chainValid: true,
    sanList: ['example.com', 'www.example.com'],
    ...overrides,
  };
}

function makeTlsInfo(overrides: Partial<TlsInfo> = {}): TlsInfo {
  return {
    hasTls10: false,
    hasTls11: false,
    hasTls12: true,
    hasTls13: true,
    hasWeakCiphers: false,
    weakCipherList: [],
    supportedVersions: ['TLS 1.2', 'TLS 1.3'],
    ...overrides,
  };
}

function makeHeaderInfo(overrides: Partial<HeaderInfo> = {}): HeaderInfo {
  return {
    hstsPresent: true,
    hstsValue: 'max-age=31536000; includeSubDomains; preload',
    cspPresent: true,
    cspValue: "default-src 'self'",
    xFrameOptions: 'DENY',
    xContentTypeOptions: true,
    referrerPolicy: 'strict-origin-when-cross-origin',
    permissionsPolicy: 'geolocation=(), camera=()',
    serverHeaderPresent: false,
    serverHeaderValue: null,
    ...overrides,
  };
}

// ===========================================================================
// Score calculation tests
// ===========================================================================

describe('calculateScore', () => {
  it('perfect score (all checks pass) -> 100, grade A', () => {
    const result = calculateScore(
      'host-1',
      makeDnsHealth(),
      makeCertInfo(),
      makeTlsInfo(),
      { headerInfo: makeHeaderInfo() },
    );

    expect(result.score).toBe(100);
    expect(result.grade).toBe('A');
    expect(result.deductions).toHaveLength(0);
  });

  it('missing DNSSEC -> deduct 10, score 90', () => {
    const result = calculateScore(
      'host-1',
      makeDnsHealth({ dnssecEnabled: false }),
      makeCertInfo(),
      makeTlsInfo(),
      { headerInfo: makeHeaderInfo() },
    );

    expect(result.score).toBe(90);
    expect(result.grade).toBe('A');
    const dnssecDeduction = result.deductions.find((d) => d.category === 'DNSSEC');
    expect(dnssecDeduction).toBeDefined();
    expect(dnssecDeduction!.points).toBe(10);
    expect(dnssecDeduction!.evidence).toContain('DNSSEC');
  });

  it('missing DMARC -> deduct 25', () => {
    const result = calculateScore(
      'host-1',
      makeDnsHealth({ dmarcRecord: null, dmarcPolicy: null }),
      makeCertInfo(),
      makeTlsInfo(),
      { headerInfo: makeHeaderInfo() },
    );

    const dmarcDeduction = result.deductions.find((d) => d.category === 'DMARC');
    expect(dmarcDeduction).toBeDefined();
    expect(dmarcDeduction!.points).toBe(25);
    expect(result.score).toBe(75);
  });

  it('SPF +all -> deduct 30 (critical)', () => {
    const result = calculateScore(
      'host-1',
      makeDnsHealth({
        spfRecord: 'v=spf1 +all',
        spfTooPermissive: true,
      }),
      makeCertInfo(),
      makeTlsInfo(),
      { headerInfo: makeHeaderInfo() },
    );

    const spfDeduction = result.deductions.find(
      (d) => d.category === 'SPF' && d.issue.includes('+all'),
    );
    expect(spfDeduction).toBeDefined();
    expect(spfDeduction!.points).toBe(30);
    expect(spfDeduction!.severity).toBe('high');
  });

  it('expired cert -> deduct 30', () => {
    // Certificate expired 5 days ago
    const notAfter = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const result = calculateScore(
      'host-1',
      makeDnsHealth(),
      makeCertInfo({ notAfter }),
      makeTlsInfo(),
      { headerInfo: makeHeaderInfo() },
    );

    const certDeduction = result.deductions.find((d) => d.category === 'Certificate');
    expect(certDeduction).toBeDefined();
    expect(certDeduction!.points).toBe(30);
    expect(certDeduction!.evidence).toContain('Days remaining');
  });

  it('TLS 1.0 enabled -> deduct 20', () => {
    const result = calculateScore(
      'host-1',
      makeDnsHealth(),
      makeCertInfo(),
      makeTlsInfo({ hasTls10: true }),
      { headerInfo: makeHeaderInfo() },
    );

    const tlsDeduction = result.deductions.find(
      (d) => d.category === 'TLS' && d.issue.includes('Legacy TLS'),
    );
    expect(tlsDeduction).toBeDefined();
    expect(tlsDeduction!.points).toBe(20);
    expect(result.score).toBe(80);
  });

  it('weak ciphers -> deduct 10', () => {
    const result = calculateScore(
      'host-1',
      makeDnsHealth(),
      makeCertInfo(),
      makeTlsInfo({
        hasWeakCiphers: true,
        weakCipherList: ['TLS_RSA_WITH_RC4_128_SHA'],
      }),
      { headerInfo: makeHeaderInfo() },
    );

    const cipherDeduction = result.deductions.find(
      (d) => d.category === 'TLS' && d.issue.includes('Weak cipher'),
    );
    expect(cipherDeduction).toBeDefined();
    expect(cipherDeduction!.points).toBe(10);
    expect(cipherDeduction!.evidence).toContain('TLS_RSA_WITH_RC4_128_SHA');
  });

  it('multiple deductions stack correctly', () => {
    // DNSSEC off (-10) + DMARC missing (-25) + TLS 1.0 (-20) = 45 deducted
    const result = calculateScore(
      'host-1',
      makeDnsHealth({ dnssecEnabled: false, dmarcRecord: null, dmarcPolicy: null }),
      makeCertInfo(),
      makeTlsInfo({ hasTls10: true }),
      { headerInfo: makeHeaderInfo() },
    );

    expect(result.score).toBe(45);
    expect(result.grade).toBe('F');
    expect(result.deductions.length).toBeGreaterThanOrEqual(3);

    // Verify breakdown has all categories
    expect(result.breakdown['DNSSEC']).toBe(10);
    expect(result.breakdown['DMARC']).toBe(25);
    expect(result.breakdown['TLS']).toBe(20);
  });

  it('grade boundaries: A=90, B=80, C=70, D=60, F=59', () => {
    // A: 90+ (only DNSSEC off = -10 -> 90)
    const gradeA = calculateScore(
      'host-a',
      makeDnsHealth({ dnssecEnabled: false }),
      makeCertInfo(),
      makeTlsInfo(),
      { headerInfo: makeHeaderInfo() },
    );
    expect(gradeA.score).toBe(90);
    expect(gradeA.grade).toBe('A');

    // B: 80-89 (DNSSEC off -10 + weak ciphers -10 = 80)
    const gradeB = calculateScore(
      'host-b',
      makeDnsHealth({ dnssecEnabled: false }),
      makeCertInfo(),
      makeTlsInfo({ hasWeakCiphers: true, weakCipherList: ['RC4'] }),
      { headerInfo: makeHeaderInfo() },
    );
    expect(gradeB.score).toBe(80);
    expect(gradeB.grade).toBe('B');

    // C: 70-79 (DMARC missing -25 + TLS 1.3 missing -5 = 70)
    const gradeC = calculateScore(
      'host-c',
      makeDnsHealth({ dmarcRecord: null, dmarcPolicy: null }),
      makeCertInfo(),
      makeTlsInfo({ hasTls13: false }),
      { headerInfo: makeHeaderInfo() },
    );
    expect(gradeC.score).toBe(70);
    expect(gradeC.grade).toBe('C');

    // D: 60-69 (DMARC missing -25 + no HSTS -10 + TLS 1.3 missing -5 = 60)
    const gradeD = calculateScore(
      'host-d',
      makeDnsHealth({ dmarcRecord: null, dmarcPolicy: null }),
      makeCertInfo(),
      makeTlsInfo({ hasTls13: false }),
      { headerInfo: makeHeaderInfo({ hstsPresent: false }) },
    );
    expect(gradeD.score).toBe(60);
    expect(gradeD.grade).toBe('D');

    // F: <60 (DMARC missing -25 + TLS 1.0 -20 = 55)
    const gradeF = calculateScore(
      'host-f',
      makeDnsHealth({ dmarcRecord: null, dmarcPolicy: null }),
      makeCertInfo(),
      makeTlsInfo({ hasTls10: true }),
      { headerInfo: makeHeaderInfo() },
    );
    expect(gradeF.score).toBe(55);
    expect(gradeF.grade).toBe('F');
  });

  it('score floor at 0 (does not go negative)', () => {
    // Stack up massive deductions: DMARC missing (-25) + SPF +all (-30)
    // + expired cert (-30) + TLS 1.0 (-20) + weak ciphers (-10) + no HSTS (-10)
    // + no CSP (-15) + DNSSEC off (-10) + no CAA (-10) = -160 raw, clamped to 0
    const notAfter = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const result = calculateScore(
      'host-1',
      makeDnsHealth({
        dnssecEnabled: false,
        caaRecords: JSON.stringify([]),
        dmarcRecord: null,
        dmarcPolicy: null,
        spfRecord: 'v=spf1 +all',
        spfTooPermissive: true,
      }),
      makeCertInfo({ notAfter, chainValid: false }),
      makeTlsInfo({
        hasTls10: true,
        hasTls13: false,
        hasWeakCiphers: true,
        weakCipherList: ['RC4'],
      }),
      {
        headerInfo: makeHeaderInfo({
          hstsPresent: false,
          cspPresent: false,
          xFrameOptions: null,
          xContentTypeOptions: false,
          referrerPolicy: null,
          serverHeaderPresent: true,
          serverHeaderValue: 'Apache/2.4.41',
        }),
      },
    );

    expect(result.score).toBe(0);
    expect(result.grade).toBe('F');
  });

  it('finding suppressions exclude specific deductions', () => {
    // DNSSEC off (-10) + DMARC missing (-25) = 65 raw
    const result = calculateScore(
      'host-1',
      makeDnsHealth({ dnssecEnabled: false, dmarcRecord: null, dmarcPolicy: null }),
      makeCertInfo(),
      makeTlsInfo(),
      { headerInfo: makeHeaderInfo() },
    );

    expect(result.score).toBe(65);

    // Suppress the DMARC deduction
    const adjusted = applySuppressions(result, [
      { category: 'DMARC', issue: 'No DMARC record found' },
    ]);

    // Only DNSSEC deduction remains: 100 - 10 = 90
    expect(adjusted).toBe(90);
  });

  it('deductions include evidence strings', () => {
    const result = calculateScore(
      'host-1',
      makeDnsHealth({ dnssecEnabled: false }),
      makeCertInfo(),
      makeTlsInfo(),
      { headerInfo: makeHeaderInfo() },
    );

    for (const d of result.deductions) {
      expect(d.evidence).toBeDefined();
      expect(typeof d.evidence).toBe('string');
      expect(d.evidence.length).toBeGreaterThan(0);
    }
  });

  it('partial scan data (some steps null) still scores', () => {
    // Only DNS data available, cert and TLS are null
    const result = calculateScore('host-1', makeDnsHealth(), null, null);

    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.grade).toBeDefined();
    // No cert or TLS deductions should appear
    const certDeductions = result.deductions.filter((d) => d.category === 'Certificate');
    const tlsDeductions = result.deductions.filter((d) => d.category === 'TLS');
    expect(certDeductions).toHaveLength(0);
    expect(tlsDeductions).toHaveLength(0);
  });

  it('all steps null returns perfect score', () => {
    const result = calculateScore('host-1', null, null, null);

    expect(result.score).toBe(100);
    expect(result.grade).toBe('A');
    expect(result.deductions).toHaveLength(0);
  });
});
