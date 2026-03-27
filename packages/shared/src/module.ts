import type { Hono } from 'hono';
import type { RuleEvaluator } from './rules.js';
import type { JobHandler } from './queue.js';
import type { ZodSchema } from 'zod';
import type { AppEnv } from './hono-types.js';

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------

export interface RetentionPolicy {
  table: string;
  timestampColumn: string;
  retentionDays: number;
}

// ---------------------------------------------------------------------------
// Detection module interface
// ---------------------------------------------------------------------------

export interface DetectionModule {
  /** Unique module identifier: 'github', 'blockchain', 'supply-chain', 'infra' */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Hono router — mounted at /modules/{id} by the API app */
  readonly router: Hono<AppEnv>;

  /** Rule evaluators this module provides */
  readonly evaluators: RuleEvaluator[];

  /** BullMQ job handlers this module provides */
  readonly jobHandlers: JobHandler[];

  /** Event types this module can produce */
  readonly eventTypes: EventTypeDefinition[];

  /** Detection templates users can create from */
  readonly templates: DetectionTemplate[];

  /** Data retention policies for module-owned tables */
  readonly retentionPolicies?: RetentionPolicy[];

  /** Template slugs to auto-instantiate when a monitored resource is created */
  readonly defaultTemplates?: string[];

  /** Custom Slack Block Kit formatter. If provided, dispatcher uses this instead of generic blocks. */
  formatSlackBlocks?: (alert: { title: string; severity: string; description?: string; module: string; eventType: string; fields?: Array<{ label: string; value: string }>; timestamp: string }) => object[];
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface EventTypeDefinition {
  /** Fully qualified type, e.g. 'github.repository.publicized' */
  type: string;

  /** Human-readable label */
  label: string;

  /** Description of what this event means */
  description: string;

  /** Zod schema for the normalized payload */
  payloadSchema?: ZodSchema;
}

export interface DetectionTemplate {
  /** URL-safe slug, e.g. 'github-repo-visibility' */
  slug: string;

  /** Human-readable name */
  name: string;

  description: string;

  /** Category for UI grouping: 'access-control', 'code-protection', 'secrets', etc. */
  category: string;

  /** Default severity */
  severity: 'low' | 'medium' | 'high' | 'critical';

  /** Rules this template creates */
  rules: Array<{
    ruleType: string;
    config: Record<string, unknown>;
    action: 'alert' | 'log' | 'suppress';
    priority?: number;
  }>;
}
