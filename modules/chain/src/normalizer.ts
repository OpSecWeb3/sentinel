/**
 * Normalizes on-chain events into Sentinel platform events.
 *
 * Ported from ChainAlert's event-matcher and state-poller. In ChainAlert
 * events were stored directly in a ChainAlert-specific `events` table.
 * In Sentinel, we normalize them into the standard platform event schema
 * (events table: orgId, moduleId, eventType, externalId, payload, occurredAt).
 *
 * Event types produced by this module:
 *   - chain.event.matched   -- decoded on-chain event that matched a rule
 *   - chain.state.changed   -- state change detected (balance, storage, view-call)
 *   - chain.block.processed -- block processing summary
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DecodedEventArgs {
  [key: string]: unknown;
}

export interface MatchedEventInput {
  ruleId: string;
  detectionId: string;
  orgId: string;
  networkSlug: string;
  chainId: number;
  blockNumber: string;
  blockTimestamp: number | null;
  transactionHash: string;
  logIndex: number | null;
  contractAddress: string;
  eventName: string;
  eventArgs: DecodedEventArgs;
  matchType: 'chain.event_match' | 'chain.windowed_count' | 'chain.windowed_spike' | 'chain.function_call_match';
  channelIds: string[];
}

export interface StateChangedInput {
  snapshotId: string;
  ruleId: string;
  detectionId: string;
  orgId: string;
  networkSlug: string;
  chainId: number;
  address: string;
  tokenAddress?: string;
  stateType: 'balance' | 'storage' | 'view-call';
  currentValue: string;
  previousValue?: string;
  referenceValue?: string;
  percentChange?: number;
  direction?: 'drop' | 'rise' | 'change';
  conditionType: string;
  threshold?: string;
  windowMs?: number;
  channelIds: string[];
}

export interface BlockProcessedInput {
  networkSlug: string;
  chainId: number;
  blockNumber: string;
  logCount: number;
  transactionCount: number;
  matchedEventCount: number;
  processedAt: number;
}

/** Shape compatible with Sentinel's events table insert */
export interface NormalizedEvent {
  orgId: string;
  moduleId: 'chain';
  eventType: string;
  externalId: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

// ---------------------------------------------------------------------------
// Normalize: chain.event.matched
// ---------------------------------------------------------------------------

export function normalizeMatchedEvent(input: MatchedEventInput): NormalizedEvent {
  const externalId = [
    input.transactionHash,
    input.logIndex != null ? String(input.logIndex) : 'fn',
    input.ruleId,
  ].join(':');

  return {
    orgId: input.orgId,
    moduleId: 'chain',
    eventType: 'chain.event.matched',
    externalId,
    payload: {
      resourceId: input.contractAddress,
      ruleId: input.ruleId,
      detectionId: input.detectionId,
      matchType: input.matchType,
      networkSlug: input.networkSlug,
      chainId: input.chainId,
      blockNumber: input.blockNumber,
      blockTimestamp: input.blockTimestamp,
      transactionHash: input.transactionHash,
      logIndex: input.logIndex,
      contractAddress: input.contractAddress,
      eventName: input.eventName,
      eventArgs: sanitizeForJson(input.eventArgs),
      channelIds: input.channelIds,
    },
    occurredAt: input.blockTimestamp
      ? new Date(input.blockTimestamp * 1000)
      : new Date(),
  };
}

// ---------------------------------------------------------------------------
// Normalize: chain.state.changed
// ---------------------------------------------------------------------------

export function normalizeStateChanged(input: StateChangedInput): NormalizedEvent {
  const externalId = [
    'state',
    input.stateType,
    input.address,
    input.ruleId,
    input.snapshotId,
  ].join(':');

  return {
    orgId: input.orgId,
    moduleId: 'chain',
    eventType: 'chain.state.changed',
    externalId,
    payload: {
      resourceId: input.address,
      ruleId: input.ruleId,
      detectionId: input.detectionId,
      networkSlug: input.networkSlug,
      chainId: input.chainId,
      address: input.address,
      tokenAddress: input.tokenAddress,
      stateType: input.stateType,
      currentValue: input.currentValue,
      previousValue: input.previousValue,
      referenceValue: input.referenceValue,
      percentChange: input.percentChange,
      direction: input.direction,
      conditionType: input.conditionType,
      threshold: input.threshold,
      windowMs: input.windowMs,
      channelIds: input.channelIds,
    },
    occurredAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Normalize: chain.block.processed
// ---------------------------------------------------------------------------

/**
 * Block-processed summaries are NOT inserted into the events table
 * (there is no '_system' org in the DB, which would violate the FK).
 * Instead, this returns a plain summary object for logging/metrics.
 */
export function summarizeBlockProcessed(input: BlockProcessedInput): Record<string, unknown> {
  return {
    networkSlug: input.networkSlug,
    chainId: input.chainId,
    blockNumber: input.blockNumber,
    logCount: input.logCount,
    transactionCount: input.transactionCount,
    matchedEventCount: input.matchedEventCount,
    processedAt: input.processedAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert BigInt values to strings so the object is JSON-serializable.
 * Ported from ChainAlert's sanitizeForJson.
 */
export function sanitizeForJson(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'bigint') {
      result[k] = v.toString();
    } else if (Array.isArray(v)) {
      result[k] = v.map((item) =>
        typeof item === 'bigint'
          ? item.toString()
          : item !== null && typeof item === 'object'
            ? sanitizeForJson(item as Record<string, unknown>)
            : item,
      );
    } else if (v !== null && typeof v === 'object') {
      result[k] = sanitizeForJson(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Block-level normalization: decode logs + transactions against rules
// ---------------------------------------------------------------------------

import { decodeLog, decodeFunctionCallData } from './decoder.js';

export interface RawLogEntry {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string | null;
  transactionHash: string;
  logIndex: number | null;
  transactionIndex: number | null;
}

export interface RawTransactionEntry {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  blockNumber: string | null;
}

export interface BlockRule {
  id: string;
  detectionId: string;
  orgId: string;
  topic0: string;
  contractAddress?: string;
  contractAbi?: unknown;
  matchType: 'chain.event_match' | 'chain.windowed_count' | 'chain.windowed_spike' | 'chain.function_call_match';
  channelIds: string[];
}

export interface NormalizedBlockEvent {
  ruleId: string;
  detectionId: string;
  orgId: string;
  log: RawLogEntry;
  decodedEventName: string;
  decodedArgs: Record<string, unknown>;
  matchType: BlockRule['matchType'];
  channelIds: string[];
}

/**
 * Takes block data (logs + optionally transactions), matches against the
 * provided rules, and decodes using ABIs. Returns normalized events that
 * are ready to be inserted into the events table.
 *
 * This is the critical piece that connects raw on-chain data to the
 * rule evaluation pipeline with decoded event arguments.
 */
export function normalizeBlockEvents(
  logs: RawLogEntry[],
  eventRules: BlockRule[],
  _transactions?: RawTransactionEntry[],
  contractAbis?: Map<string, unknown>,
): NormalizedBlockEvent[] {
  // Build topic0 -> rules index for O(1) lookup
  const topicIndex = new Map<string, BlockRule[]>();
  for (const rule of eventRules) {
    const key = rule.topic0;
    const existing = topicIndex.get(key);
    if (existing) {
      existing.push(rule);
    } else {
      topicIndex.set(key, [rule]);
    }
  }

  const results: NormalizedBlockEvent[] = [];

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

      // Attempt to decode the log using the contract ABI or well-known ABIs
      const contractAbi =
        rule.contractAbi ??
        contractAbis?.get(log.address.toLowerCase()) ??
        undefined;

      const decoded = decodeLog(log.topics, log.data, contractAbi);

      results.push({
        ruleId: rule.id,
        detectionId: rule.detectionId,
        orgId: rule.orgId,
        log,
        decodedEventName: decoded?.eventName ?? `topic0:${topic0.slice(0, 10)}`,
        decodedArgs: decoded?.args ?? { topics: log.topics, data: log.data },
        matchType: rule.matchType,
        channelIds: rule.channelIds,
      });
    }
  }

  return results;
}
