/**
 * Chain module BullMQ job handlers.
 *
 * Ported from ChainAlert's worker infrastructure:
 *   - block-poller/index.ts  -> chain.block.poll
 *   - event-matcher/index.ts -> chain.block.process
 *   - state-poller/index.ts  -> chain.state.poll
 *   - state-poller (rule-sync worker) -> chain.rule.sync
 *
 * Follows the same JobHandler pattern as the GitHub and release-chain modules.
 */
import type { Job } from 'bullmq';
import { logger as rootLogger } from '@sentinel/shared/logger';
import { eq, and, inArray, or, isNull, lt } from '@sentinel/db';
import { getDb } from '@sentinel/db';
import { events, rules, detections } from '@sentinel/db/schema/core';
import {
  chainContracts,
  chainNetworks,
  chainStateSnapshots,
} from '@sentinel/db/schema/chain';
import { fetchContractAbi } from './etherscan.js';
import { WELL_KNOWN_SLOTS } from './well-known-slots.js';
import { flushCounters } from './rpc-usage.js';
import { getQueue, QUEUE_NAMES, type JobHandler } from '@sentinel/shared/queue';
import {
  createRpcClient,
  getTokenBalance,
  callViewFunction,
} from './rpc.js';
import {
  pollOnce,
  loadNetworkConfig,
  getNetworkIdBySlug,
  updateBlockCursor,
} from './block-poller.js';
import {
  normalizeMatchedEvent,
  normalizeStateChanged,
  summarizeBlockProcessed,
  type MatchedEventInput,
  type StateChangedInput,
} from './normalizer.js';
import { decodeLog, decodeFunctionCallData } from './decoder.js';
import { detectTraits } from './traits.js';
import { getChildResults } from '@sentinel/shared/fan-out';
import { toFunctionSelector } from 'viem';

const log = rootLogger.child({ component: 'chain' });

// ---------------------------------------------------------------------------
// Canonical rule type constants
// ---------------------------------------------------------------------------

const RULE_TYPE = {
  EVENT_MATCH: 'chain.event_match',
  WINDOWED_COUNT: 'chain.windowed_count',
  WINDOWED_SPIKE: 'chain.windowed_spike',
  BALANCE_TRACK: 'chain.balance_track',
  STATE_POLL: 'chain.state_poll',
  VIEW_CALL: 'chain.view_call',
  FUNCTION_CALL_MATCH: 'chain.function_call_match',
} as const;

/** Map legacy ChainAlert rule type strings to canonical Sentinel form. */
const LEGACY_TYPE_MAP: Record<string, string> = {
  'event-match': RULE_TYPE.EVENT_MATCH,
  'windowed-count': RULE_TYPE.WINDOWED_COUNT,
  'windowed-spike': RULE_TYPE.WINDOWED_SPIKE,
  'balance-track': RULE_TYPE.BALANCE_TRACK,
  'state-poll': RULE_TYPE.STATE_POLL,
  'view-call': RULE_TYPE.VIEW_CALL,
  'function-call-match': RULE_TYPE.FUNCTION_CALL_MATCH,
};

/** Normalize a rule type to canonical form, handling legacy strings. */
function canonicalType(ruleType: string): string {
  return LEGACY_TYPE_MAP[ruleType] ?? ruleType;
}

// ---------------------------------------------------------------------------
// Common types (ported from ChainAlert)
// ---------------------------------------------------------------------------

interface LogEntry {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string | null;
  transactionHash: string;
  logIndex: number | null;
  transactionIndex: number | null;
}

interface TransactionEntry {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  blockNumber: string | null;
}

interface BlockDataJob {
  networkSlug: string;
  chainId: number;
  blockNumber: string;
  logs: LogEntry[];
  transactions?: TransactionEntry[];
}

interface Condition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'not_contains';
  value: unknown;
}

interface DetectionRule {
  id: string;
  detectionId: string;
  orgId: string;
  networkSlug: string;
  chainId: number;
  /** topic0 (event selector) to match against */
  topic0: string;
  /** Optional address filter (lowercase) */
  contractAddress?: string;
  conditions: Condition[];
  /** Windowed aggregation config */
  window?: { durationMs: number; threshold: number };
  /** Windowed spike detection config */
  spike?: {
    observationMs: number;
    baselineMs: number;
    increasePercent: number;
    minBaselineCount: number;
  };
  /** Field name to group by for windowed rules */
  groupByField?: string;
  /** Channel IDs for notification routing */
  channelIds: string[];
  /** Match type label */
  matchType: 'chain.event_match' | 'chain.windowed_count' | 'chain.windowed_spike';
}

interface FunctionCallRule {
  id: string;
  detectionId: string;
  orgId: string;
  networkSlug: string;
  chainId: number;
  /** 4-byte selector (0x prefixed, lowercase) */
  selector: string;
  /** Monitored contract address (lowercase) */
  contractAddress: string;
  /** Function name for display */
  functionName: string;
  conditions: Condition[];
  channelIds: string[];
}

// ---------------------------------------------------------------------------
// State poller types (ported from ChainAlert)
// ---------------------------------------------------------------------------

interface BalanceConditionConfig {
  ruleId: string;
  type: 'percent_change' | 'threshold_above' | 'threshold_below';
  value: bigint;
  windowMs?: number;
  bidirectional?: boolean;
}

interface StateConditionConfig {
  type: 'changed' | 'threshold_above' | 'threshold_below' | 'windowed_percent_change';
  value?: bigint;
  percentThreshold?: number;
  windowSize?: number;
}

interface EvalResult {
  triggered: boolean;
  context?: {
    conditionType: string;
    currentValue: string;
    previousValue?: string;
    referenceValue?: string;
    percentChange?: number;
    threshold?: string;
    windowMs?: number;
    direction?: 'drop' | 'rise' | 'change';
  };
}

interface PollRule {
  id: string;
  detectionId: string;
  orgId: string;
  type: 'chain.balance_track' | 'chain.state_poll' | 'chain.view_call';
  networkSlug: string;
  chainId: number;
  rpcUrls: string[];
  address: string;
  tokenAddress?: string;
  slot?: string;
  viewCall?: { functionSignature: string; args: unknown[]; returnType: string };
  intervalMs: number;
  condition: BalanceConditionConfig | StateConditionConfig;
  channelIds: string[];
}

