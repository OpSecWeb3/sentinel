/**
 * Parses Sentinel Query Language text into a QueryState.
 *
 * Grammar:
 *   <collection> WHERE <clause> [AND|OR <clause>]* [SINCE <duration>] [LIMIT <n>]
 *
 * Returns null if the text can't be parsed.
 */

import type { QueryState, ClauseGroup, Clause, QueryOperator, Collection } from '../types';
import { genId } from '../utils';

interface Token {
  type: 'word' | 'string' | 'number' | 'operator' | 'paren' | 'comma';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Whitespace
    if (/\s/.test(input[i])) { i++; continue; }

    // String literal
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      let val = '';
      i++;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) { val += input[++i]; }
        else { val += input[i]; }
        i++;
      }
      i++; // skip closing quote
      tokens.push({ type: 'string', value: val });
      continue;
    }

    // Parentheses
    if (input[i] === '(' || input[i] === ')') {
      tokens.push({ type: 'paren', value: input[i] });
      i++;
      continue;
    }

    // Comma
    if (input[i] === ',') {
      tokens.push({ type: 'comma', value: ',' });
      i++;
      continue;
    }

    // Multi-char operators
    if (input[i] === '!' && input[i + 1] === '=') {
      tokens.push({ type: 'operator', value: '!=' });
      i += 2;
      continue;
    }
    if (input[i] === '>' && input[i + 1] === '=') {
      tokens.push({ type: 'operator', value: '>=' });
      i += 2;
      continue;
    }
    if (input[i] === '<' && input[i + 1] === '=') {
      tokens.push({ type: 'operator', value: '<=' });
      i += 2;
      continue;
    }

    // Single-char operators
    if ('=><'.includes(input[i])) {
      tokens.push({ type: 'operator', value: input[i] });
      i++;
      continue;
    }

    // Words and numbers
    if (/[a-zA-Z0-9_.]/.test(input[i])) {
      let val = '';
      while (i < input.length && /[a-zA-Z0-9_.]/.test(input[i])) {
        val += input[i];
        i++;
      }
      if (/^\d+(\.\d+)?$/.test(val)) {
        tokens.push({ type: 'number', value: val });
      } else {
        tokens.push({ type: 'word', value: val });
      }
      continue;
    }

    // Skip unknown
    i++;
  }

  return tokens;
}

const OP_MAP: Record<string, QueryOperator> = {
  '=': 'eq',
  '!=': 'neq',
  '>': 'gt',
  '<': 'lt',
  '>=': 'gte',
  '<=': 'lte',
  'CONTAINS': 'contains',
  'NOT_CONTAINS': 'not_contains',
  'IN': 'in',
  'EXISTS': 'exists',
  'NOT_EXISTS': 'not_exists',
};

function parseDuration(val: string): string | null {
  const match = val.match(/^(\d+)([hdms])$/i);
  if (!match) return null;
  const num = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit === 'h' ? num * 3600_000 : unit === 'd' ? num * 86400_000 : unit === 'm' ? num * 60_000 : num * 1000;
  return new Date(Date.now() - ms).toISOString();
}

