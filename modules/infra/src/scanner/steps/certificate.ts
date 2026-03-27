/**
 * Step 3: Live certificate fetch and analysis.
 *
 * Uses node:tls to connect and fetch the certificate chain. Parses subject,
 * issuer, serial, validity dates, key type/size, SANs, and signature algorithm.
 * Detects issues: expired, expiring soon, self-signed, weak key, SHA-1.
 */
import tls from 'node:tls';
import crypto from 'node:crypto';

import type { CertificateInfo, StepResult } from '../types.js';

const CONNECT_TIMEOUT_MS = 10_000;
const EXPIRY_WARNING_DAYS = 30;
const EXPIRY_CRITICAL_DAYS = 15;

// -------------------------------------------------------------------------
// TLS connection + cert extraction
// -------------------------------------------------------------------------

interface RawCert {
  subject: Record<string, string>;
  issuer: Record<string, string>;
  serialNumber: string;
  valid_from: string;
  valid_to: string;
  fingerprint256: string;
  fingerprint: string;
  subjectaltname?: string;
  bits?: number;
  asn1Curve?: string;
  modulus?: string;
  exponent?: string;
  pubkey?: Buffer;
  raw?: Buffer;
  infoAccess?: Record<string, string[]>;
}

function parseCertificate(rawCert: RawCert): CertificateInfo {
  const subject = Object.entries(rawCert.subject)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const issuer = Object.entries(rawCert.issuer)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

  // Parse SANs from subjectaltname string like "DNS:example.com, DNS:*.example.com"
  const sanList: string[] = [];
  if (rawCert.subjectaltname) {
    for (const entry of rawCert.subjectaltname.split(',')) {
      const trimmed = entry.trim();
      if (trimmed.startsWith('DNS:')) {
        sanList.push(trimmed.slice(4));
      } else if (trimmed.startsWith('IP Address:')) {
        sanList.push(trimmed.slice(11));
      }
    }
  }

  // Determine key type and size
  let keyType = 'unknown';
  let keySize = 0;
  if (rawCert.asn1Curve) {
    keyType = 'ECDSA';
    // Common curve sizes
    const curveMap: Record<string, number> = {
      'prime256v1': 256,
      'secp384r1': 384,
      'secp521r1': 521,
    };
    keySize = curveMap[rawCert.asn1Curve] ?? 256;
  } else if (rawCert.modulus) {
    keyType = 'RSA';
    keySize = (rawCert.modulus.length / 2) * 8; // hex string to bits
  } else if (rawCert.bits) {
    keyType = 'RSA';
    keySize = rawCert.bits;
  }

  // Determine signature algorithm using Node's crypto.X509Certificate
  // which parses the actual ASN.1 signature algorithm from the DER cert
  let signatureAlgorithm = 'unknown';
  let sha1Signature = false;
  if (rawCert.raw) {
    try {
      const x509 = new crypto.X509Certificate(rawCert.raw);
      // x509.toString() contains the signature algorithm in its text output
      const certText = x509.toString();
      const sigMatch = certText.match(/Signature Algorithm:\s*(\S+)/i);
      if (sigMatch) {
        signatureAlgorithm = sigMatch[1];
      }
      // Detect SHA-1 from the actual signature algorithm OID/name
      const lowerSig = signatureAlgorithm.toLowerCase();
      sha1Signature = lowerSig.includes('sha1') || lowerSig === 'sha1withrsaencryption';
    } catch {
      // Fallback: cannot parse X509, leave as unknown
    }
  }

  // Self-signed check: subject matches issuer
  const selfSigned = subject === issuer;

  // Weak key check: RSA < 2048, ECDSA < 256
  const weakKey =
    (keyType === 'RSA' && keySize < 2048) || (keyType === 'ECDSA' && keySize < 256);

  const notBefore = new Date(rawCert.valid_from);

  const notAfter = new Date(rawCert.valid_to);
  const now = new Date();
  const chainValid = notAfter > now && notBefore <= now;

  return {
    subject,
    issuer,
    serialNumber: rawCert.serialNumber,
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    fingerprint: rawCert.fingerprint256 || rawCert.fingerprint,
    chainValid,
    sanList,
    keyType,
    keySize,
    signatureAlgorithm,
    selfSigned,
    weakKey,
    sha1Signature,
  };
}

export function fetchCertificate(host: string, port = 443): Promise<CertificateInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        rejectUnauthorized: false, // We want to inspect even invalid certs
        timeout: CONNECT_TIMEOUT_MS,
      },
      () => {
        try {
          const cert = socket.getPeerCertificate(true);
          if (!cert || !cert.subject) {
            socket.destroy();
            reject(new Error('No certificate returned'));
            return;
          }
          const info = parseCertificate(cert as unknown as RawCert);

          // Override chainValid with actual TLS verification
          info.chainValid = socket.authorized;

          socket.destroy();
          resolve(info);
        } catch (err) {
          socket.destroy();
          reject(err);
        }
      },
    );

    socket.on('error', (err) => {
      socket.destroy();
      reject(err);
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`TLS connection to ${host}:${port} timed out`));
    });
  });
}

/**
 * Detect certificate issues and return them as a list of {issue, severity} pairs.
 */
export function detectCertIssues(
  cert: CertificateInfo,
): Array<{ issue: string; severity: string }> {
  const issues: Array<{ issue: string; severity: string }> = [];

  const notAfter = new Date(cert.notAfter);
  const now = new Date();
  const daysRemaining = Math.floor((notAfter.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (daysRemaining < 0) {
    issues.push({ issue: `Certificate expired ${Math.abs(daysRemaining)} days ago`, severity: 'critical' });
  } else if (daysRemaining < EXPIRY_CRITICAL_DAYS) {
    issues.push({ issue: `Certificate expires in ${daysRemaining} days`, severity: 'high' });
  } else if (daysRemaining < EXPIRY_WARNING_DAYS) {
    issues.push({ issue: `Certificate expires in ${daysRemaining} days`, severity: 'medium' });
  }

  if (cert.selfSigned) {
    issues.push({ issue: 'Self-signed certificate', severity: 'high' });
  }

  if (cert.weakKey) {
    issues.push({ issue: `Weak key: ${cert.keyType} ${cert.keySize}-bit`, severity: 'high' });
  }

  if (cert.sha1Signature) {
    issues.push({ issue: 'SHA-1 signature algorithm detected', severity: 'high' });
  }

  if (!cert.chainValid) {
    issues.push({ issue: 'Certificate chain is invalid', severity: 'high' });
  }

  return issues;
}

// -------------------------------------------------------------------------
// Step runner
// -------------------------------------------------------------------------

export async function runCertificateStep(domain: string): Promise<StepResult> {
  const startedAt = new Date();

  try {
    const certInfo = await fetchCertificate(domain);
    const issues = detectCertIssues(certInfo);

    return {
      step: 'certificate',
      status: 'success',
      data: {
        ...certInfo,
        issues,
      },
      startedAt,
      completedAt: new Date(),
    };
  } catch (err) {
    return {
      step: 'certificate',
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date(),
    };
  }
}