// ============================================================================
// 1. chain.block.poll
//    Polls a network for new blocks, fetches logs, enqueues block-data jobs.
//    Ported from ChainAlert's block-poller loop.
// ============================================================================

export const blockPollHandler: JobHandler = {
  jobName: 'chain.block.poll',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { networkSlug, orgId } = job.data as {
      networkSlug: string;
      orgId?: string;
    };

    // Load network config with optional org-specific RPC override
    const config = await loadNetworkConfig(networkSlug, orgId);
    const client = createRpcClient(config.rpcUrls, config.chainId);

    // Poll once: fetch new blocks, extract logs/txs.
    // Cursor is NOT advanced inside pollOnce -- we advance it only after
    // successful job enqueueing to avoid data loss (Fix #13).
    const pollResult = await pollOnce(client, config);

    if (pollResult.blockDataJobs.length === 0) return;

    // Enqueue each block's data for processing
    const moduleQueue = getQueue(QUEUE_NAMES.MODULE_JOBS);

    for (const blockData of pollResult.blockDataJobs) {
      await moduleQueue.add(
        'chain.block.process',
        blockData,
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2_000 },
        },
      );
    }

    // Advance cursor AFTER all jobs are successfully enqueued
    await updateBlockCursor(config.networkId, pollResult.advanceCursorTo);

    log.info({ networkSlug: config.slug, blockCount: pollResult.blockDataJobs.length }, 'enqueued blocks for processing');
  },
};

// ============================================================================
// 2. chain.block.process
//    Processes block data (logs), matches against active rules, normalizes
//    events, enqueues for rule evaluation and alerting.
//    Ported from ChainAlert's event-matcher.
// ============================================================================

