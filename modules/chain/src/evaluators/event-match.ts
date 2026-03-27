import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

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

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;

    // Only handle on-chain log events
    if (event.eventType !== 'chain.log') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      topics: string[];
      address: string;
      decodedArgs?: Record<string, unknown>;
      eventName?: string;
      blockNumber?: string;
      transactionHash?: string;
      logIndex?: number;
    };

    // ----- topic0 matching -----
    const logTopic0 = payload.topics?.[0]?.toLowerCase();
    if (!logTopic0) return null;

    const ruleTopic0 = (config.topic0 ?? '').toLowerCase();
    if (!ruleTopic0) return null; // misconfigured rule
    if (logTopic0 !== ruleTopic0) return null;

    // ----- contract address filter -----
    if (config.contractAddress) {
      if (payload.address.toLowerCase() !== config.contractAddress.toLowerCase()) {
        return null;
      }
    }

    // ----- field conditions -----
    const args = payload.decodedArgs ?? {};
    if (!evaluateConditions(args, config.conditions)) {
      return null;
    }

    // ----- matched -----
    const eventName = payload.eventName ?? 'UnknownEvent';
    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `Event ${eventName} matched on ${payload.address}`,
      description: `Transaction ${payload.transactionHash ?? 'unknown'} emitted ${eventName} matching rule conditions`,
      triggerType: 'immediate',
      triggerData: {
        type: 'event-match',
        eventName,
        contractAddress: payload.address,
        blockNumber: payload.blockNumber,
        transactionHash: payload.transactionHash,
        logIndex: payload.logIndex,
        decodedArgs: args,
      },
    };
  },
};
