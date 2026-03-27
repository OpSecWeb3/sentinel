/**
 * Security scoring service.
 *
 * 100-point deduction system ported from Scout. Starts at 100, deducts for
 * each issue with evidence. Supports finding suppressions.
 *
 * Grade: A=90-100, B=80-89, C=70-79, D=60-69, F=0-59.
 */
import type {
  CertificateInfo,
  Deduction,
  DnsHealthData,
  Grade,
  HeaderInfo,
  InfraResult,
  ScoreResult,
  Severity,
  TlsInfo,
  WhoisData,
} from './types.js';

// -------------------------------------------------------------------------
// Grade mapping
// -------------------------------------------------------------------------

function getGrade(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

// -------------------------------------------------------------------------
// Suppression support
// -------------------------------------------------------------------------

export interface FindingSuppression {
  category: string;
  issue: string;
}

/**
 * Apply suppressions to a score result. Returns the adjusted score after
 * removing suppressed deductions from the total.
 */
export function applySuppressions(
  scoreResult: ScoreResult,
  suppressions: FindingSuppression[],
): number {
  if (suppressions.length === 0) return scoreResult.score;

  const suppressionSet = new Set(suppressions.map((s) => `${s.category}::${s.issue}`));

  const activePoints = scoreResult.deductions
    .filter((d) => !suppressionSet.has(`${d.category}::${d.issue}`))
    .reduce((sum, d) => sum + d.points, 0);

  return Math.max(0, Math.min(100, 100 - activePoints));
}

// -------------------------------------------------------------------------
// Score calculation
// -------------------------------------------------------------------------

export function calculateScore(
  hostId: string,
  dnsHealth: DnsHealthData | null,
  certInfo: CertificateInfo | null,
  tlsInfo: TlsInfo | null,
  options: {
    infraResults?: InfraResult[] | null;
    headerInfo?: HeaderInfo | null;
    whoisInfo?: WhoisData | null;
  } = {},
): ScoreResult {
  let score = 100;
  const deductions: Deduction[] = [];
  let criticalOverride = false;

  const addDeduction = (
    category: string,
    issue: string,
    points: number,
    severity: Severity,
    evidence: string,
  ) => {
    deductions.push({ category, issue, points, severity, evidence });
    score -= points;
  };

  // --- DNSSEC ---
  if (dnsHealth && !dnsHealth.dnssecEnabled) {
    addDeduction('DNSSEC', 'DNSSEC is not enabled', 10, 'medium', 'No DNSSEC validation chain (DS/DNSKEY/RRSIG)');
  }

  // --- CAA ---
  if (dnsHealth) {
    let caaList: unknown[] = [];
    try {
      caaList = JSON.parse(dnsHealth.caaRecords);
    } catch {
      // ignore
    }

    if (caaList.length === 0) {
      addDeduction('CAA', 'No CAA records configured', 10, 'medium', 'No CAA DNS records found; any CA can issue certificates');
    }
  }

  // --- DMARC ---
  if (dnsHealth) {
    if (!dnsHealth.dmarcRecord) {
      addDeduction('DMARC', 'No DMARC record found', 25, 'high', 'No TXT record at _dmarc subdomain');
    } else if (dnsHealth.dmarcPolicy === 'none') {
      addDeduction('DMARC', 'Weak DMARC policy (p=none)', 15, 'medium', `DMARC record: ${dnsHealth.dmarcRecord}`);
    }
  }

  // --- SPF ---
  if (dnsHealth) {
    if (!dnsHealth.spfRecord) {
      addDeduction('SPF', 'No SPF record found', 15, 'high', 'No TXT record starting with v=spf1');
    } else {
      if (dnsHealth.spfTooPermissive) {
        addDeduction(
          'SPF',
          'SPF uses +all (anyone can send as this domain)',
          30,
          'high',
          `SPF record: ${dnsHealth.spfRecord}`,
        );
      }
      if (dnsHealth.spfTooManyLookups) {
        addDeduction(
          'SPF',
          `SPF exceeds 10 DNS lookup limit (${dnsHealth.spfLookupCount ?? 0} lookups)`,
          5,
          'low',
          'RFC 7208 limits SPF to 10 DNS mechanisms; exceeding causes permerror',
        );
      }
      if (dnsHealth.spfMissingTerminator) {
        addDeduction('SPF', 'SPF record has no terminating mechanism', 5, 'low', 'SPF record missing -all, ~all, or redirect= terminator');
      }
    }
  }

  // --- Certificate ---
  if (certInfo) {
    const notAfter = new Date(certInfo.notAfter);
    const now = new Date();
    const daysRemaining = Math.floor((notAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (daysRemaining < 15) {
      addDeduction(
        'Certificate',
        `Certificate expires in ${daysRemaining} days (< 15)`,
        30,
        'high',
        `Expiry: ${certInfo.notAfter}, Days remaining: ${daysRemaining}`,
      );
    } else if (daysRemaining < 30) {
      addDeduction(
        'Certificate',
        `Certificate expires in ${daysRemaining} days (< 30)`,
        15,
        'medium',
        `Expiry: ${certInfo.notAfter}, Days remaining: ${daysRemaining}`,
      );
    }

    if (!certInfo.chainValid) {
      addDeduction('Certificate', 'Certificate chain is invalid', 25, 'high', 'TLS chain verification failed');
    }
  }

  // --- TLS ---
  if (tlsInfo) {
    if (tlsInfo.hasTls10 || tlsInfo.hasTls11) {
      const versions: string[] = [];
      if (tlsInfo.hasTls10) versions.push('TLS 1.0');
      if (tlsInfo.hasTls11) versions.push('TLS 1.1');
      addDeduction(
        'TLS',
        `Legacy TLS versions enabled (${versions.join(', ')})`,
        20,
        'high',
        `Server supports deprecated: ${versions.join(', ')}`,
      );
    }

    if (tlsInfo.hasWeakCiphers) {
      const cipherStr = tlsInfo.weakCipherList.length > 0 ? tlsInfo.weakCipherList.join(', ') : 'detected';
      addDeduction('TLS', 'Weak cipher suites detected', 10, 'medium', `Weak ciphers: ${cipherStr}`);
    }

    if (!tlsInfo.hasTls13) {
      addDeduction('TLS', 'TLS 1.3 not supported', 5, 'low', 'Server does not support TLS 1.3');
    }
  }

  // --- HTTP Headers ---
  const headerInfo = options.headerInfo;
  if (headerInfo) {
    if (!headerInfo.hstsPresent) {
      addDeduction('HTTP Headers', 'No HSTS header', 10, 'high', 'Strict-Transport-Security header is missing');
    }

    if (!headerInfo.cspPresent) {
      addDeduction(
        'HTTP Headers',
        'No Content-Security-Policy header',
        15,
        'high',
        'Content-Security-Policy header is missing; primary XSS defense layer absent',
      );
    }

    if (!headerInfo.xFrameOptions) {
      addDeduction('HTTP Headers', 'No X-Frame-Options header', 5, 'low', 'X-Frame-Options header is missing');
    }

    if (!headerInfo.xContentTypeOptions) {
      addDeduction(
        'HTTP Headers',
        'No X-Content-Type-Options header',
        3,
        'low',
        'X-Content-Type-Options: nosniff header is missing',
      );
    }

    if (!headerInfo.referrerPolicy) {
      addDeduction('HTTP Headers', 'No Referrer-Policy header', 3, 'low', 'Referrer-Policy header is missing');
    }

    if (headerInfo.serverHeaderPresent) {
      addDeduction(
        'HTTP Headers',
        'Server header present',
        2,
        'low',
        `Server header exposes: ${headerInfo.serverHeaderValue ?? 'unknown'}`,
      );
    }
  }

  // --- Infrastructure ---
  const infraResults = options.infraResults;
  if (infraResults && infraResults.length > 0) {
    const DB_CACHE_PORTS: Record<number, string> = {
      3306: 'MySQL',
      5432: 'PostgreSQL',
      6379: 'Redis',
      9200: 'Elasticsearch',
      27017: 'MongoDB',
    };

    let sshExposed = false;
    let nonStandardHttp = false;
    const exposedDbPorts: string[] = [];
    let rdpExposed = false;

    for (const infra of infraResults) {
      for (const portInfo of infra.ports) {
        if (!portInfo.open) continue;
        const port = portInfo.port;

        if (port === 22) sshExposed = true;
        else if (port === 8080 || port === 8443) nonStandardHttp = true;
        else if (port in DB_CACHE_PORTS) exposedDbPorts.push(`${port} (${DB_CACHE_PORTS[port]})`);
        else if (port === 3389) rdpExposed = true;
      }
    }

    if (exposedDbPorts.length > 0) {
      deductions.push({
        category: 'Infrastructure',
        issue: 'Database/cache ports publicly accessible',
        points: 100,
        severity: 'critical',
        evidence: `Exposed ports: ${exposedDbPorts.join(', ')}`,
      });
      criticalOverride = true;
    }

    if (rdpExposed) {
      addDeduction(
        'Infrastructure',
        'RDP port (3389) is publicly accessible',
        20,
        'high',
        'Port 3389 (RDP) is open and reachable from the internet',
      );
    }

    if (sshExposed) {
      addDeduction(
        'Infrastructure',
        'SSH port (22) is publicly accessible',
        10,
        'medium',
        'Port 22 (SSH) is open and reachable from the internet',
      );
    }

    if (nonStandardHttp) {
      addDeduction(
        'Infrastructure',
        'Non-standard HTTP port exposed',
        3,
        'low',
        'Non-standard HTTP port (8080/8443) is open',
      );
    }
  }

  // --- WHOIS ---
  const whoisInfo = options.whoisInfo;
  if (whoisInfo) {
    if (whoisInfo.expiryDate) {
      const expiry = new Date(whoisInfo.expiryDate);
      if (!isNaN(expiry.getTime())) {
        const daysRemaining = Math.floor((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        if (daysRemaining < 30) {
          addDeduction(
            'WHOIS',
            `Domain registration expires in ${daysRemaining} days (< 30)`,
            10,
            'medium',
            `Domain expiry: ${whoisInfo.expiryDate}, Days remaining: ${daysRemaining}`,
          );
        }
      }
    }

    // Check for registry lock
    let statusList: string[] = [];
    try {
      statusList = JSON.parse(whoisInfo.status);
    } catch {
      // ignore
    }

    if (Array.isArray(statusList) && !statusList.includes('clientTransferProhibited')) {
      addDeduction(
        'WHOIS',
        'No registry lock (clientTransferProhibited)',
        5,
        'low',
        `EPP status codes: ${statusList.length > 0 ? statusList.join(', ') : 'none'}`,
      );
    }
  }

  // --- Dangling CNAMEs (critical override) ---
  if (dnsHealth) {
    let danglingList: unknown[] = [];
    try {
      danglingList = JSON.parse(dnsHealth.danglingCnames);
    } catch {
      // ignore
    }

    if (danglingList.length > 0) {
      deductions.push({
        category: 'Dangling CNAME',
        issue: 'Dangling CNAME detected (subdomain takeover risk)',
        points: 100,
        severity: 'critical',
        evidence: `Dangling targets: ${(danglingList as string[]).join(', ')}`,
      });
      criticalOverride = true;
    }
  }

  // Apply critical override
  if (criticalOverride) {
    score = 0;
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));
  const grade = getGrade(score);

  // Build breakdown by category
  const breakdown: Record<string, number> = {};
  for (const d of deductions) {
    breakdown[d.category] = (breakdown[d.category] ?? 0) + d.points;
  }

  return { hostId, score, grade, deductions, breakdown };
}