export const blockProcessHandler: JobHandler = {
  jobName: 'chain.block.process',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { networkSlug, chainId, blockNumber, logs, transactions } =
      job.data as BlockDataJob;

    // Resolve networkId from slug
    const networkId = await getNetworkIdBySlug(networkSlug);
    if (networkId == null) {
      log.warn({ networkSlug }, 'unknown network slug');
      return;
    }

    // Load active rules for this network
    const activeRules = await loadActiveEventRules(networkId, networkSlug, chainId);
    const fnCallRules = await loadActiveFnCallRules(networkId, networkSlug, chainId);

    if (activeRules.length === 0 && fnCallRules.length === 0) {
      return;
    }

    if (logs.length > 0) {
      log.debug({ networkSlug, blockNumber, logCount: logs.length, eventRuleCount: activeRules.length, fnCallRuleCount: fnCallRules.length }, 'processing block');
    }

    // Load contract ABIs for decoding (Fix #4 -- ABI decoding)
    const contractAbis = await loadContractAbis(networkId);

    // Build topic0 -> rules index for O(1) lookup
    const topicIndex = new Map<string, DetectionRule[]>();
    for (const rule of activeRules) {
      const key = rule.topic0;
      const existing = topicIndex.get(key);
      if (existing) {
        existing.push(rule);
      } else {
        topicIndex.set(key, [rule]);
      }
    }

    const db = getDb();
    const eventsQueue = getQueue(QUEUE_NAMES.EVENTS);
    const alertsQueue = getQueue(QUEUE_NAMES.ALERTS);
    let matchedEventCount = 0;

    // Pre-load detection cooldown info to avoid N+1 queries (Fix #8, #12)
    const detectionIds = new Set<string>();
    for (const r of activeRules) detectionIds.add(r.detectionId);
    for (const r of fnCallRules) detectionIds.add(r.detectionId);
    const detectionMap = await loadDetectionCooldowns([...detectionIds]);

    // Collect all normalized event values for batch insert (Fix #12)
    const allNormalizedValues: Array<{
      normalized: ReturnType<typeof normalizeMatchedEvent>;
      rule: DetectionRule | FunctionCallRule;
      matchedInput: MatchedEventInput;
    }> = [];

    // -----------------------------------------------------------------------
    // Process logs against event-match / windowed-count / windowed-spike rules
    // -----------------------------------------------------------------------
    for (const log of logs) {
      const topic0 = log.topics[0]?.toLowerCase();
      if (!topic0) continue;

      const matchingRules = topicIndex.get(topic0);
      if (!matchingRules) continue;

      for (const rule of matchingRules) {
        // Optional address filter
        if (
          rule.contractAddress &&
          log.address.toLowerCase() !== rule.contractAddress
        ) {
          continue;
        }

        // Decode event log using ABI (Fix #4)
        const contractAbi = contractAbis.get(log.address.toLowerCase());
        const decoded = decodeLog(log.topics, log.data, contractAbi);
        const eventName = decoded?.eventName ?? `topic0:${topic0.slice(0, 10)}`;
        const eventArgs = decoded?.args ?? { topics: log.topics, data: log.data };

        // Build the normalized matched event
        const matchedInput: MatchedEventInput = {
          ruleId: rule.id,
          detectionId: rule.detectionId,
          orgId: rule.orgId,
          networkSlug,
          chainId,
          blockNumber,
          blockTimestamp: null,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
          contractAddress: log.address,
          eventName,
          eventArgs,
          matchType: rule.matchType,
          channelIds: rule.channelIds,
        };

        const normalized = normalizeMatchedEvent(matchedInput);
        allNormalizedValues.push({ normalized, rule, matchedInput });
      }
    }

    // -----------------------------------------------------------------------
    // Process transactions for function-call-match rules
    // -----------------------------------------------------------------------
    if (fnCallRules.length > 0 && transactions && transactions.length > 0) {
      // Build selector -> rules index
      const selectorIndex = new Map<string, FunctionCallRule[]>();
      for (const rule of fnCallRules) {
        const key = rule.selector;
        const existing = selectorIndex.get(key);
        if (existing) {
          existing.push(rule);
        } else {
          selectorIndex.set(key, [rule]);
        }
      }

      for (const tx of transactions) {
        if (!tx.to || !tx.input || tx.input.length < 10) continue;

        const selector = tx.input.slice(0, 10).toLowerCase();
        const matchingFnRules = selectorIndex.get(selector);
        if (!matchingFnRules) continue;

        for (const rule of matchingFnRules) {
          // Address filter: tx.to must be the monitored contract
          if (tx.to.toLowerCase() !== rule.contractAddress) continue;

          // Decode function calldata using ABI (Fix #4)
          const contractAbi = contractAbis.get(tx.to.toLowerCase());
          const decoded = decodeFunctionCallData(tx.input, contractAbi);
          const fnName = decoded?.functionName ?? rule.functionName;
          const decodedArgs = decoded?.args ?? { input: tx.input, from: tx.from, value: tx.value };

          const matchedInput: MatchedEventInput = {
            ruleId: rule.id,
            detectionId: rule.detectionId,
            orgId: rule.orgId,
            networkSlug,
            chainId,
            blockNumber,
            blockTimestamp: null,
            transactionHash: tx.hash,
            logIndex: null,
            contractAddress: tx.to,
            eventName: fnName,
            eventArgs: decodedArgs,
            matchType: RULE_TYPE.FUNCTION_CALL_MATCH,
            channelIds: rule.channelIds,
          };

          const normalized = normalizeMatchedEvent(matchedInput);
          allNormalizedValues.push({ normalized, rule, matchedInput });
        }
      }
    }

    // -----------------------------------------------------------------------
    // Batch insert all normalized events (Fix #12: avoid N+1 DB queries)
    // -----------------------------------------------------------------------
    if (allNormalizedValues.length > 0) {
      const insertedEvents = await db
        .insert(events)
        .values(allNormalizedValues.map((v) => v.normalized))
        .returning();

      matchedEventCount = insertedEvents.length;

      // Process each inserted event: enqueue evaluation, check cooldown, publish alerts
      for (let i = 0; i < insertedEvents.length; i++) {
        const event = insertedEvents[i]!;
        const { rule, matchedInput } = allNormalizedValues[i]!;

        // Enqueue rule evaluation
        await eventsQueue.add('event.evaluate', { eventId: event.id });

        // Cooldown check before publishing alert (Fix #8)
        const det = detectionMap.get(rule.detectionId);

        if (det && det.cooldownMinutes > 0) {
          const cooldownMs = det.cooldownMinutes * 60 * 1000;
          const cooldownThreshold = new Date(Date.now() - cooldownMs);
          const [acquired] = await db
            .update(detections)
            .set({ lastTriggeredAt: new Date() })
            .where(and(
              eq(detections.id, rule.detectionId),
              or(
                isNull(detections.lastTriggeredAt),
                lt(detections.lastTriggeredAt, cooldownThreshold),
              ),
            ))
            .returning({ id: detections.id });
          if (!acquired) {
            log.debug({ networkSlug, ruleId: rule.id }, 'rule suppressed by cooldown');
            continue;
          }
          // Update in-memory map to avoid re-triggering within same block
          if (det) det.lastTriggeredAt = new Date();
        }

        // Publish alert
        await alertsQueue.add(
          `alert-${rule.detectionId}-${blockNumber}-${i}`,
          {
            type: matchedInput.matchType,
            detectionId: rule.detectionId,
            ruleId: rule.id,
            orgId: rule.orgId,
            networkSlug,
            blockNumber,
            transactionHash: matchedInput.transactionHash,
            eventName: matchedInput.eventName,
            eventArgs: matchedInput.eventArgs,
            matchedEventId: event.id,
            channelIds: det?.channelIds ?? rule.channelIds,
            timestamp: Date.now(),
          },
          {
            attempts: 5,
            backoff: { type: 'exponential', delay: 3_000 },
          },
        );

        log.info({ networkSlug, ruleId: rule.id, transactionHash: matchedInput.transactionHash }, 'rule matched');
      }
    }

    // Log block processing summary (not inserted to DB -- Fix #5)
    const summary = summarizeBlockProcessed({
      networkSlug,
      chainId,
      blockNumber,
      logCount: logs.length,
      transactionCount: transactions?.length ?? 0,
      matchedEventCount,
      processedAt: Date.now(),
    });
    log.info({ networkSlug, blockNumber, matchedEventCount, logCount: logs.length, summary }, 'block processing complete');
  },
};

// ============================================================================
// 3. chain.state.poll
//    Polls contract state (balance, storage, view-call) for state-poll rules.
//    Ported from ChainAlert's state-poller processPollJob.
// ============================================================================