export function parseQuery(input: string): QueryState | null {
  const tokens = tokenize(input.trim());
  if (tokens.length === 0) return null;

  let pos = 0;

  function peek(): Token | undefined { return tokens[pos]; }
  function advance(): Token | undefined { return tokens[pos++]; }
  function expect(type: string, value?: string): Token | undefined {
    const t = peek();
    if (!t || t.type !== type) return undefined;
    if (value !== undefined && t.value.toUpperCase() !== value.toUpperCase()) return undefined;
    return advance();
  }

  // Collection
  const collToken = advance();
  if (!collToken || collToken.type !== 'word') return null;
  const collection = collToken.value.toLowerCase();
  if (collection !== 'events' && collection !== 'alerts') return null;

  const state: QueryState = {
    collection: collection as Collection,
    groups: [],
    timeRange: { from: null, to: null },
    aggregation: null,
    orderBy: null,
    limit: 25,
    page: 1,
  };

  // Optional WHERE
  if (!expect('word', 'WHERE')) {
    if (pos < tokens.length) return null; // unexpected tokens
    state.groups = [{ id: genId(), logic: 'AND', clauses: [{ id: genId(), field: '', operator: 'eq', value: '' }] }];
    return state;
  }

  // Parse clauses
  let currentLogic: 'AND' | 'OR' = 'AND';
  const clauses: Array<{ logic: 'AND' | 'OR'; clause: Clause }> = [];

  while (pos < tokens.length) {
    const t = peek();
    if (!t) break;

    // Check for trailing keywords (SINCE, LIMIT, ORDER, GROUP)
    if (t.type === 'word') {
      const upper = t.value.toUpperCase();
      if (upper === 'SINCE' || upper === 'LIMIT' || upper === 'ORDER' || upper === 'GROUP') break;
    }

    // Parse a clause: field operator value
    const fieldToken = advance();
    if (!fieldToken || (fieldToken.type !== 'word' && fieldToken.type !== 'string')) break;
    const field = fieldToken.value;

    // Operator
    const opToken = peek();
    if (!opToken) break;

    let operator: QueryOperator;
    let value: string | string[] = '';

    if (opToken.type === 'operator') {
      advance();
      operator = OP_MAP[opToken.value] ?? 'eq';
    } else if (opToken.type === 'word') {
      const upper = opToken.value.toUpperCase();
      if (OP_MAP[upper]) {
        advance();
        operator = OP_MAP[upper];
      } else {
        break; // unexpected
      }
    } else {
      break;
    }

    // Value (unless EXISTS/NOT_EXISTS)
    if (operator !== 'exists' && operator !== 'not_exists') {
      if (operator === 'in') {
        // IN (val1, val2, ...)
        expect('paren', '(');
        const vals: string[] = [];
        while (pos < tokens.length) {
          const vt = peek();
          if (!vt || (vt.type === 'paren' && vt.value === ')')) break;
          if (vt.type === 'comma') { advance(); continue; }
          const vToken = advance();
          if (vToken) vals.push(vToken.value);
        }
        expect('paren', ')');
        value = vals;
      } else {
        const vToken = advance();
        if (vToken) value = vToken.value;
      }
    }

    clauses.push({
      logic: currentLogic,
      clause: { id: genId(), field, operator, value },
    });

    // Check for AND/OR
    const nextToken = peek();
    if (nextToken?.type === 'word') {
      const upper = nextToken.value.toUpperCase();
      if (upper === 'AND' || upper === 'OR') {
        currentLogic = upper as 'AND' | 'OR';
        advance();
        continue;
      }
    }
    break;
  }

  // Group clauses by logic
  if (clauses.length === 0) {
    state.groups = [{ id: genId(), logic: 'AND', clauses: [{ id: genId(), field: '', operator: 'eq', value: '' }] }];
  } else {
    // Simple: all same logic → one group. Mixed → split into groups.
    const groups: ClauseGroup[] = [];
    let currentGroup: ClauseGroup = { id: genId(), logic: clauses[0].logic, clauses: [clauses[0].clause] };

    for (let i = 1; i < clauses.length; i++) {
      if (clauses[i].logic === currentGroup.logic) {
        currentGroup.clauses.push(clauses[i].clause);
      } else {
        groups.push(currentGroup);
        currentGroup = { id: genId(), logic: clauses[i].logic, clauses: [clauses[i].clause] };
      }
    }
    groups.push(currentGroup);
    state.groups = groups;
  }

  // Parse trailing: SINCE, LIMIT
  while (pos < tokens.length) {
    const t = peek();
    if (!t || t.type !== 'word') break;
    const upper = t.value.toUpperCase();

    if (upper === 'SINCE') {
      advance();
      const durToken = advance();
      if (durToken) {
        const from = parseDuration(durToken.value);
        if (from) state.timeRange.from = from;
      }
    } else if (upper === 'LIMIT') {
      advance();
      const limToken = advance();
      if (limToken && /^\d+$/.test(limToken.value)) {
        state.limit = Math.min(parseInt(limToken.value), 100);
      }
    } else {
      advance(); // skip unknown
    }
  }

  return state;
}

/**
 * Serialize a QueryState back to Sentinel Query Language text.
 */
export function serializeToText(state: QueryState): string {
  const parts: string[] = [state.collection];

  const allClauses: string[] = [];
  for (let gi = 0; gi < state.groups.length; gi++) {
    const group = state.groups[gi];
    for (let ci = 0; ci < group.clauses.length; ci++) {
      const c = group.clauses[ci];
      if (!c.field) continue;

      if (allClauses.length > 0) {
        allClauses.push(group.logic);
      }

      if (c.operator === 'exists') {
        allClauses.push(`${c.field} EXISTS`);
      } else if (c.operator === 'not_exists') {
        allClauses.push(`${c.field} NOT_EXISTS`);
      } else if (c.operator === 'in') {
        const vals = Array.isArray(c.value) ? c.value : [c.value];
        allClauses.push(`${c.field} IN (${vals.map(v => `"${v}"`).join(', ')})`);
      } else if (c.operator === 'contains') {
        allClauses.push(`${c.field} CONTAINS "${c.value}"`);
      } else if (c.operator === 'not_contains') {
        allClauses.push(`${c.field} NOT_CONTAINS "${c.value}"`);
      } else {
        const opMap: Record<string, string> = { eq: '=', neq: '!=', gt: '>', lt: '<', gte: '>=', lte: '<=' };
        allClauses.push(`${c.field} ${opMap[c.operator] ?? '='} "${c.value}"`);
      }
    }
  }

  if (allClauses.length > 0) {
    parts.push('WHERE');
    parts.push(allClauses.join(' '));
  }

  if (state.timeRange.from) {
    // Try to express as a duration
    const diffMs = Date.now() - new Date(state.timeRange.from).getTime();
    const hours = Math.round(diffMs / 3600_000);
    if (hours <= 1) parts.push('SINCE 1h');
    else if (hours <= 6) parts.push('SINCE 6h');
    else if (hours <= 24) parts.push('SINCE 24h');
    else if (hours <= 168) parts.push('SINCE 7d');
    else if (hours <= 720) parts.push('SINCE 30d');
    else parts.push(`SINCE ${Math.round(hours / 24)}d`);
  }

  if (state.limit !== 25) {
    parts.push(`LIMIT ${state.limit}`);
  }

  return parts.join(' ');
}
