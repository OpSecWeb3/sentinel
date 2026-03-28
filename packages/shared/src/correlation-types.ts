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

// Correlation key field — defines which payload fields events must share
const correlationKeyFieldSchema = z.object({
  field: z.string(),         // JSON path in event payload (e.g., "repository.full_name")
  alias: z.string().optional(),
});

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
const absenceConfigSchema = z.object({
  trigger: z.object({ eventFilter: eventFilterSchema }),
  expected: z.object({
    eventFilter: eventFilterSchema,
    matchConditions: z.array(absenceMatchConditionSchema).default([]),
  }),
  graceMinutes: z.number().positive(),
});

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
  };
}
