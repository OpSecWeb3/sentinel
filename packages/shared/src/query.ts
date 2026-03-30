import { z } from 'zod';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type Collection = 'events' | 'alerts';

export type QueryOperator =
  | 'eq' | 'neq'
  | 'contains' | 'not_contains'
  | 'gt' | 'lt' | 'gte' | 'lte'
  | 'exists' | 'not_exists'
  | 'in';

export interface Clause {
  id: string;
  field: string;
  operator: QueryOperator;
  value: string | string[];
}

export interface ClauseGroup {
  id: string;
  logic: 'AND' | 'OR';
  clauses: Clause[];
}

export interface Aggregation {
  fn: 'count' | 'count_distinct';
  field?: string;
  groupBy: string[];
}

export interface QueryState {
  collection: Collection;
  groups: ClauseGroup[];
  timeRange: { from: string | null; to: string | null };
  aggregation: Aggregation | null;
  orderBy: { field: string; dir: 'asc' | 'desc' } | null;
  limit: number;
  page: number;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const collectionSchema = z.enum(['events', 'alerts']);

export const operatorSchema = z.enum([
  'eq', 'neq',
  'contains', 'not_contains',
  'gt', 'lt', 'gte', 'lte',
  'exists', 'not_exists',
  'in',
]);

const fieldPathRegex = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

export const clauseSchema = z.object({
  id: z.string(),
  field: z.string().min(1).max(200).regex(fieldPathRegex, 'Invalid field path'),
  operator: operatorSchema,
  value: z.union([z.string(), z.array(z.string())]),
});

export const clauseGroupSchema = z.object({
  id: z.string(),
  logic: z.enum(['AND', 'OR']),
  clauses: z.array(clauseSchema).min(1).max(20),
});

export const aggregationSchema = z.object({
  fn: z.enum(['count', 'count_distinct']),
  field: z.string().regex(fieldPathRegex).optional(),
  groupBy: z.array(z.string().regex(fieldPathRegex)).min(1).max(5),
});

export const queryStateSchema = z.object({
  collection: collectionSchema,
  groups: z.array(clauseGroupSchema).min(1).max(10),
  timeRange: z.object({
    from: z.string().datetime().nullable(),
    to: z.string().datetime().nullable(),
  }),
  aggregation: aggregationSchema.nullable(),
  orderBy: z.object({
    field: z.string().regex(fieldPathRegex),
    dir: z.enum(['asc', 'desc']),
  }).nullable(),
  limit: z.number().int().positive().max(100).default(25),
  page: z.number().int().positive().default(1),
});

// PayloadFieldDef is exported from module.ts (canonical location)

// ---------------------------------------------------------------------------
// Known top-level columns per collection
// ---------------------------------------------------------------------------

export const EVENT_COLUMNS = ['id', 'orgId', 'moduleId', 'eventType', 'externalId', 'occurredAt', 'receivedAt'] as const;
export const ALERT_COLUMNS = ['id', 'orgId', 'detectionId', 'ruleId', 'eventId', 'severity', 'title', 'description', 'triggerType', 'notificationStatus', 'createdAt'] as const;

export function isTopLevelColumn(collection: Collection, field: string): boolean {
  const cols = collection === 'events' ? EVENT_COLUMNS : ALERT_COLUMNS;
  return (cols as readonly string[]).includes(field);
}

export function isPayloadPath(field: string): boolean {
  return field.startsWith('payload.');
}