export const statePollHandler: JobHandler = {
  jobName: 'chain.state.poll',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { ruleId } = job.data as { ruleId: string };

    // Load the rule
    const rule = await loadPollRuleById(ruleId);
    if (!rule) {
      log.warn({ ruleId }, 'state poll rule not found or disabled');
      return;
    }

    if (!rule.address) {
      log.warn({ ruleId }, 'state poll rule has no address configured');
      return;
    }

    const client = createRpcClient(rule.rpcUrls, rule.chainId);
    const now = Date.now();

    // Execute the RPC call based on rule type
    let currentValue: bigint;

    if (rule.type === RULE_TYPE.STATE_POLL) {
      if (!rule.slot) {
        throw new Error(`state-poll rule ${ruleId} is missing required slot configuration`);
      }
      const result = await client.getStorageAt(rule.address, rule.slot);
      currentValue = BigInt(result);
    } else if (rule.type === RULE_TYPE.VIEW_CALL) {
      if (!rule.viewCall) {
        throw new Error(`view-call rule ${ruleId} is missing required viewCall configuration`);
      }
      const result = await callViewFunction(
        client,
        rule.address,
        rule.viewCall.functionSignature,
      );
      currentValue = result && result !== '0x' ? BigInt(result) : 0n;
    } else {
      // balance-track
      currentValue = await getTokenBalance(client, rule.address, rule.tokenAddress);
    }

    // Store snapshot in DB
    const db = getDb();
    const snapshotType =
      rule.type === RULE_TYPE.STATE_POLL
        ? 'storage'
        : rule.type === RULE_TYPE.VIEW_CALL
          ? 'view-call'
          : 'balance';

    const [snapshot] = await db
      .insert(chainStateSnapshots)
      .values({
        ruleId: rule.id,
        detectionId: rule.detectionId,
        networkId: await getNetworkIdForSlug(rule.networkSlug),
        address: rule.address,
        snapshotType,
        slot: rule.slot ?? null,
        value: currentValue.toString(),
        polledAt: new Date(now),
      })
      .returning({ id: chainStateSnapshots.id });

    log.debug({ ruleId, ruleType: rule.type, value: currentValue.toString(), snapshotId: snapshot?.id }, 'state poll snapshot stored');

    // Evaluate condition
    const evalResult = await evaluateCondition(rule, currentValue, db);

    if (!evalResult.triggered) return;

    // Cooldown check
    const [det] = await db
      .select({
        cooldownMinutes: detections.cooldownMinutes,
        lastTriggeredAt: detections.lastTriggeredAt,
        channelIds: detections.channelIds,
      })
      .from(detections)
      .where(eq(detections.id, rule.detectionId))
      .limit(1);

    if (det && det.cooldownMinutes > 0) {
      const cooldownMs = det.cooldownMinutes * 60 * 1000;
      const cooldownThreshold = new Date(Date.now() - cooldownMs);
      const [acquired] = await db
        .update(detections)
        .set({ lastTriggeredAt: new Date() })
        .where(and(
          eq(detections.id, rule.detectionId),
          or(
            isNull(detections.lastTriggeredAt),
            lt(detections.lastTriggeredAt, cooldownThreshold),
          ),
        ))
        .returning({ id: detections.id });
      if (!acquired) {
        log.debug({ ruleId }, 'state poll rule triggered but on cooldown');
        return;
      }
    }

    // Mark snapshot as triggered
    if (snapshot?.id != null) {
      await db
        .update(chainStateSnapshots)
        .set({
          triggered: true,
          triggerContext: evalResult.context ?? null,
        })
        .where(eq(chainStateSnapshots.id, snapshot.id));
    }

    // Normalize and store the state change event
    const stateInput: StateChangedInput = {
      snapshotId: String(snapshot?.id ?? Date.now()),
      ruleId: rule.id,
      detectionId: rule.detectionId,
      orgId: rule.orgId,
      networkSlug: rule.networkSlug,
      chainId: rule.chainId,
      address: rule.address,
      tokenAddress: rule.tokenAddress,
      stateType: snapshotType as 'balance' | 'storage' | 'view-call',
      currentValue: currentValue.toString(),
      previousValue: evalResult.context?.previousValue,
      referenceValue: evalResult.context?.referenceValue,
      percentChange: evalResult.context?.percentChange,
      direction: evalResult.context?.direction,
      conditionType: evalResult.context?.conditionType ?? rule.type,
      threshold: evalResult.context?.threshold,
      windowMs: evalResult.context?.windowMs,
      channelIds: det?.channelIds ?? rule.channelIds,
    };

    const normalized = normalizeStateChanged(stateInput);
    const [event] = await db.insert(events).values(normalized).returning();

    // Enqueue rule evaluation
    const eventsQueue = getQueue(QUEUE_NAMES.EVENTS);
    await eventsQueue.add('event.evaluate', { eventId: event.id });

    // Publish alert
    const alertsQueue = getQueue(QUEUE_NAMES.ALERTS);
    await alertsQueue.add(
      `alert-${rule.detectionId}-${ruleId}-${now}`,
      {
        type: rule.type,
        detectionId: rule.detectionId,
        ruleId: rule.id,
        orgId: rule.orgId,
        networkSlug: rule.networkSlug,
        address: rule.address,
        tokenAddress: rule.tokenAddress,
        currentValue: currentValue.toString(),
        channelIds: det?.channelIds ?? rule.channelIds,
        matchedEventId: event.id,
        timestamp: now,
      },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 3_000 },
      },
    );

    log.info({ ruleId, detectionId: rule.detectionId }, 'state poll alert published');
  },
};

// ============================================================================
// 4. chain.rule.sync
//    Syncs rule configurations to/from the polling system.
//    Ported from ChainAlert's rule-sync worker.
// ============================================================================

