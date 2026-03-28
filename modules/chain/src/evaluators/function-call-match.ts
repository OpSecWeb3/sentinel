import { z } from 'zod';
import { toFunctionSelector } from 'viem';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import { conditionSchema, evaluateConditions, type Condition } from './event-match.js';
import { NETWORK_UI_FIELD, CONTRACT_UI_FIELD } from './_ui-shared.js';

// ---------------------------------------------------------------------------
// Config schema — matches ChainAlert's FnCallRuleConfig shape
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Function signature, e.g. "transfer(address,uint256)" */
  functionSignature: z.string(),
  /** Human-readable function name for display */
  functionName: z.string().optional(),
  /** Pre-computed 4-byte selector (0x-prefixed, lowercase). Derived from functionSignature if absent. */
  selector: z.string().optional(),
  /** Monitored contract address (lowercase hex) */
  contractAddress: z.string(),
  /** Conditions applied to decoded function arguments */
  conditions: z.array(conditionSchema).default([]),
});

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const functionCallMatchEvaluator: RuleEvaluator = {
  moduleId: 'chain',
  ruleType: 'chain.function_call_match',
  configSchema,
  uiSchema: [
    NETWORK_UI_FIELD,
    CONTRACT_UI_FIELD,
    { key: 'functionSignature', label: 'Function signature', type: 'text', required: true, placeholder: 'transfer(address,uint256)', help: 'ABI function signature to match.' },
  ],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;

    // Only handle on-chain transaction events
    if (event.eventType !== 'chain.transaction') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      hash: string;
      from: string;
      to: string | null;
      input: string;
      value: string;
      blockNumber?: string;
      decodedArgs?: Record<string, unknown>;
      functionName?: string;
    };

    // Must have a `to` address and input data (at least 4-byte selector)
    if (!payload.to || !payload.input || payload.input.length < 10) return null;

    // ----- Address filter: tx.to must match the monitored contract -----
    if (payload.to.toLowerCase() !== config.contractAddress.toLowerCase()) return null;

    // ----- Selector matching -----
    const txSelector = payload.input.slice(0, 10).toLowerCase();
    // config.selector is optional — derive it from functionSignature when absent.
    // The old code returned null here, silently preventing rules without a
    // pre-computed selector from ever firing (HIGH bug).
    const ruleSelector = (config.selector ?? toFunctionSelector(config.functionSignature)).toLowerCase();
    if (txSelector !== ruleSelector) return null;

    // ----- Field conditions on decoded args -----
    const args = payload.decodedArgs ?? {};
    if (!evaluateConditions(args, config.conditions)) return null;

    // ----- Matched -----
    const fnName = payload.functionName ?? config.functionName ?? config.functionSignature;
    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `Function call ${fnName} matched on ${payload.to}`,
      description: `Transaction ${payload.hash} called ${fnName} matching rule conditions`,
      triggerType: 'immediate',
      triggerData: {
        type: 'function-call-match',
        functionName: fnName,
        contractAddress: payload.to,
        blockNumber: payload.blockNumber,
        transactionHash: payload.hash,
        from: payload.from,
        decodedArgs: args,
      },
    };
  },
};
