/**
 * Step 4: TLS version and cipher suite analysis.
 *
 * Attempts connections with TLS 1.0, 1.1, 1.2, and 1.3 to detect supported
 * versions. Checks for weak cipher suites.
 */
import tls from 'node:tls';

import type { StepResult, TlsInfo } from '../types.js';

const CONNECT_TIMEOUT_MS = 8_000;

/** Weak cipher patterns — any cipher containing these strings is considered weak. */
const WEAK_CIPHER_PATTERNS = [
  'RC4',
  'DES',
  'NULL',
  'EXPORT',
  'anon',
  'MD5',
  'CBC3',
  'RC2',
] as const;

/** Map of TLS version names to their minVersion/maxVersion values. */
const TLS_VERSIONS = [
  { name: 'TLS 1.0', min: 'TLSv1' as const, max: 'TLSv1' as const },
  { name: 'TLS 1.1', min: 'TLSv1.1' as const, max: 'TLSv1.1' as const },
  { name: 'TLS 1.2', min: 'TLSv1.2' as const, max: 'TLSv1.2' as const },
  { name: 'TLS 1.3', min: 'TLSv1.3' as const, max: 'TLSv1.3' as const },
] as const;

// -------------------------------------------------------------------------
// TLS version probe
// -------------------------------------------------------------------------

interface VersionProbeResult {
  version: string;
  supported: boolean;
  cipher: string | null;
}

function probeVersion(
  host: string,
  port: number,
  minVersion: tls.SecureVersion,
  maxVersion: tls.SecureVersion,
  versionName: string,
): Promise<VersionProbeResult> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        minVersion,
        maxVersion,
        rejectUnauthorized: false,
        timeout: CONNECT_TIMEOUT_MS,
      },
      () => {
        const cipher = socket.getCipher();
        socket.destroy();
        resolve({
          version: versionName,
          supported: true,
          cipher: cipher?.name ?? null,
        });
      },
    );

    socket.on('error', () => {
      socket.destroy();
      resolve({ version: versionName, supported: false, cipher: null });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ version: versionName, supported: false, cipher: null });
    });
  });
}

function isWeakCipher(cipherName: string): boolean {
  const upper = cipherName.toUpperCase();
  return WEAK_CIPHER_PATTERNS.some((pattern) => upper.includes(pattern));
}

// -------------------------------------------------------------------------
// Full analysis
// -------------------------------------------------------------------------

export async function analyzeTls(host: string, port = 443): Promise<TlsInfo> {
  // Probe all versions in parallel
  const probes = TLS_VERSIONS.map((v) => probeVersion(host, port, v.min, v.max, v.name));
  const results = await Promise.allSettled(probes);

  const supported: string[] = [];
  const weakCiphers: string[] = [];
  let hasTls10 = false;
  let hasTls11 = false;
  let hasTls12 = false;
  let hasTls13 = false;

  for (const settled of results) {
    if (settled.status !== 'fulfilled') continue;
    const { version, supported: isSupported, cipher } = settled.value;

    if (!isSupported) continue;

    supported.push(version);

    if (version === 'TLS 1.0') hasTls10 = true;
    if (version === 'TLS 1.1') hasTls11 = true;
    if (version === 'TLS 1.2') hasTls12 = true;
    if (version === 'TLS 1.3') hasTls13 = true;

    if (cipher && isWeakCipher(cipher)) {
      weakCiphers.push(cipher);
    }
  }

  // Additionally probe for weak ciphers on TLS 1.2 (which supports the widest cipher range)
  if (hasTls12) {
    try {
      const weakProbe = await probeWithWeakCiphers(host, port);
      for (const cipher of weakProbe) {
        if (!weakCiphers.includes(cipher)) {
          weakCiphers.push(cipher);
        }
      }
    } catch {
      // Best-effort weak cipher detection
    }
  }

  return {
    hasTls10,
    hasTls11,
    hasTls12,
    hasTls13,
    hasWeakCiphers: weakCiphers.length > 0,
    weakCipherList: weakCiphers,
    supportedVersions: supported,
  };
}

/**
 * Attempt to connect with a cipher list that only includes weak ciphers.
 * If the connection succeeds, the server supports at least one weak cipher.
 */
function probeWithWeakCiphers(host: string, port: number): Promise<string[]> {
  const weakCipherString = [
    'RC4-SHA',
    'RC4-MD5',
    'DES-CBC3-SHA',
    'DES-CBC-SHA',
    'EXP-RC4-MD5',
    'EXP-DES-CBC-SHA',
    'NULL-SHA',
    'NULL-MD5',
  ].join(':');

  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        ciphers: weakCipherString,
        rejectUnauthorized: false,
        timeout: CONNECT_TIMEOUT_MS,
      },
      () => {
        const cipher = socket.getCipher();
        socket.destroy();
        resolve(cipher?.name ? [cipher.name] : []);
      },
    );

    socket.on('error', () => {
      socket.destroy();
      resolve([]);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve([]);
    });
  });
}

// -------------------------------------------------------------------------
// Step runner
// -------------------------------------------------------------------------

export async function runTlsAnalysisStep(domain: string): Promise<StepResult> {
  const startedAt = new Date();

  try {
    const tlsInfo = await analyzeTls(domain);

    return {
      step: 'tls_analysis',
      status: 'success',
      data: {
        ...tlsInfo,
      },
      startedAt,
      completedAt: new Date(),
    };
  } catch (err) {
    return {
      step: 'tls_analysis',
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date(),
    };
  }
}
