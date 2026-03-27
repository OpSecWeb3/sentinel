import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import { NETWORK_UI_FIELD, CONTRACT_UI_FIELD, EVENT_SIG_UI_FIELD } from './_ui-shared.js';

// ---------------------------------------------------------------------------
// Condition types — ported from ChainAlert's event-filter conditions
// ---------------------------------------------------------------------------

export type ComparisonOperator = '>' | '<' | '>=' | '<=' | '==' | '!=';

export const conditionSchema = z.object({
  field: z.string(),
  operator: z.enum(['>', '<', '>=', '<=', '==', '!=']),
  value: z.unknown(),
});

export type Condition = z.infer<typeof conditionSchema>;

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Event signature, e.g. "Transfer(address,address,uint256)" */
  eventSignature: z.string().optional(),
  /** Pre-computed topic0 (keccak256 of event signature). Either this or eventSignature required. */
  topic0: z.string().optional(),
  /** Optional contract address filter (lowercase hex) */
  contractAddress: z.string().optional(),
  /** Field-level conditions applied to decoded event args */
  conditions: z.array(conditionSchema).default([]),
});

// ---------------------------------------------------------------------------
// Helpers — ported from ChainAlert's evaluateConditions
// ---------------------------------------------------------------------------

function coerceNumeric(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') {
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  }
  return null;
}

function evaluateCondition(args: Record<string, unknown>, condition: Condition): boolean {
  const actual = args[condition.field];
  if (actual === undefined) return false;

  const op = condition.operator;

  // String equality / inequality (addresses, hashes, etc.)
  if (op === '==' || op === '!=') {
    const actualStr = String(actual).toLowerCase();
    const expectedStr = String(condition.value).toLowerCase();
    return op === '==' ? actualStr === expectedStr : actualStr !== expectedStr;
  }

  // Numeric comparisons
  const actualNum = coerceNumeric(actual);
  const expectedNum = coerceNumeric(condition.value);
  if (actualNum === null || expectedNum === null) return false;

  switch (op) {
    case '>':
      return actualNum > expectedNum;
    case '<':
      return actualNum < expectedNum;
    case '>=':
      return actualNum >= expectedNum;
    case '<=':
      return actualNum <= expectedNum;
    default:
      return false;
  }
}

export function evaluateConditions(
  args: Record<string, unknown>,
  conditions: Condition[],
): boolean {
  return conditions.every((c) => evaluateCondition(args, c));
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const eventMatchEvaluator: RuleEvaluator = {
  moduleId: 'chain',
  ruleType: 'chain.event_match',
  configSchema,
  uiSchema: [
    NETWORK_UI_FIELD,
    CONTRACT_UI_FIELD,
    EVENT_SIG_UI_FIELD,
  ],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;

    const config = configSchema.parse(rule.config);

    let contractAddress: string;
    let args: Record<string, unknown>;
    let eventName: string;
    let blockNumber: string | undefined;
    let transactionHash: string | undefined;
    let logIndex: number | undefined;

    if (event.eventType === 'chain.event.matched') {
      // Payload produced by blockProcessHandler via normalizeMatchedEvent
      const p = event.payload as {
        contractAddress: string;
        eventArgs?: Record<string, unknown>;
        eventName?: string;
        topic0?: string;
        blockNumber?: string;
        transactionHash?: string;
        logIndex?: number;
      };

      // Verify the event actually matches the rule's expected event signature.
      // RuleEngine evaluates ALL rules against every event, so a Transfer event
      // would otherwise match a Paused rule if they share a contract address.
      const expectedEventName = config.eventSignature?.split('(')[0];
      if (expectedEventName && p.eventName && p.eventName !== expectedEventName) {
        return null;
      }

      contractAddress = p.contractAddress;
      args = p.eventArgs ?? {};
      eventName = p.eventName ?? 'UnknownEvent';
      blockNumber = p.blockNumber;
      transactionHash = p.transactionHash;
      logIndex = p.logIndex;
    } else if (event.eventType === 'chain.log') {
      // Raw log event shape
      const p = event.payload as {
        topics: string[];
        address: string;
        decodedArgs?: Record<string, unknown>;
        eventName?: string;
        blockNumber?: string;
        transactionHash?: string;
        logIndex?: number;
      };

      // topic0 matching
      const logTopic0 = p.topics?.[0]?.toLowerCase();
      if (!logTopic0) return null;
      const ruleTopic0 = (config.topic0 ?? '').toLowerCase();
      if (!ruleTopic0) return null;
      if (logTopic0 !== ruleTopic0) return null;

      contractAddress = p.address;
      args = p.decodedArgs ?? {};
      eventName = p.eventName ?? 'UnknownEvent';
      blockNumber = p.blockNumber;
      transactionHash = p.transactionHash;
      logIndex = p.logIndex;
    } else {
      return null;
    }

    // ----- contract address filter -----
    if (config.contractAddress) {
      if (contractAddress.toLowerCase() !== config.contractAddress.toLowerCase()) {
        return null;
      }
    }

    // ----- field conditions -----
    if (!evaluateConditions(args, config.conditions)) {
      return null;
    }

    // ----- matched -----
    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `Event ${eventName} matched on ${contractAddress}`,
      description: `Transaction ${transactionHash ?? 'unknown'} emitted ${eventName} matching rule conditions`,
      triggerType: 'immediate',
      triggerData: {
        type: 'event-match',
        eventName,
        contractAddress,
        blockNumber,
        transactionHash,
        logIndex,
        decodedArgs: args,
      },
    };
  },
};