export const ruleSyncHandler: JobHandler = {
  jobName: 'chain.rule.sync',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { action, ruleId, config } = job.data as {
      action: 'add' | 'update' | 'remove' | 'reconcile';
      ruleId?: string;
      config?: Record<string, unknown>;
    };

    const moduleQueue = getQueue(QUEUE_NAMES.MODULE_JOBS);

    if (action === 'reconcile') {
      // Reconcile all active chain rules: ensure repeatable poll jobs exist
      await reconcileAllPollRules();
      // Reconcile block pollers for active networks
      await reconcileBlockPollers();
      log.info('rule sync reconciliation complete');
      return;
    }

    if (!ruleId) {
      log.warn({ action }, 'rule sync missing ruleId');
      return;
    }

    if (action === 'add' || action === 'update') {
      const ruleType = canonicalType((config?.ruleType as string) ?? '');

      // For state-poll / balance-track / view-call rules, set up repeatable poll jobs
      if (
        ruleType === RULE_TYPE.BALANCE_TRACK ||
        ruleType === RULE_TYPE.STATE_POLL ||
        ruleType === RULE_TYPE.VIEW_CALL
      ) {
        const tokenAddress = (config?.token_address ?? config?.tokenAddress) as
          | string
          | undefined;
        const baseInterval =
          Number(config?.poll_interval_ms) ||
          Number(config?.intervalMs) ||
          60_000;

        // ERC-20 balance-track rules use a 1-hour safety-net poll;
        // real-time detection is driven by Transfer events in block.process
        const intervalMs =
          ruleType === RULE_TYPE.BALANCE_TRACK && tokenAddress
            ? 3_600_000
            : baseInterval;

        // Schedule repeatable poll job
        await moduleQueue.add(
          'chain.state.poll',
          { ruleId },
          {
            repeat: { every: intervalMs },
            jobId: `poll-${ruleId}`,
          },
        );

        log.info({ action, ruleId, intervalMs }, 'poll schedule configured');
      }

      // For block-dependent rules, ensure the network's block poller is active
      if (
        ruleType === RULE_TYPE.EVENT_MATCH ||
        ruleType === RULE_TYPE.WINDOWED_COUNT ||
        ruleType === RULE_TYPE.WINDOWED_SPIKE ||
        ruleType === RULE_TYPE.FUNCTION_CALL_MATCH ||
        ruleType === RULE_TYPE.BALANCE_TRACK
      ) {
        const networkSlug = config?.networkSlug as string | undefined;
        if (networkSlug) {
          await ensureBlockPollerScheduled(networkSlug);
        }
      }
    } else if (action === 'remove') {
      // Remove the repeatable poll job if it exists
      const existingJobs = await moduleQueue.getRepeatableJobs();
      for (const rj of existingJobs) {
        if (rj.id === `poll-${ruleId}`) {
          await moduleQueue.removeRepeatableByKey(rj.key);
          log.info({ ruleId }, 'removed poll schedule');
        }
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Rule loading helpers (adapted from ChainAlert's event-matcher)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Contract ABI loader (for event/function decoding)
// ---------------------------------------------------------------------------

async function loadContractAbis(
  networkId: number,
): Promise<Map<string, unknown>> {
  const db = getDb();
  const rows = await db
    .select({
      address: chainContracts.address,
      abi: chainContracts.abi,
    })
    .from(chainContracts)
    .where(eq(chainContracts.networkId, networkId));

  const map = new Map<string, unknown>();
  for (const row of rows) {
    if (row.abi && typeof row.abi === 'object') {
      const abiArr = Array.isArray(row.abi) ? row.abi : null;
      if (abiArr && abiArr.length > 0) {
        map.set(row.address.toLowerCase(), abiArr);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Detection cooldown loader (batch -- avoids N+1 queries)
// ---------------------------------------------------------------------------

interface DetectionCooldownInfo {
  cooldownMinutes: number;
  lastTriggeredAt: Date | null;
  channelIds: string[];
}

async function loadDetectionCooldowns(
  detectionIds: string[],
): Promise<Map<string, DetectionCooldownInfo>> {
  if (detectionIds.length === 0) return new Map();

  const db = getDb();
  const rows = await db
    .select({
      id: detections.id,
      cooldownMinutes: detections.cooldownMinutes,
      lastTriggeredAt: detections.lastTriggeredAt,
      channelIds: detections.channelIds,
    })
    .from(detections)
    .where(inArray(detections.id, detectionIds));

  const map = new Map<string, DetectionCooldownInfo>();
  for (const row of rows) {
    map.set(row.id, {
      cooldownMinutes: row.cooldownMinutes,
      lastTriggeredAt: row.lastTriggeredAt,
      channelIds: (row.channelIds as string[]) ?? [],
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Rule loading helpers (adapted from ChainAlert's event-matcher)
// ---------------------------------------------------------------------------

async function loadActiveEventRules(
  networkId: number,
  networkSlug: string,
  chainId: number,
): Promise<DetectionRule[]> {
  const db = getDb();

  const rows = await db
    .select({
      id: rules.id,
      detectionId: rules.detectionId,
      orgId: rules.orgId,
      ruleType: rules.ruleType,
      config: rules.config,
      channelIds: detections.channelIds,
    })
    .from(rules)
    .innerJoin(detections, eq(detections.id, rules.detectionId))
    .where(
      and(
        eq(rules.moduleId, 'chain'),
        eq(rules.status, 'active'),
        inArray(rules.ruleType, [
          RULE_TYPE.EVENT_MATCH, RULE_TYPE.WINDOWED_COUNT, RULE_TYPE.WINDOWED_SPIKE,
          'event-match', 'windowed-count', 'windowed-spike',
        ]),
      ),
    );

  return rows.flatMap((r) => {
    const config = r.config as Record<string, unknown>;
    const cfgNetworkId = config.networkId as number | undefined;

    // Filter to the requested network
    if (cfgNetworkId !== undefined && cfgNetworkId !== networkId) return [];

    const topic0 = (config.topic0 as string)?.toLowerCase();
    if (!topic0) {
      log.warn({ ruleId: r.id }, 'event rule has no topic0, skipping');
      return [];
    }

    const rt = canonicalType(r.ruleType);
    const matchType =
      rt === RULE_TYPE.WINDOWED_SPIKE
        ? (RULE_TYPE.WINDOWED_SPIKE as const)
        : rt === RULE_TYPE.WINDOWED_COUNT
          ? (RULE_TYPE.WINDOWED_COUNT as const)
          : (RULE_TYPE.EVENT_MATCH as const);

    // Parse conditions
    let conditions: Condition[] = [];
    if (Array.isArray(config.conditions)) {
      conditions = config.conditions as Condition[];
    } else if (config.filter && typeof config.filter === 'object') {
      const f = config.filter as Record<string, unknown>;
      const field = f.field as string;
      if (field && field.trim()) {
        conditions = [
          {
            field,
            operator: (f.operator ?? f.op) as Condition['operator'],
            value: f.value,
          },
        ];
      }
    }

    return [
      {
        id: r.id,
        detectionId: r.detectionId,
        orgId: r.orgId,
        networkSlug,
        chainId,
        topic0,
        contractAddress: (config.contract_address as string)?.toLowerCase(),
        conditions,
        window: config.window_config
          ? {
              durationMs: (config.window_config as Record<string, unknown>).durationMs as number,
              threshold: (config.window_config as Record<string, unknown>).threshold as number,
            }
          : undefined,
        groupByField: config.groupByField as string | undefined,
        channelIds: (r.channelIds as string[]) ?? [],
        matchType,
      },
    ];
  });
}

async function loadActiveFnCallRules(
  networkId: number,
  networkSlug: string,
  chainId: number,
): Promise<FunctionCallRule[]> {
  const db = getDb();

  const rows = await db
    .select({
      id: rules.id,
      detectionId: rules.detectionId,
      orgId: rules.orgId,
      config: rules.config,
      channelIds: detections.channelIds,
    })
    .from(rules)
    .innerJoin(detections, eq(detections.id, rules.detectionId))
    .where(
      and(
        eq(rules.moduleId, 'chain'),
        inArray(rules.ruleType, [RULE_TYPE.FUNCTION_CALL_MATCH, 'function-call-match']),
        eq(rules.status, 'active'),
      ),
    );

  return rows.flatMap((r) => {
    const config = r.config as Record<string, unknown>;
    const cfgNetworkId = config.networkId as number | undefined;
    if (cfgNetworkId !== undefined && cfgNetworkId !== networkId) return [];

    const functionSignature = config.functionSignature as string | undefined;
    if (!functionSignature) {
      log.warn({ ruleId: r.id }, 'fn-call rule has no functionSignature, skipping');
      return [];
    }

    // The selector should be pre-computed and stored in the rule config
    const selector = (config.selector as string)?.toLowerCase() ?? computeSelector(functionSignature);
    const contractAddr = (config.contract_address as string)?.toLowerCase();

    if (!contractAddr) {
      log.warn({ ruleId: r.id }, 'fn-call rule has no contract address, skipping');
      return [];
    }

    let conditions: Condition[] = [];
    if (Array.isArray(config.conditions)) {
      conditions = config.conditions as Condition[];
    }

    return [
      {
        id: r.id,
        detectionId: r.detectionId,
        orgId: r.orgId,
        networkSlug,
        chainId,
        selector,
        contractAddress: contractAddr,
        functionName: (config.functionName as string) ?? functionSignature,
        conditions,
        channelIds: (r.channelIds as string[]) ?? [],
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// State poll rule loading (adapted from ChainAlert's state-poller)
// ---------------------------------------------------------------------------

async function loadPollRuleById(ruleId: string): Promise<PollRule | null> {
  const db = getDb();

  const rows = await db
    .select({
      id: rules.id,
      detectionId: rules.detectionId,
      orgId: rules.orgId,
      ruleType: rules.ruleType,
      config: rules.config,
      channelIds: detections.channelIds,
    })
    .from(rules)
    .innerJoin(detections, eq(detections.id, rules.detectionId))
    .where(
      and(
        eq(rules.id, ruleId),
        eq(rules.moduleId, 'chain'),
        eq(rules.status, 'active'),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;

  const r = rows[0]!;
  const config = r.config as Record<string, unknown>;
  const networkSlug = config.networkSlug as string;

  // Load network info for RPC URLs and chainId
  let rpcUrls: string[] = [];
  let chainId = 0;

  if (networkSlug) {
    try {
      const netConfig = await loadNetworkConfig(networkSlug, r.orgId);
      rpcUrls = netConfig.rpcUrls;
      chainId = netConfig.chainId;
    } catch {
      log.warn({ networkSlug }, 'could not load network config for state poll rule');
      return null;
    }
  }

  // Normalize condition config (ported from ChainAlert's rowToPollRule)
  let condition = config.condition as BalanceConditionConfig | StateConditionConfig;
  if (!condition) {
    condition = { type: 'changed' } as StateConditionConfig;
  }

  return {
    id: r.id,
    detectionId: r.detectionId,
    orgId: r.orgId,
    type: canonicalType(r.ruleType) as PollRule['type'],
    networkSlug,
    chainId,
    rpcUrls,
    address: config.address as string,
    tokenAddress: (config.token_address ?? config.tokenAddress) as string | undefined,
    slot: config.slot as string | undefined,
    viewCall:
      canonicalType(r.ruleType) === RULE_TYPE.VIEW_CALL
        ? {
            functionSignature: config.functionSignature as string,
            args: (config.args as unknown[]) ?? [],
            returnType: (config.returnType ?? config.return_type ?? 'uint256') as string,
          }
        : undefined,
    intervalMs:
      Number(config.poll_interval_ms) ||
      Number(config.interval_ms) ||
      Number(config.intervalMs) ||
      60_000,
    condition,
    channelIds: (r.channelIds as string[]) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Condition evaluator (ported from ChainAlert's evaluator.ts)
// ---------------------------------------------------------------------------

async function evaluateCondition(
  rule: PollRule,
  currentValue: bigint,
  db: ReturnType<typeof getDb>,
): Promise<EvalResult> {
  if (rule.type === RULE_TYPE.BALANCE_TRACK) {
    return evaluateBalanceCondition(
      rule.condition as BalanceConditionConfig,
      currentValue,
      rule.id,
      db,
    );
  }

  return evaluateStateCondition(
    rule.condition as StateConditionConfig,
    currentValue,
    rule.id,
    db,
  );
}

async function evaluateBalanceCondition(
  config: BalanceConditionConfig,
  currentValue: bigint,
  ruleId: string,
  db: ReturnType<typeof getDb>,
): Promise<EvalResult> {
  // Get previous snapshot for comparison
  const prevSnapshots = await db
    .select({ value: chainStateSnapshots.value })
    .from(chainStateSnapshots)
    .where(eq(chainStateSnapshots.ruleId, ruleId))
    .orderBy(chainStateSnapshots.polledAt)
    .limit(2);

  // The most recent is the one we just inserted; the one before is "previous"
  const previousValue =
    prevSnapshots.length >= 2 ? BigInt(prevSnapshots[0]!.value) : null;

  switch (config.type) {
    case 'percent_change': {
      if (previousValue === null || previousValue === 0n) return { triggered: false };
      const diff =
        currentValue > previousValue
          ? currentValue - previousValue
          : previousValue - currentValue;
      const bps = (diff * 10000n) / previousValue;
      const thresholdBps = (config.value ?? 50n) * 100n;
      if (bps >= thresholdBps) {
        const direction = currentValue < previousValue ? 'drop' : 'rise';
        return {
          triggered: true,
          context: {
            conditionType: 'percent_change',
            currentValue: currentValue.toString(),
            previousValue: previousValue.toString(),
            percentChange:
              direction === 'drop' ? -Number(bps) / 100 : Number(bps) / 100,
            threshold: config.value?.toString(),
            direction,
          },
        };
      }
      return { triggered: false };
    }

    case 'threshold_above':
      if (currentValue > (config.value ?? 0n)) {
        return {
          triggered: true,
          context: {
            conditionType: 'threshold_above',
            currentValue: currentValue.toString(),
            previousValue: previousValue?.toString(),
            threshold: config.value?.toString(),
          },
        };
      }
      return { triggered: false };

    case 'threshold_below':
      if (currentValue < (config.value ?? 0n)) {
        return {
          triggered: true,
          context: {
            conditionType: 'threshold_below',
            currentValue: currentValue.toString(),
            previousValue: previousValue?.toString(),
            threshold: config.value?.toString(),
          },
        };
      }
      return { triggered: false };

    default:
      return { triggered: false };
  }
}

async function evaluateStateCondition(
  config: StateConditionConfig,
  currentValue: bigint,
  ruleId: string,
  db: ReturnType<typeof getDb>,
): Promise<EvalResult> {
  // Get previous snapshot
  const prevSnapshots = await db
    .select({ value: chainStateSnapshots.value })
    .from(chainStateSnapshots)
    .where(eq(chainStateSnapshots.ruleId, ruleId))
    .orderBy(chainStateSnapshots.polledAt)
    .limit(2);

  const previousValue =
    prevSnapshots.length >= 2 ? BigInt(prevSnapshots[0]!.value) : null;

  switch (config.type) {
    case 'changed':
      if (previousValue === null) return { triggered: false };
      if (currentValue !== previousValue) {
        return {
          triggered: true,
          context: {
            conditionType: 'changed',
            currentValue: currentValue.toString(),
            previousValue: previousValue.toString(),
            direction: 'change',
          },
        };
      }
      return { triggered: false };

    case 'threshold_above':
      if (config.value === undefined) return { triggered: false };
      if (currentValue > config.value) {
        return {
          triggered: true,
          context: {
            conditionType: 'threshold_above',
            currentValue: currentValue.toString(),
            previousValue: previousValue?.toString(),
            threshold: config.value.toString(),
          },
        };
      }
      return { triggered: false };

    case 'threshold_below':
      if (config.value === undefined) return { triggered: false };
      if (currentValue < config.value) {
        return {
          triggered: true,
          context: {
            conditionType: 'threshold_below',
            currentValue: currentValue.toString(),
            previousValue: previousValue?.toString(),
            threshold: config.value.toString(),
          },
        };
      }
      return { triggered: false };

    case 'windowed_percent_change': {
      if (config.percentThreshold === undefined) return { triggered: false };
      const windowSize = Math.min(Math.max(config.windowSize ?? 100, 1), 500);

      // Load recent snapshots for rolling mean
      const recentRows = await db
        .select({ value: chainStateSnapshots.value })
        .from(chainStateSnapshots)
        .where(eq(chainStateSnapshots.ruleId, ruleId))
        .orderBy(chainStateSnapshots.polledAt)
        .limit(windowSize + 1);

      // Drop the most recent (current value just stored)
      const recentValues = recentRows.slice(0, -1).map((r) => BigInt(r.value));
      if (recentValues.length < 2) return { triggered: false };

      const sum = recentValues.reduce((a, b) => a + b, 0n);
      const mean = sum / BigInt(recentValues.length);
      if (mean === 0n) return { triggered: false };

      const diff =
        currentValue > mean ? currentValue - mean : mean - currentValue;
      const percentDeviation = Number((diff * 100n) / mean);

      if (percentDeviation >= config.percentThreshold) {
        return {
          triggered: true,
          context: {
            conditionType: 'windowed_percent_change',
            currentValue: currentValue.toString(),
            referenceValue: mean.toString(),
            percentChange:
              currentValue > mean ? percentDeviation : -percentDeviation,
            threshold: config.percentThreshold.toString(),
            direction: currentValue > mean ? 'rise' : 'drop',
          },
        };
      }
      return { triggered: false };
    }

    default:
      return { triggered: false };
  }
}

// ---------------------------------------------------------------------------
// Reconciliation helpers
// ---------------------------------------------------------------------------

async function reconcileAllPollRules(): Promise<void> {
  const db = getDb();
  const moduleQueue = getQueue(QUEUE_NAMES.MODULE_JOBS);

  // Load all active state-poll / balance-track / view-call rules
  const activeRules = await db
    .select({
      id: rules.id,
      ruleType: rules.ruleType,
      config: rules.config,
    })
    .from(rules)
    .where(
      and(
        eq(rules.moduleId, 'chain'),
        eq(rules.status, 'active'),
        inArray(rules.ruleType, [
          RULE_TYPE.BALANCE_TRACK, RULE_TYPE.STATE_POLL, RULE_TYPE.VIEW_CALL,
          'balance-track', 'state-poll', 'view-call',
        ]),
      ),
    );

  for (const rule of activeRules) {
    const config = rule.config as Record<string, unknown>;
    const tokenAddress = (config.token_address ?? config.tokenAddress) as
      | string
      | undefined;
    const baseInterval =
      Number(config.poll_interval_ms) ||
      Number(config.intervalMs) ||
      60_000;

    const intervalMs =
      canonicalType(rule.ruleType) === RULE_TYPE.BALANCE_TRACK && tokenAddress
        ? 3_600_000
        : baseInterval;

    await moduleQueue.add(
      'chain.state.poll',
      { ruleId: rule.id },
      {
        repeat: { every: intervalMs },
        jobId: `poll-${rule.id}`,
      },
    );

    log.debug({ ruleId: rule.id, intervalMs }, 'ensured poll schedule');
  }
}

async function reconcileBlockPollers(): Promise<void> {
  const db = getDb();

  // Find all active networks via chain rules
  const activeRuleRows = await db
    .select({ config: rules.config })
    .from(rules)
    .where(
      and(
        eq(rules.moduleId, 'chain'),
        eq(rules.status, 'active'),
        inArray(rules.ruleType, [
          RULE_TYPE.EVENT_MATCH, RULE_TYPE.WINDOWED_COUNT, RULE_TYPE.WINDOWED_SPIKE,
          RULE_TYPE.BALANCE_TRACK, RULE_TYPE.FUNCTION_CALL_MATCH,
          'event-match', 'windowed-count', 'windowed-spike',
          'balance-track', 'function-call-match',
        ]),
      ),
    );

  // Extract unique networkSlugs from rule configs
  const slugs = new Set<string>();
  for (const row of activeRuleRows) {
    const config = row.config as Record<string, unknown>;
    const slug = config.networkSlug as string | undefined;
    if (slug) slugs.add(slug);
  }

  for (const slug of slugs) {
    await ensureBlockPollerScheduled(slug);
  }
}

async function ensureBlockPollerScheduled(networkSlug: string): Promise<void> {
  const moduleQueue = getQueue(QUEUE_NAMES.MODULE_JOBS);

  // Load network config to determine poll interval
  try {
    const config = await loadNetworkConfig(networkSlug);
    const pollInterval = Math.max(Math.floor(config.blockTimeMs * 0.7), 500);

    await moduleQueue.add(
      'chain.block.poll',
      { networkSlug },
      {
        repeat: { every: pollInterval },
        jobId: `block-poll-${networkSlug}`,
      },
    );

    log.debug({ networkSlug, pollInterval }, 'ensured block poller schedule');
  } catch (err) {
    log.error({ err, networkSlug }, 'failed to schedule block poller');
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

async function getNetworkIdForSlug(slug: string): Promise<number> {
  const id = await getNetworkIdBySlug(slug);
  if (id == null) throw new Error(`Unknown network slug: ${slug}`);
  return id;
}

/**
 * Compute a 4-byte function selector from a function signature
 * using keccak256 (Solidity convention).
 */
function computeSelector(functionSignature: string): string {
  return toFunctionSelector(functionSignature).toLowerCase();
}

// ============================================================================
// 5. chain.contract.verify
//    Fetches and verifies contract ABI from an Etherscan-compatible explorer.
// ============================================================================

export const contractVerifyHandler: JobHandler = {
  jobName: 'chain.contract.verify',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { contractId, networkSlug, address } = job.data as {
      contractId: number;
      networkSlug: string;
      address: string;
    };

    const db = getDb();

    // Load network to get explorer API URL and RPC
    const [network] = await db
      .select()
      .from(chainNetworks)
      .where(eq(chainNetworks.slug, networkSlug))
      .limit(1);

    if (!network) {
      log.warn({ networkSlug }, 'contract verify: network not found');
      return;
    }

    if (!network.explorerApi) {
      log.warn({ networkSlug }, 'contract verify: no explorer API configured');
      await db
        .update(chainContracts)
        .set({ layoutStatus: 'no_explorer' })
        .where(eq(chainContracts.id, contractId));
      return;
    }

    try {
      // 1. Fetch ABI from explorer
      const { abi, contractName } = await fetchContractAbi(network.explorerApi, address, { chainId: network.chainId });

      // 2. Check ERC-1967 proxy slot
      let isProxy = false;
      let implementation: string | null = null;
      let implAbi: unknown[] | null = null;

      if (network.rpcUrl) {
        try {
          const client = createRpcClient([network.rpcUrl], network.chainId);
          const implSlot = await client.getStorageAt(
            address,
            WELL_KNOWN_SLOTS.ERC1967_IMPLEMENTATION.slot,
          );

          // Non-zero value means this is a proxy
          const implAddress = '0x' + implSlot.slice(-40);
          if (implAddress !== '0x' + '0'.repeat(40)) {
            isProxy = true;
            implementation = implAddress;

            // Fetch implementation ABI
            try {
              const implResult = await fetchContractAbi(network.explorerApi, implAddress, { chainId: network.chainId });
              implAbi = implResult.abi;
            } catch (err) {
              // Implementation ABI is best-effort
              log.debug({ err, implAddress }, 'could not fetch implementation ABI');
            }
          }
        } catch (err) {
          // RPC check is best-effort
          log.debug({ err, address }, 'RPC proxy check failed');
        }
      }

      // 3. Update contract record
      // Use the implementation ABI if this is a proxy (it has the actual logic),
      // otherwise use the direct ABI
      const finalAbi = implAbi ?? abi;
      const traits = detectTraits(finalAbi as unknown[]);

      await db
        .update(chainContracts)
        .set({
          abi: finalAbi,
          name: contractName !== 'Unknown' ? contractName : undefined,
          isProxy,
          implementation,
          traits,
          fetchedAt: new Date(),
          layoutStatus: 'fetched',
        })
        .where(eq(chainContracts.id, contractId));

      log.info({ address, networkSlug, isProxy }, 'contract verified');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, address, networkSlug }, 'contract verification failed');

      await db
        .update(chainContracts)
        .set({ layoutStatus: `error: ${message.slice(0, 200)}` })
        .where(eq(chainContracts.id, contractId));
    }
  },
};

// ============================================================================
// 6. chain.rpc-usage.flush
//    Flushes in-memory RPC call counters to the database.
// ============================================================================

export const rpcUsageFlushHandler: JobHandler = {
  jobName: 'chain.rpc-usage.flush',
  queueName: QUEUE_NAMES.MODULE_JOBS,
  async process() {
    await flushCounters();
  },
};

// ============================================================================
// 7. chain.block.aggregate
//    Fan-in handler: aggregates results from batch block processing.
//    The parent job auto-activates when all chain.block.process children complete.
// ============================================================================

interface BlockProcessResult {
  networkSlug: string;
  blockNumber: number;
  matchedEvents: number;
  errors: string[];
}

export const blockAggregateHandler: JobHandler = {
  jobName: 'chain.block.aggregate',
  queueName: QUEUE_NAMES.MODULE_JOBS,

  async process(job: Job) {
    const { networkSlug, pollId } = job.data as {
      networkSlug: string;
      pollId: string;
    };

    const fanIn = await getChildResults<BlockProcessResult>(job);
    const results = Object.values(fanIn.childResults);

    let totalMatched = 0;
    const allErrors: string[] = [];
    const blocksProcessed: number[] = [];

    for (const result of results) {
      totalMatched += result.matchedEvents ?? 0;
      blocksProcessed.push(result.blockNumber);
      if (result.errors?.length) {
        allErrors.push(...result.errors);
      }
    }

    log.info({ networkSlug, pollId, blocksProcessed: results.length, totalMatched, errorCount: allErrors.length }, 'block aggregate complete');
  },
};
