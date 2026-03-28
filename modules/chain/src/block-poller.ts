/**
 * Block polling logic for the chain module.
 *
 * Ported from ChainAlert's block-poller/index.ts. This is the heart of
 * the on-chain monitoring system: it fetches new blocks, extracts logs,
 * and enqueues block-data jobs for processing by the event matcher.
 *
 * In Sentinel, this runs as a BullMQ job handler (chain.block.poll)
 * rather than a long-running loop. The Sentinel scheduler invokes it
 * on a repeatable cadence per network.
 *
 * KNOWN LIMITATION — BullMQ scheduling jitter at fast block times:
 * BullMQ repeatable jobs fire on a fixed interval set at registration time,
 * not immediately after the previous poll completes. Under Redis load this
 * introduces ~100-500ms scheduling jitter, and if a poll takes longer than
 * the interval the next invocation is delayed rather than self-correcting.
 * For Ethereum mainnet (12s blocks) this is acceptable — the cursor-gap
 * logic handles any missed blocks regardless of timing. For chains with
 * sub-second block times (Arbitrum ~250ms, Base ~2s at high throughput)
 * this becomes a real constraint. At that point the block poller should be
 * converted to a dedicated long-running loop (see ChainAlert's block-poller
 * for the reference implementation) running alongside the BullMQ worker in
 * the same process via Promise.all. The state poller stays BullMQ either way.
 */
import { logger as rootLogger } from '@sentinel/shared/logger';
import { eq, and, inArray, sql } from '@sentinel/db';
import { getDb } from '@sentinel/db';

const log = rootLogger.child({ component: 'chain-block-poller' });
import {
  chainNetworks,
  chainContracts,
  chainBlockCursors,
  chainOrgRpcConfigs,
} from '@sentinel/db/schema/chain';
import { rules } from '@sentinel/db/schema/core';
import { createRpcClient, type RpcClient, type RpcLog, type RpcTransaction } from './rpc.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NetworkConfig {
  slug: string;
  chainKey: string;
  networkId: number;
  chainId: number;
  rpcUrls: string[];
  /** Average block time in milliseconds */
  blockTimeMs: number;
}

export interface BlockData {
  networkSlug: string;
  chainId: number;
  blockNumber: string;
  logs: RpcLog[];
  transactions?: RpcTransaction[];
}

// ---------------------------------------------------------------------------
// Constants (ported from ChainAlert)
// ---------------------------------------------------------------------------

/** Maximum blocks to process in a single poll tick */
const MAX_BLOCKS_PER_TICK = 50;

/** When the gap exceeds this, skip ahead to near the chain tip */
const MAX_CATCH_UP_BLOCKS = 1000;

/** How many recent blocks to keep when skipping ahead */
const SKIP_LOOKBACK_BLOCKS = 10;

// ---------------------------------------------------------------------------
// DB helpers (Drizzle ORM)
// ---------------------------------------------------------------------------

async function getLastBlock(networkId: number): Promise<bigint> {
  const db = getDb();
  const rows = await db
    .select({ lastBlock: chainBlockCursors.lastBlock })
    .from(chainBlockCursors)
    .where(eq(chainBlockCursors.networkId, networkId));

  if (rows.length === 0) return 0n;
  return rows[0]!.lastBlock;
}

export async function updateBlockCursor(
  networkId: number,
  blockNumber: bigint,
): Promise<void> {
  const db = getDb();
  await db
    .insert(chainBlockCursors)
    .values({
      networkId,
      lastBlock: blockNumber,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: chainBlockCursors.networkId,
      set: {
        lastBlock: blockNumber,
        updatedAt: new Date(),
      },
    });
}

/**
 * Returns network slugs that have at least one active block-dependent rule.
 * Block-dependent rules: event-match, windowed-count, windowed-spike,
 * balance-track, function-call-match.
 */
export async function getNetworkSlugsWithBlockRules(): Promise<string[]> {
  const db = getDb();

  // In Sentinel the rules table uses `rule_type` and `module_id = 'chain'`
  const rows = await db
    .select({ slug: chainNetworks.slug })
    .from(rules)
    .innerJoin(chainNetworks, eq(sql`(${rules.config}->>'networkId')::int`, chainNetworks.chainId))
    .where(
      and(
        eq(rules.status, 'active'),
        eq(rules.moduleId, 'chain'),
        inArray(rules.ruleType, [
          'chain.event_match',
          'chain.windowed_count',
          'chain.windowed_spike',
          'chain.balance_track',
          'chain.function_call_match',
        ]),
      ),
    );

  return [...new Set(rows.map((r) => r.slug))];
}

