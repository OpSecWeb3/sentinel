import type { Hono } from 'hono';
import type { RuleEvaluator } from './rules.js';
import type { JobHandler } from './queue.js';
import type { ZodSchema } from 'zod';
import type { AppEnv } from './hono-types.js';

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------

/**
 * A preserve rule keeps rows from being deleted by retention even when they are
 * older than retentionDays. This lets retention express the idea "keep data
 * only as long as something still needs it" — alerts keep their trigger event,
 * correlation rules keep the substrate inside their lookback window.
 *
 * Each variant is matched against a small allowlist inside the retention
 * handler; unknown variants are ignored (fail-safe = more preservation).
 */
export type PreserveRule =
  /** Keep rows that a foreign table references via `column = <this-table>.id`. */
  | { kind: 'referenced_by'; table: string; column: string }
  /**
   * Keep rows whose timestampColumn is newer than `now - max(windowMinutes +
   * graceMinutes)` across all active correlation rules. Used to protect the
   * substrate that absence / sequence / aggregation rules need.
   */
  | { kind: 'within_correlation_window' };

export interface RetentionPolicy {
  table: string;
  timestampColumn: string;
  retentionDays: number;
  /** Optional SQL fragment appended as an extra AND condition (e.g. "module_id = 'aws'") */
  filter?: string;
  /** Use ctid for batched deletes on tables without an `id` column (e.g. composite PKs). */
  useCtid?: boolean;
  /**
   * Additional preservation rules: a row is only deleted if every preserveIf
   * rule says it is safe to delete. Empty / omitted means pure TTL semantics.
   */
  preserveIf?: PreserveRule[];
  /**
   * Count rows that would be deleted but do not delete them. For validating a
   * new policy before flipping it to destructive mode.
   */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Template input — defines a user-configurable field for a detection template
// ---------------------------------------------------------------------------

export type TemplateInputType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'string-array'
  | 'address'
  | 'contract'
  | 'network';

export interface TemplateInput {
  /** Config key this input maps to (used in placeholder substitution and rule config merge) */
  key: string;

  /** Human-readable label shown in the form */
  label: string;

  /** How to render the input */
  type: TemplateInputType;

  required: boolean;

  /** Default value. Arrays are shown as newline-separated text in string-array inputs. */
  default?: string | number | boolean | string[];

  placeholder?: string;

  /** Helper text shown below the field */
  help?: string;

  /** Options for select type */
  options?: Array<{ label: string; value: string }>;

  min?: number;
  max?: number;

  /** Only show this input when the referenced input key has a non-empty value */
  showIf?: string;
}

// ---------------------------------------------------------------------------
// Slack alert payload — shared across formatters and dispatcher
// ---------------------------------------------------------------------------

export interface SlackAlertFields {
  title: string;
  severity: string;
  description?: string;
  module: string;
  eventType: string;
  fields?: Array<{ label: string; value: string }>;
  timestamp: string;
  /** Deep-link to this alert in the Sentinel dashboard */
  alertUrl?: string;
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
  formatSlackBlocks?: (alert: SlackAlertFields) => object[];
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface PayloadFieldDef {
  /** Dot-notation path, e.g. "sender.login" */
  path: string;
  /** Human-readable label */
  label: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  examples?: string[];
}

export interface EventTypeDefinition {
  /** Fully qualified type, e.g. 'github.repository.publicized' */
  type: string;

  /** Human-readable label */
  label: string;

  /** Description of what this event means */
  description: string;

  /** Zod schema for the normalized payload */
  payloadSchema?: ZodSchema;

  /** Curated payload field metadata for the query builder field picker */
  payloadFields?: PayloadFieldDef[];
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

  /**
   * User-configurable inputs. The UI renders a form field for each input.
   * Values replace {{key}} placeholders in rule configs and are also merged
   * directly as top-level config keys.
   */
  inputs?: TemplateInput[];
}
