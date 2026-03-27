import { z, type ZodSchema } from 'zod';
import type { Redis } from 'ioredis';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface NormalizedEvent {
  id: string;
  orgId: string;
  moduleId: string;
  eventType: string;
  externalId: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
  receivedAt: Date;
}

export interface RuleRow {
  id: string;
  detectionId: string;
  orgId: string;
  moduleId: string;
  ruleType: string;
  config: Record<string, unknown>;
  status: string;
  priority: number;
  action: string;
}

export interface DetectionRow {
  id: string;
  orgId: string;
  severity: string;
  channelIds: string[];
  slackChannelId: string | null;
  slackChannelName: string | null;
  cooldownMinutes: number;
  lastTriggeredAt: Date | null;
}

// ---------------------------------------------------------------------------
// Alert candidate — output of a successful rule evaluation
// ---------------------------------------------------------------------------

export interface AlertCandidate {
  orgId: string;
  detectionId: string;
  ruleId: string;
  eventId: string;
  severity: string;
  title: string;
  description?: string;
  triggerType: 'immediate' | 'windowed' | 'deferred';
  triggerData: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Evaluation context passed to evaluators
// ---------------------------------------------------------------------------

export interface EvalContext {
  event: NormalizedEvent;
  rule: RuleRow;
  redis: Redis;
  /** Resource identifier extracted by the module normalizer (e.g. repo fullName, contract address, hostname). */
  resourceId?: string;
  /** Evaluator registry — used by the compound evaluator to resolve sub-rules. */
  evaluators?: Map<string, RuleEvaluator>;
}

// ---------------------------------------------------------------------------
// Resource filter — glob-based resource scoping on rules
// ---------------------------------------------------------------------------

export const resourceFilterSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
}).optional();

export type ResourceFilter = z.infer<typeof resourceFilterSchema>;

// ---------------------------------------------------------------------------
// Rule evaluator interface — modules implement this
// ---------------------------------------------------------------------------

export interface RuleEvaluator {
  /** Must match rules.moduleId */
  readonly moduleId: string;

  /** Must match rules.ruleType, e.g. 'github.repo_visibility' */
  readonly ruleType: string;

  /** Zod schema for validating rule.config */
  readonly configSchema: ZodSchema;

  /** Evaluate an event against this rule. Return AlertCandidate if triggered, null otherwise. */
  evaluate(ctx: EvalContext): Promise<AlertCandidate | null>;
}
