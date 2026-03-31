/**
 * Normalizes scan and probe results into platform events.
 *
 * Each normalizer function returns zero or more event inputs to be inserted
 * into the events table and dispatched for rule evaluation.
 */
import { getDb } from '@sentinel/db';
import { infraReachabilityChecks } from '@sentinel/db/schema/infra';
import { eq, desc } from '@sentinel/db';
import type { ScanResult } from './scanner/orchestrator.js';
import type { ProbeResult, StepResult, StepName } from './scanner/types.js';

interface NormalizedEventInput {
  eventType: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Full scan result -> events
// ---------------------------------------------------------------------------

export function normalizeScanResult(
  result: ScanResult,
  orgId: string,
): NormalizedEventInput[] {
  const out: NormalizedEventInput[] = [];
  const hostname = result.hostName;

  const stepMap = new Map<StepName, StepResult>();
  for (const step of result.stepResults) {
    stepMap.set(step.step, step);
  }

  // ── Certificate events ──────────────────────────────────────────────
  const certStep = stepMap.get('certificate');
  if (certStep?.status === 'success' && certStep.data) {
    const cert = certStep.data;
    const notAfterStr = cert.notAfter as string | undefined;
    if (notAfterStr) {
      const notAfter = new Date(notAfterStr);
      const daysRemaining = Math.floor((notAfter.getTime() - Date.now()) / 86_400_000);

      if (daysRemaining <= 0) {
        out.push({
          eventType: 'infra.cert.expired',
          payload: { resourceId: hostname, hostname, daysRemaining, notAfter: notAfterStr, subject: cert.subject },
        });
      } else if (daysRemaining <= 30) {
        out.push({
          eventType: 'infra.cert.expiring',
          payload: { resourceId: hostname, hostname, daysRemaining, notAfter: notAfterStr, subject: cert.subject },
        });
      }
    }

    // Certificate issues from the detectCertIssues() step
    const issues = cert.issues as Array<{ issue: string; severity: string }> | undefined;
    if (issues) {
      for (const issue of issues) {
        let issueType = 'unknown';
        const lower = issue.issue.toLowerCase();
        if (lower.includes('chain')) issueType = 'chain_error';
        else if (lower.includes('self-signed')) issueType = 'self_signed';
        else if (lower.includes('weak key')) issueType = 'weak_key';
        else if (lower.includes('sha-1') || lower.includes('sha1')) issueType = 'sha1_signature';
        else if (lower.includes('expired') || lower.includes('expires')) continue; // handled above

        out.push({
          eventType: 'infra.cert.issue',
          payload: {
            resourceId: hostname,
            hostname,
            issueType,
            detail: issue.issue,
            subject: cert.subject,
            issuer: cert.issuer,
          },
        });
      }
    }
  }

  // ── TLS weaknesses ──────────────────────────────────────────────────
  const tlsStep = stepMap.get('tls_analysis');
  if (tlsStep?.status === 'success' && tlsStep.data) {
    const tls = tlsStep.data;
    const hasTls10 = (tls.hasTls10 as boolean) ?? false;
    const hasTls11 = (tls.hasTls11 as boolean) ?? false;
    const hasWeakCiphers = (tls.hasWeakCiphers as boolean) ?? false;
    const hasTls13 = (tls.hasTls13 as boolean) ?? false;

    const legacyVersions: string[] = [];
    if (hasTls10) legacyVersions.push('TLS 1.0');
    if (hasTls11) legacyVersions.push('TLS 1.1');

    if (legacyVersions.length > 0 || hasWeakCiphers) {
      out.push({
        eventType: 'infra.tls.weakness',
        payload: {
          resourceId: hostname,
          hostname,
          hasTls10,
          hasTls11,
          hasTls13,
          hasWeakCiphers,
          weakCipherList: (tls.weakCipherList as string[]) ?? [],
          legacyVersions,
        },
      });
    }
  }

  // ── DNS changes ─────────────────────────────────────────────────────
  const dnsStep = stepMap.get('dns_records');
  if (dnsStep?.status === 'success' && dnsStep.data) {
    const changes = dnsStep.data.changes as Array<Record<string, unknown>> | undefined;
    if (changes && changes.length > 0) {
      out.push({
        eventType: 'infra.dns.change',
        payload: {
          resourceId: hostname,
          hostname,
          changes: changes.map((c) => ({
            recordType: c.recordType,
            changeType: c.changeType,
            oldValue: c.oldValue ?? undefined,
            newValue: c.newValue ?? undefined,
            severity: c.severity ?? undefined,
          })),
        },
      });
    }
  }

  // ── Missing headers ─────────────────────────────────────────────────
  const headerStep = stepMap.get('headers');
  if (headerStep?.status === 'success' && headerStep.data) {
    const scores = headerStep.data.scores as Array<Record<string, unknown>> | undefined;
    if (scores) {
      const missing = scores
        .filter((s) => !s.present && s.severity !== 'pass')
        .map((s) => s.header as string);

      if (missing.length > 0) {
        out.push({
          eventType: 'infra.header.missing',
          payload: { resourceId: hostname, hostname, missingHeaders: missing },
        });
      }
    }
  }

  // ── New subdomains from CT logs ─────────────────────────────────────
  const ctStep = stepMap.get('ct_logs');
  const subdomainSeen = new Set<string>();
  if (ctStep?.status === 'success' && ctStep.data) {
    const entries = ctStep.data.entries as Array<Record<string, unknown>> | undefined;
    if (entries && hostname) {
      const lowerHostname = hostname.toLowerCase();
      for (const entry of entries) {
        const nameValue = entry.nameValue as string | undefined;
        if (!nameValue) continue;
        for (const name of nameValue.split('\n')) {
          const cn = name.trim().toLowerCase().replace(/^\*\./, '');
          if (cn !== lowerHostname && cn.endsWith(`.${lowerHostname}`) && !subdomainSeen.has(cn)) {
            subdomainSeen.add(cn);
            out.push({
              eventType: 'infra.subdomain.discovered',
              payload: { resourceId: hostname, parentHostname: hostname, subdomain: cn, source: 'crt_sh' },
            });
          }
        }
      }
    }
  }

  // ── New subdomains from VirusTotal passive DNS ─────────────────────────
  // VT data rides on the ct_logs step data bag. The orchestrator ensures the
  // data bag exists even when ct_logs itself errored, so this works regardless
  // of ct_logs status.
  const vtSubdomains = ctStep?.data?.vtSubdomains as string[] | undefined;
  if (vtSubdomains && hostname) {
    const lowerHostname = hostname.toLowerCase();
    for (const sub of vtSubdomains) {
      const cn = sub.trim().toLowerCase();
      if (cn !== lowerHostname && cn.endsWith(`.${lowerHostname}`) && !subdomainSeen.has(cn)) {
        subdomainSeen.add(cn);
        out.push({
          eventType: 'infra.subdomain.discovered',
          payload: { resourceId: hostname, parentHostname: hostname, subdomain: cn, source: 'virustotal' },
        });
      }
    }
  }

  // ── WHOIS expiry ──────────────────────────────────────────────────────
  const whoisStep = stepMap.get('whois');
  if (whoisStep?.status === 'success' && whoisStep.data) {
    const expiryDate = whoisStep.data.expiryDate as string | undefined;
    if (expiryDate) {
      const expiry = new Date(expiryDate);
      const daysRemaining = Math.floor((expiry.getTime() - Date.now()) / 86_400_000);
      if (daysRemaining <= 90) {
        out.push({
          eventType: 'infra.whois.expiring',
          payload: {
            resourceId: hostname,
            hostname,
            daysRemaining,
            expiryDate,
            registrar: whoisStep.data.registrar ?? null,
          },
        });
      }
    }
  }

  // ── CT log new entries ────────────────────────────────────────────────
  const ctStepForNewEntries = stepMap.get('ct_logs');
  if (ctStepForNewEntries?.status === 'success' && ctStepForNewEntries.data) {
    const ctEntries = ctStepForNewEntries.data.entries as Array<Record<string, unknown>> | undefined;
    if (ctEntries) {
      for (const entry of ctEntries) {
        out.push({
          eventType: 'infra.ct.new_entry',
          payload: {
            resourceId: hostname,
            hostname,
            crtShId: entry.crtShId ?? null,
            issuerName: entry.issuerName ?? null,
            commonName: entry.commonName ?? null,
            nameValue: entry.nameValue ?? null,
            serialNumber: entry.serialNumber ?? null,
            notBefore: entry.notBefore ?? null,
            notAfter: entry.notAfter ?? null,
            entryTimestamp: entry.entryTimestamp ?? null,
          },
        });
      }
    }
  }

  // ── Score degradation ───────────────────────────────────────────────
  // The score is in result.score; previous score would need to be fetched
  // by the handler and passed in details. For now we emit if score < 70.
  if (result.score !== undefined && result.score < 70) {
    out.push({
      eventType: 'infra.score.degraded',
      payload: {
        resourceId: hostname,
        hostname,
        currentScore: result.score,
        previousScore: null, // caller can enrich with previous score
        grade: result.grade,
      },
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Probe result -> events
// ---------------------------------------------------------------------------

export async function normalizeProbeResult(
  result: ProbeResult,
  orgId: string,
): Promise<NormalizedEventInput[]> {
  const out: NormalizedEventInput[] = [];
  const hostname = result.hostName;

  // Host unreachable — look up actual consecutive failures from DB
  if (!result.isReachable) {
    let consecutiveFailures = 1;
    try {
      const db = getDb();
      const recentChecks = await db
        .select({ isReachable: infraReachabilityChecks.isReachable })
        .from(infraReachabilityChecks)
        .where(eq(infraReachabilityChecks.hostId, result.hostId))
        .orderBy(desc(infraReachabilityChecks.checkedAt))
        .limit(20);

      // Count how many of the most recent checks were also failures
      for (const check of recentChecks) {
        if (!check.isReachable) {
          consecutiveFailures++;
        } else {
          break;
        }
      }
    } catch {
      // If DB lookup fails, fall back to 1
    }

    out.push({
      eventType: 'infra.host.unreachable',
      payload: {
        resourceId: hostname,
        hostname,
        consecutiveFailures,
        isReachable: false,
        dnsResolved: result.dnsResolved,
        httpStatus: result.httpStatus,
        errorMessage: null,
      },
    });
  }

  // Slow response (only if reachable)
  if (result.isReachable && result.responseTimeMs !== null && result.responseTimeMs >= 5000) {
    out.push({
      eventType: 'infra.host.slow',
      payload: { resourceId: hostname, hostname, responseTimeMs: result.responseTimeMs },
    });
  }

  // DNS changes from probe
  if (result.dnsChanged && result.dnsChanges.length > 0) {
    out.push({
      eventType: 'infra.dns.change',
      payload: {
        resourceId: hostname,
        hostname,
        changes: result.dnsChanges.map((c) => ({
          recordType: c.recordType,
          changeType: c.changeType,
          oldValue: c.oldValue ?? undefined,
          newValue: c.newValue ?? undefined,
          severity: c.severity,
        })),
      },
    });
  }

  return out;
}
