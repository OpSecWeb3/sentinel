import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import { conditionSchema, evaluateConditions, type Condition } from './event-match.js';

// ---------------------------------------------------------------------------
// Config schema — monitors read-only contract function return values
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Contract address to call */
  contractAddress: z.string(),
  /** Function signature, e.g. "totalSupply()" or "balanceOf(address)" */
  functionSignature: z.string(),
  /** Human-readable function name for display */
  functionName: z.string().optional(),
  /** Conditions applied to the return values */
  conditions: z.array(conditionSchema).default([]),
  /**
   * For single-return-value functions, the field name to use when evaluating
   * conditions. Defaults to "result". For multi-return functions, use
   * the named return parameter fields in conditions.
   */
  resultField: z.string().default('result'),
});

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const viewCallEvaluator: RuleEvaluator = {
  moduleId: 'chain',
  ruleType: 'chain.view_call',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;

    // Handle view-call result events (polled by the state-poller pipeline)
    if (event.eventType !== 'chain.view_call_result') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      contractAddress: string;
      functionName?: string;
      returnValues: Record<string, unknown>;
      blockNumber?: string;
    };

    // ----- Address filter -----
    if (payload.contractAddress.toLowerCase() !== config.contractAddress.toLowerCase()) {
      return null;
    }

    // ----- Build args map for condition evaluation -----
    // For single-return functions, the value is typically under a generic key.
    // Normalize so conditions can reference `resultField` or named return params.
    const args: Record<string, unknown> = { ...payload.returnValues };

    // If there's a single unnamed return value, expose it under resultField
    if (args['0'] !== undefined && args[config.resultField] === undefined) {
      args[config.resultField] = args['0'];
    }

    // ----- Evaluate conditions -----
    if (!evaluateConditions(args, config.conditions)) {
      return null;
    }

    // ----- Matched -----
    const fnName = payload.functionName ?? config.functionName ?? config.functionSignature;

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `View call ${fnName} on ${config.contractAddress} triggered`,
      description: `Read-only call to ${fnName} on ${config.contractAddress} returned values matching rule conditions`,
      triggerType: 'deferred',
      triggerData: {
        type: 'view-call',
        contractAddress: config.contractAddress,
        functionName: fnName,
        blockNumber: payload.blockNumber,
        returnValues: payload.returnValues,
      },
    };
  },
};