// ---------------------------------------------------------------------------
// Cached function-call-match rule checker (30s TTL)
// Determines which contract addresses need full transaction data
// ---------------------------------------------------------------------------

interface FnCallInfo {
  has: boolean;
  addresses: Set<string>;
}

const fnCallInfoCache = new Map<number, { info: FnCallInfo; expiresAt: number }>();
const FN_CALL_CACHE_TTL = 30_000;

async function getCachedFnCallInfo(networkId: number): Promise<FnCallInfo> {
  const cached = fnCallInfoCache.get(networkId);
  if (cached && Date.now() < cached.expiresAt) return cached.info;

  const db = getDb();

  // Find addresses of contracts that have function-call-match rules
  const rows = await db
    .select({ address: chainContracts.address })
    .from(rules)
    .innerJoin(chainContracts, eq(
      chainContracts.id,
      sql`(${rules.config}->>'contractId')::int`,
    ))
    .where(
      and(
        // Use canonical rule type string; legacy 'function-call-match' is never stored
        // in the DB — all rules are written with the dot-separated canonical form.
        eq(rules.ruleType, 'chain.function_call_match'),
        eq(rules.status, 'active'),
        eq(rules.moduleId, 'chain'),
      ),
    );

  const addresses = new Set(rows.map((r) => r.address.toLowerCase()));
  const info: FnCallInfo = { has: addresses.size > 0, addresses };
  fnCallInfoCache.set(networkId, { info, expiresAt: Date.now() + FN_CALL_CACHE_TTL });
  return info;
}

// ---------------------------------------------------------------------------
// Network config loader
// ---------------------------------------------------------------------------

function getRpcUrls(chainKey: string): string[] | null {
  const envVar = `RPC_${chainKey.toUpperCase()}`;
  const value = process.env[envVar];
  if (!value) return null;
  const urls = value.split(',').map((s) => s.trim()).filter(Boolean);
  return urls.length > 0 ? urls : null;
}

