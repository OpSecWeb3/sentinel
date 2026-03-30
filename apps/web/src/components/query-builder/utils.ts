import type { QueryState, Clause, ClauseGroup, QueryOperator } from './types';

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

let _idCounter = 0;
export function genId(): string {
  return `qb_${Date.now()}_${++_idCounter}`;
}

export function defaultClause(): Clause {
  return { id: genId(), field: '', operator: 'eq', value: '' };
}

export function defaultGroup(): ClauseGroup {
  return { id: genId(), logic: 'AND', clauses: [defaultClause()] };
}

export function defaultQueryState(): QueryState {
  return {
    collection: 'events',
    groups: [defaultGroup()],
    timeRange: { from: null, to: null },
    aggregation: null,
    orderBy: null,
    limit: 25,
    page: 1,
  };
}

// ---------------------------------------------------------------------------
// URL serialization
// ---------------------------------------------------------------------------

export function serializeQuery(state: QueryState): string {
  try {
    return btoa(JSON.stringify(state));
  } catch {
    return '';
  }
}

export function deserializeQuery(encoded: string): QueryState | null {
  try {
    return JSON.parse(atob(encoded)) as QueryState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SQL preview (read-only display, not executed)
// ---------------------------------------------------------------------------

const OP_SQL: Record<QueryOperator, string> = {
  eq: '=',
  neq: '!=',
  contains: 'ILIKE',
  not_contains: 'NOT ILIKE',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
  exists: 'IS NOT NULL',
  not_exists: 'IS NULL',
  in: 'IN',
};

function clausePreview(c: Clause): string {
  if (!c.field) return '...';
  const op = OP_SQL[c.operator];
  if (c.operator === 'exists' || c.operator === 'not_exists') {
    return `${c.field} ${op}`;
  }
  if (c.operator === 'in') {
    const vals = Array.isArray(c.value) ? c.value : [c.value];
    return `${c.field} IN (${vals.map((v: string) => `'${v}'`).join(', ')})`;
  }
  if (c.operator === 'contains' || c.operator === 'not_contains') {
    return `${c.field} ${op} '%${c.value}%'`;
  }
  return `${c.field} ${op} '${c.value}'`;
}

export function buildSqlPreview(state: QueryState): string {
  const table = state.collection;
  const parts: string[] = [`SELECT * FROM ${table}`];

  const whereParts: string[] = [];

  for (const group of state.groups) {
    if (group.clauses.length === 0) continue;
    const clauseStrs = group.clauses.map(clausePreview);
    if (clauseStrs.length === 1) {
      whereParts.push(clauseStrs[0]);
    } else {
      whereParts.push(`(${clauseStrs.join(` ${group.logic} `)})`);
    }
  }

  if (state.timeRange.from || state.timeRange.to) {
    const tsCol = state.collection === 'events' ? 'received_at' : 'created_at';
    if (state.timeRange.from) whereParts.push(`${tsCol} >= '${state.timeRange.from}'`);
    if (state.timeRange.to) whereParts.push(`${tsCol} <= '${state.timeRange.to}'`);
  }

  if (whereParts.length > 0) {
    parts.push(`WHERE ${whereParts.join('\n  AND ')}`);
  }

  if (state.aggregation) {
    const groupBy = state.aggregation.groupBy.join(', ');
    const fn = state.aggregation.fn === 'count_distinct' && state.aggregation.field
      ? `COUNT(DISTINCT ${state.aggregation.field})`
      : 'COUNT(*)';
    parts[0] = `SELECT ${groupBy}, ${fn} FROM ${table}`;
    parts.push(`GROUP BY ${groupBy}`);
  }

  if (state.orderBy) {
    parts.push(`ORDER BY ${state.orderBy.field} ${state.orderBy.dir.toUpperCase()}`);
  }

  parts.push(`LIMIT ${state.limit} OFFSET ${(state.page - 1) * state.limit}`);

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Operator helpers
// ---------------------------------------------------------------------------

export const OPERATORS_BY_TYPE: Record<string, QueryOperator[]> = {
  string: ['eq', 'neq', 'contains', 'not_contains', 'in', 'exists', 'not_exists'],
  number: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'exists', 'not_exists'],
  boolean: ['eq', 'neq', 'exists', 'not_exists'],
  array: ['contains', 'not_contains', 'exists', 'not_exists'],
  object: ['exists', 'not_exists'],
};

export const OPERATOR_LABELS: Record<QueryOperator, string> = {
  eq: 'equals',
  neq: 'not equals',
  contains: 'contains',
  not_contains: 'not contains',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
  exists: 'exists',
  not_exists: 'not exists',
  in: 'in',
};

export const NO_VALUE_OPS: QueryOperator[] = ['exists', 'not_exists'];

// ---------------------------------------------------------------------------
// Time range presets
// ---------------------------------------------------------------------------

export const TIME_PRESETS = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
] as const;
