import { z } from 'zod';
import type { Condition } from './conditions.js';

// ---------------------------------------------------------------------------
// Correlation rule types
// ---------------------------------------------------------------------------

// The condition schema used for event filters within correlation steps
const conditionSchema = z.object({
  field: z.string(),
  operator: z.enum(['==', '!=', '>', '<', '>=', '<=']),
  value: z.unknown(),
});

// Event filter — matches events to correlation steps
const eventFilterSchema = z.object({
  moduleId: z.string().optional(),
  eventType: z.union([z.string(), z.array(z.string())]).optional(),
  conditions: z.array(conditionSchema).default([]),
});

// Cross-step condition — links fields between events in a sequence
const crossStepConditionSchema = z.object({
  field: z.string(),        // field on the current event (e.g., "sender.login")
  operator: z.enum(['==', '!=']),
  ref: z.string(),          // reference to a previous step's field (e.g., "steps.ProtectionDisabled.sender.login")
});

// A single step in a sequence correlation rule
const correlationStepSchema = z.object({
  name: z.string().min(1),
  eventFilter: eventFilterSchema,
  withinMinutes: z.number().positive().optional(),   // time constraint relative to previous step
  matchConditions: z.array(crossStepConditionSchema).default([]),
});

// Correlation key field — a single entry must be either a payload field reference
// or a literal constant value. Literals let rules whose events are already pinned
// via `eventFilter.conditions` group into a single instance without sharing a
// common payload field across event types.
const correlationKeyFieldSchema = z.union([
  z.object({
    field: z.string(),
    alias: z.string().optional(),
  }),
  z.object({
    literal: z.string().min(1),
    alias: z.string().optional(),
  }),
]);

// Aggregation config (Phase 2)
const aggregationConfigSchema = z.object({
  eventFilter: eventFilterSchema,
  threshold: z.number().int().positive(),
  countField: z.string().optional(),       // count distinct values of this field
  groupByField: z.string().optional(),
});

// Cross-event condition for absence rules — links expected event fields to trigger event fields
const absenceMatchConditionSchema = z.object({
  field: z.string(),        // field on the expected event (e.g., "sender.login")
  operator: z.enum(['==', '!=']),
  triggerField: z.string(), // field on the trigger event (e.g., "sender.login")
});

// Absence config (Phase 3)
//
// Semantics:
//   - graceMinutes   (forward window)  : on trigger, wait up to N minutes for an
//                                        expected event; if none arrives, fire.
//   - lookbackMinutes (retrospective)  : on trigger, query the event store for
//                                        a matching expected event in the prior
//                                        N minutes; if none exists, fire.
//   - both set                         : bidirectional ±window semantics — fire
//                                        only if no expected event exists either
//                                        in the lookback OR within the grace.
//   - exactly one must be > 0          : enforced by refine below.
const absenceConfigSchema = z.object({
  trigger: z.object({ eventFilter: eventFilterSchema }),
  expected: z.object({
    eventFilter: eventFilterSchema,
    matchConditions: z.array(absenceMatchConditionSchema).default([]),
  }),
  graceMinutes: z.number().min(0).max(1440).optional(),
  lookbackMinutes: z.number().int().min(0).max(1440).optional(),
}).refine(
  (data) => (data.graceMinutes ?? 0) > 0 || (data.lookbackMinutes ?? 0) > 0,
  { message: 'absence config must set graceMinutes > 0, lookbackMinutes > 0, or both' },
);

