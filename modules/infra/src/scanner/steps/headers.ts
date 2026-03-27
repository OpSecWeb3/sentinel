/**
 * Step 5: HTTP security headers analysis.
 *
 * Fetches the host over HTTPS (falling back to HTTP), then parses security
 * headers: HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
 * Permissions-Policy. Scores each header.
 */
import type { HeaderInfo, StepResult } from '../types.js';

const FETCH_TIMEOUT_MS = 10_000;

// -------------------------------------------------------------------------
// Header analysis
// -------------------------------------------------------------------------

export async function checkSecurityHeaders(domain: string): Promise<HeaderInfo> {
  const headers = await fetchHeaders(domain);

  const hstsValue = headers.get('strict-transport-security');
  const cspValue = headers.get('content-security-policy');
  const xFrameOptions = headers.get('x-frame-options');
  const xContentTypeOptions = headers.get('x-content-type-options');
  const referrerPolicy = headers.get('referrer-policy');
  const permissionsPolicy =
    headers.get('permissions-policy') || headers.get('feature-policy');
  const serverHeader = headers.get('server');

  return {
    hstsPresent: hstsValue !== null,
    hstsValue: hstsValue,
    cspPresent: cspValue !== null,
    cspValue: cspValue,
    xFrameOptions: xFrameOptions,
    xContentTypeOptions: xContentTypeOptions?.toLowerCase() === 'nosniff',
    referrerPolicy: referrerPolicy,
    permissionsPolicy: permissionsPolicy,
    serverHeaderPresent: serverHeader !== null,
    serverHeaderValue: serverHeader,
  };
}

/**
 * Fetch response headers from the domain, trying HTTPS first then HTTP.
 */
async function fetchHeaders(domain: string): Promise<Headers> {
  for (const scheme of ['https', 'http'] as const) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(`${scheme}://${domain}`, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.headers;
    } catch {
      continue;
    }
  }

  throw new Error(`Failed to fetch headers from ${domain} over HTTPS and HTTP`);
}

/**
 * Score individual headers. Returns a list of findings with severity.
 */
export function scoreHeaders(
  info: HeaderInfo,
): Array<{ header: string; present: boolean; severity: string; points: number }> {
  const findings: Array<{
    header: string;
    present: boolean;
    severity: string;
    points: number;
  }> = [];

  findings.push({
    header: 'Strict-Transport-Security',
    present: info.hstsPresent,
    severity: info.hstsPresent ? 'pass' : 'high',
    points: info.hstsPresent ? 0 : 10,
  });

  findings.push({
    header: 'Content-Security-Policy',
    present: info.cspPresent,
    severity: info.cspPresent ? 'pass' : 'high',
    points: info.cspPresent ? 0 : 15,
  });

  findings.push({
    header: 'X-Frame-Options',
    present: info.xFrameOptions !== null,
    severity: info.xFrameOptions !== null ? 'pass' : 'low',
    points: info.xFrameOptions !== null ? 0 : 5,
  });

  findings.push({
    header: 'X-Content-Type-Options',
    present: info.xContentTypeOptions,
    severity: info.xContentTypeOptions ? 'pass' : 'low',
    points: info.xContentTypeOptions ? 0 : 3,
  });

  findings.push({
    header: 'Referrer-Policy',
    present: info.referrerPolicy !== null,
    severity: info.referrerPolicy !== null ? 'pass' : 'low',
    points: info.referrerPolicy !== null ? 0 : 3,
  });

  findings.push({
    header: 'Server',
    present: !info.serverHeaderPresent,
    severity: info.serverHeaderPresent ? 'low' : 'pass',
    points: info.serverHeaderPresent ? 2 : 0,
  });

  return findings;
}

// -------------------------------------------------------------------------
// Step runner
// -------------------------------------------------------------------------

export async function runHeadersStep(domain: string): Promise<StepResult> {
  const startedAt = new Date();

  try {
    const headerInfo = await checkSecurityHeaders(domain);
    const headerScores = scoreHeaders(headerInfo);

    return {
      step: 'headers',
      status: 'success',
      data: {
        ...headerInfo,
        scores: headerScores,
      },
      startedAt,
      completedAt: new Date(),
    };
  } catch (err) {
    return {
      step: 'headers',
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date(),
    };
  }
}