export async function loadNetworkConfig(
  networkSlug: string,
  orgId?: string,
): Promise<NetworkConfig> {
  const db = getDb();
  const rows = await db
    .select()
    .from(chainNetworks)
    .where(eq(chainNetworks.slug, networkSlug))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`Unknown network: ${networkSlug}`);
  }

  const row = rows[0]!;

  let rpcUrls: string[] = row.rpcUrl.split(',').map((s) => s.trim()).filter(Boolean);

  const envRpcUrls = getRpcUrls(row.chainKey);
  if (envRpcUrls !== null) {
    rpcUrls = envRpcUrls;
  }

  if (orgId) {
    const orgRpc = await db
      .select({ rpcUrl: chainOrgRpcConfigs.rpcUrl })
      .from(chainOrgRpcConfigs)
      .where(
        and(
          eq(chainOrgRpcConfigs.orgId, orgId),
          eq(chainOrgRpcConfigs.networkId, row.id),
          eq(chainOrgRpcConfigs.isActive, true),
        ),
      )
      .limit(1);

    if (orgRpc.length > 0) {
      rpcUrls = orgRpc[0]!.rpcUrl.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  return {
    slug: networkSlug,
    chainKey: row.chainKey,
    networkId: row.id,
    chainId: row.chainId,
    rpcUrls,
    blockTimeMs: row.blockTimeMs,
  };
}

// ---------------------------------------------------------------------------
// Core: poll a single tick for a network
// ---------------------------------------------------------------------------

/**
 * Poll once for a network: fetch the latest block number, compare against
 * the stored cursor, fetch logs (and optionally transactions) for the gap,
 * and return an array of BlockData jobs to enqueue.
 *
 * This is the faithful port of ChainAlert's `pollOnce` function, adapted
 * to return data instead of directly enqueuing to a BullMQ queue.
 */
export interface PollResult {
  blockDataJobs: BlockData[];
  advanceCursorTo: bigint;
}

export async function pollOnce(
  client: RpcClient,
  config: NetworkConfig,
): Promise<PollResult> {
  let lastBlock = await getLastBlock(config.networkId);
  const latestBlock = await client.getBlockNumber();

  // Guard: cursor somehow ahead of chain tip -- reset to chain tip.
  // Can happen if an RPC briefly reported an inflated block number.
  if (lastBlock > latestBlock) {
    log.warn({ networkSlug: config.slug, cursor: lastBlock.toString(), chainTip: latestBlock.toString() }, 'cursor ahead of chain tip, resetting');
    await updateBlockCursor(config.networkId, latestBlock);
    return { blockDataJobs: [], advanceCursorTo: latestBlock };
  }

  if (latestBlock === lastBlock) return { blockDataJobs: [], advanceCursorTo: lastBlock };

  const gap = Number(latestBlock - lastBlock);

  // Auto-skip: if gap is too large, fast-forward to near the chain tip
  if (MAX_CATCH_UP_BLOCKS > 0 && gap > MAX_CATCH_UP_BLOCKS) {
    const skipTo = latestBlock - BigInt(SKIP_LOOKBACK_BLOCKS);
    log.warn({ networkSlug: config.slug, gap, cursor: lastBlock.toString(), chainTip: latestBlock.toString(), skipTo: skipTo.toString(), lookback: SKIP_LOOKBACK_BLOCKS }, 'gap too large, skipping ahead');
    await updateBlockCursor(config.networkId, skipTo);
    lastBlock = skipTo;
  }

  const remainingGap = Number(latestBlock - lastBlock);
  const to =
    remainingGap > MAX_BLOCKS_PER_TICK
      ? lastBlock + BigInt(MAX_BLOCKS_PER_TICK)
      : latestBlock;

  if (remainingGap > MAX_BLOCKS_PER_TICK) {
    log.info({ networkSlug: config.slug, remainingGap, cursor: lastBlock.toString(), chainTip: latestBlock.toString(), catchUpCount: MAX_BLOCKS_PER_TICK }, 'catching up blocks');
  }

  // Check if any function-call-match rules exist for this network
  const fnCallInfo = await getCachedFnCallInfo(config.networkId);

  // Batch getLogs for the entire block range instead of one call per block
  const fromBlock = lastBlock + 1n;
  const allLogs = await client.getLogs({ fromBlock, toBlock: to });

  // Group logs by block number for per-block assembly
  const logsByBlock = new Map<string, RpcLog[]>();
  for (const l of allLogs) {
    const bn = l.blockNumber ?? String(fromBlock);
    let arr = logsByBlock.get(bn);
    if (!arr) {
      arr = [];
      logsByBlock.set(bn, arr);
    }
    arr.push(l);
  }

  // When function-call-match rules exist, fetch blocks with transactions in
  // parallel instead of serially.
  const txsByBlock = new Map<string, RpcTransaction[]>();
  if (fnCallInfo.has) {
    const blockNums: bigint[] = [];
    for (let blockNum = fromBlock; blockNum <= to; blockNum++) {
      blockNums.push(blockNum);
    }
    const blocks = await Promise.all(
      blockNums.map((bn) => client.getBlock(bn, true).then((b) => ({ bn, b }))),
    );
    for (const { bn, b } of blocks) {
      const fullTxs = b.transactions as RpcTransaction[];
      const filtered = fullTxs
        .filter(
          (tx) => tx.to && fnCallInfo.addresses.has(tx.to.toLowerCase()),
        )
        .map((tx) => ({
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          input: tx.input,
          value: tx.value,
          blockNumber: tx.blockNumber,
        }));
      if (filtered.length > 0) {
        txsByBlock.set(bn.toString(), filtered);
      }
    }
  }

  const blockDataJobs: BlockData[] = [];
  for (let blockNum = fromBlock; blockNum <= to; blockNum++) {
    const bnStr = blockNum.toString();
    const logs = logsByBlock.get(bnStr) ?? [];
    const transactions = txsByBlock.get(bnStr);
    blockDataJobs.push({
      networkSlug: config.slug,
      chainId: config.chainId,
      blockNumber: bnStr,
      logs: logs.map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: l.blockNumber,
        transactionHash: l.transactionHash,
        logIndex: l.logIndex,
        transactionIndex: l.transactionIndex,
      })),
      ...(transactions ? { transactions } : {}),
    });
  }

  // NOTE: cursor is NOT advanced here. The caller (blockPollHandler) must
  // advance the cursor after successful job enqueueing to avoid data loss
  // if enqueueing fails after cursor advancement.

  return { blockDataJobs, advanceCursorTo: to };
}

// ---------------------------------------------------------------------------
// Helper: resolve network ID from slug
// ---------------------------------------------------------------------------

export async function getNetworkIdBySlug(slug: string): Promise<number | null> {
  const db = getDb();
  const [network] = await db
    .select({ id: chainNetworks.id })
    .from(chainNetworks)
    .where(eq(chainNetworks.slug, slug))
    .limit(1);

  return network?.id ?? null;
}
