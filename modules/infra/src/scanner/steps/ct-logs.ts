/**
 * Step 6: Certificate Transparency log query.
 *
 * Queries the crt.sh API for CT log entries. Uses concurrency limiting
 * from packages/shared/concurrency.ts to avoid overwhelming the crt.sh API.
 */
import type { Redis } from 'ioredis';

import { logger as rootLogger } from '@sentinel/shared/logger';
import { acquireSlot, releaseSlot } from '@sentinel/shared/concurrency';

const log = rootLogger.child({ component: 'infra-ct-logs' });
import type { CtLogEntry, StepResult } from '../types.js';

const CRTSH_API = 'https://crt.sh';
const FETCH_TIMEOUT_MS = 30_000;
const CONCURRENCY_KEY = 'slot:crtsh';
const MAX_CONCURRENT = 5;

// -------------------------------------------------------------------------
// crt.sh API
// -------------------------------------------------------------------------

interface CrtShEntry {
  issuer_ca_id: number;
  issuer_name: string;
  common_name: string;
  name_value: string;
  serial_number: string;
  not_before: string;
  not_after: string;
  entry_timestamp: string;
  id: number;
}

async function queryCrtSh(domain: string): Promise<CtLogEntry[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const url = `${CRTSH_API}/?q=${encodeURIComponent(domain)}&output=json`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`crt.sh returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as CrtShEntry[];

    // Deduplicate by serial number
    const seen = new Set<string>();
    const entries: CtLogEntry[] = [];

    for (const entry of data) {
      const serial = entry.serial_number;
      if (seen.has(serial)) continue;
      seen.add(serial);

      entries.push({
        crtShId: entry.id,
        issuerName: entry.issuer_name,
        commonName: entry.common_name,
        nameValue: entry.name_value,
        serialNumber: serial,
        notBefore: entry.not_before,
        notAfter: entry.not_after,
        entryTimestamp: entry.entry_timestamp,
      });
    }

    return entries;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * Extract unique issuers from CT log entries.
 */
function extractIssuers(entries: CtLogEntry[]): string[] {
  const issuers = new Set<string>();
  for (const entry of entries) {
    // Extract the O= (organization) from the issuer DN
    const match = entry.issuerName.match(/O=([^,]+)/);
    if (match) {
      issuers.add(match[1].trim());
    }
  }
  return [...issuers];
}

// -------------------------------------------------------------------------
// Step runner
// -------------------------------------------------------------------------

export async function runCtLogsStep(
  domain: string,
  options: { isRoot: boolean; redis?: Redis },
): Promise<StepResult> {
  const startedAt = new Date();

  if (!options.isRoot) {
    return { step: 'ct_logs', status: 'skipped', startedAt, completedAt: new Date() };
  }

  let acquired = false;

  try {
    // Acquire concurrency slot if Redis is available
    if (options.redis) {
      acquired = await acquireSlot(options.redis, CONCURRENCY_KEY, MAX_CONCURRENT);
      if (!acquired) {
        log.info({ domain }, 'crt.sh concurrency limit reached');
        return {
          step: 'ct_logs',
          status: 'success',
          data: {
            ctLogEntries: 0,
            ctNewEntries: 0,
            ctIssuers: [],
            rateLimited: true,
          },
          startedAt,
          completedAt: new Date(),
        };
      }
    }

    const entries = await queryCrtSh(domain);
    const issuers = extractIssuers(entries);

    return {
      step: 'ct_logs',
      status: 'success',
      data: {
        entries,
        ctLogEntries: entries.length,
        ctIssuers: issuers,
      },
      startedAt,
      completedAt: new Date(),
    };
  } catch (err) {
    return {
      step: 'ct_logs',
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date(),
    };
  } finally {
    if (acquired && options.redis) {
      await releaseSlot(options.redis, CONCURRENCY_KEY);
    }
  }
}
