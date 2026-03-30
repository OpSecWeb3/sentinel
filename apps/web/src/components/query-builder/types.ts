// Query builder types — mirrors packages/shared/src/query.ts for the web app

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

export const EVENT_COLUMNS = ['id', 'orgId', 'moduleId', 'eventType', 'externalId', 'occurredAt', 'receivedAt'] as const;
export const ALERT_COLUMNS = ['id', 'orgId', 'detectionId', 'ruleId', 'eventId', 'severity', 'title', 'description', 'triggerType', 'notificationStatus', 'createdAt'] as const;