// Full correlation rule config (stored in JSONB)
export const correlationRuleConfigSchema = z.object({
  type: z.enum(['sequence', 'aggregation', 'absence']),
  correlationKey: z.array(correlationKeyFieldSchema).min(1),
  windowMinutes: z.number().positive(),
  steps: z.array(correlationStepSchema).min(2).optional(),        // required for 'sequence'
  aggregation: aggregationConfigSchema.optional(),                  // required for 'aggregation'
  absence: absenceConfigSchema.optional(),                          // required for 'absence'
}).refine(
  (data) => {
    if (data.type === 'sequence') return data.steps !== undefined && data.steps.length >= 2;
    if (data.type === 'aggregation') return data.aggregation !== undefined;
    if (data.type === 'absence') return data.absence !== undefined;
    return false;
  },
  { message: 'Config must include the appropriate field for the correlation type' },
).refine(
  (data) => {
    // Literal correlation keys collapse every event for the rule into one
    // instance. That's only safe if every eventFilter the rule references is
    // pinned via `conditions`; otherwise an unrelated event could wander in
    // and poison the instance. Enforce conditions.length >= 1 on every
    // referenced filter when any correlationKey entry is a literal.
    const hasLiteral = data.correlationKey.some((k) => 'literal' in k);
    if (!hasLiteral) return true;

    const filters: Array<{ conditions?: unknown[] }> = [];
    if (data.type === 'sequence' && data.steps) {
      for (const step of data.steps) filters.push(step.eventFilter);
    } else if (data.type === 'aggregation' && data.aggregation) {
      filters.push(data.aggregation.eventFilter);
    } else if (data.type === 'absence' && data.absence) {
      filters.push(data.absence.trigger.eventFilter);
      filters.push(data.absence.expected.eventFilter);
    }
    return filters.every((f) => Array.isArray(f.conditions) && f.conditions.length >= 1);
  },
  { message: 'literal correlationKey requires every eventFilter to have conditions.length >= 1' },
);

export type CorrelationRuleConfig = z.infer<typeof correlationRuleConfigSchema>;
export type CorrelationStep = z.infer<typeof correlationStepSchema>;
export type EventFilter = z.infer<typeof eventFilterSchema>;
export type CrossStepCondition = z.infer<typeof crossStepConditionSchema>;
export type CorrelationKeyField = z.infer<typeof correlationKeyFieldSchema>;
export type AggregationConfig = z.infer<typeof aggregationConfigSchema>;
export type AbsenceConfig = z.infer<typeof absenceConfigSchema>;
export type AbsenceMatchCondition = z.infer<typeof absenceMatchConditionSchema>;

// ---------------------------------------------------------------------------
// Correlation rule row (from DB)
// ---------------------------------------------------------------------------

export interface CorrelationRuleRow {
  id: string;
  orgId: string;
  createdBy: string | null;
  name: string;
  description: string | null;
  severity: string;
  status: string;
  config: CorrelationRuleConfig;
  channelIds: string[];
  slackChannelId: string | null;
  slackChannelName: string | null;
  cooldownMinutes: number;
  lastTriggeredAt: Date | null;
}

// ---------------------------------------------------------------------------
// Correlation instance — in-flight state stored in Redis
// ---------------------------------------------------------------------------

export interface CorrelationInstance {
  ruleId: string;
  orgId: string;
  correlationKeyHash: string;
  correlationKeyValues: Record<string, string>;
  currentStepIndex: number;
  startedAt: number;           // epoch ms
  expiresAt: number;           // epoch ms
  matchedSteps: MatchedStep[];
}

export interface MatchedStep {
  stepName: string;
  eventId: string;
  eventType: string;
  timestamp: number;           // epoch ms
  actor: string | null;        // extracted sender/actor for cross-step analysis
  fields: Record<string, unknown>;  // subset of event fields needed for matchConditions
}

// ---------------------------------------------------------------------------
// Correlated alert candidate
// ---------------------------------------------------------------------------

export interface CorrelatedAlertCandidate {
  orgId: string;
  correlationRuleId: string;
  severity: string;
  title: string;
  description: string;
  triggerType: 'correlated';
  triggerData: {
    correlationType: 'sequence' | 'aggregation' | 'absence';
    correlationKey: Record<string, string>;
    windowMinutes: number;
    matchedSteps: MatchedStep[];
    sameActor: boolean;
    actors: string[];
    timeSpanMinutes: number;
    modules: string[];
    lookbackResult?: {
      queried: boolean;
      matched: boolean;
      candidatesScanned: number;
    };
  };
}
