/**
 * In-memory RPC call counter with periodic DB flush.
 * Accumulates call counts per (bucket, method, status, context) and
 * upserts into chainRpcUsageHourly on flush.
 */
import { getDb } from '@sentinel/db';
import { chainRpcUsageHourly } from '@sentinel/db/schema/chain';
import { sql } from '@sentinel/db';
import { logger as rootLogger } from '@sentinel/shared/logger';

const log = rootLogger.child({ component: 'chain-rpc-usage' });

export interface RpcTrackingContext {
  orgId?: string;
  networkSlug?: string;
  templateSlug?: string;
  detectionId?: string;
}

interface CounterKey {
  bucket: Date;
  orgId: string;
  networkSlug: string;
  templateSlug: string;
  detectionId: string;
  rpcMethod: string;
  status: string;
}

function hourBucket(): Date {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  return now;
}

function keyString(k: CounterKey): string {
  return `${k.bucket.toISOString()}|${k.orgId}|${k.networkSlug}|${k.templateSlug}|${k.detectionId}|${k.rpcMethod}|${k.status}`;
}

const counters = new Map<string, { key: CounterKey; count: number }>();

export function trackRpcCall(
  method: string,
  status: 'ok' | 'error',
  context?: RpcTrackingContext,
): void {
  const key: CounterKey = {
    bucket: hourBucket(),
    orgId: context?.orgId ?? '_system',
    networkSlug: context?.networkSlug ?? '_unknown',
    templateSlug: context?.templateSlug ?? '_unknown',
    detectionId: context?.detectionId ?? '_system',
    rpcMethod: method,
    status,
  };

  const ks = keyString(key);
  const existing = counters.get(ks);
  if (existing) {
    existing.count++;
  } else {
    counters.set(ks, { key, count: 1 });
  }
}

export async function flushCounters(): Promise<void> {
  if (counters.size === 0) return;

  // Snapshot and clear
  const snapshot = Array.from(counters.values());
  counters.clear();

  const db = getDb();

  for (const { key, count } of snapshot) {
    try {
      await db
        .insert(chainRpcUsageHourly)
        .values({
          bucket: key.bucket,
          orgId: key.orgId,
          networkSlug: key.networkSlug,
          templateSlug: key.templateSlug,
          detectionId: key.detectionId,
          rpcMethod: key.rpcMethod,
          status: key.status,
          callCount: count,
        })
        .onConflictDoUpdate({
          target: [
            chainRpcUsageHourly.bucket,
            chainRpcUsageHourly.orgId,
            chainRpcUsageHourly.networkSlug,
            chainRpcUsageHourly.templateSlug,
            chainRpcUsageHourly.detectionId,
            chainRpcUsageHourly.rpcMethod,
            chainRpcUsageHourly.status,
          ],
          set: {
            callCount: sql`${chainRpcUsageHourly.callCount} + ${count}`,
          },
        });
    } catch (err) {
      log.error({ err }, 'flush error');
      // Re-add to counters on failure
      const ks = keyString(key);
      const existing = counters.get(ks);
      if (existing) {
        existing.count += count;
      } else {
        counters.set(ks, { key, count });
      }
    }
  }
}
