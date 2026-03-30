/**
 * Autocomplete provider for Sentinel Query Language.
 * Context-aware: suggests collections, fields, operators, values based on cursor position.
 */

import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';

// ---------------------------------------------------------------------------
// Field definitions (shared with visual builder)
// ---------------------------------------------------------------------------

const EVENT_FIELDS: Completion[] = [
  { label: 'moduleId', type: 'property', detail: 'column' },
  { label: 'eventType', type: 'property', detail: 'column' },
  { label: 'externalId', type: 'property', detail: 'column' },
  { label: 'occurredAt', type: 'property', detail: 'column' },
  { label: 'receivedAt', type: 'property', detail: 'column' },
  { label: 'payload.sender.login', type: 'property', detail: 'GitHub sender' },
  { label: 'payload.repository.full_name', type: 'property', detail: 'GitHub repo' },
  { label: 'payload.action', type: 'property', detail: 'event action' },
  { label: 'payload.errorCode', type: 'property', detail: 'AWS error code' },
  { label: 'payload.sourceIPAddress', type: 'property', detail: 'AWS source IP' },
  { label: 'payload.eventName', type: 'property', detail: 'AWS event name' },
  { label: 'payload.contractAddress', type: 'property', detail: 'chain contract' },
  { label: 'payload.transactionHash', type: 'property', detail: 'chain tx hash' },
  { label: 'payload.resourceId', type: 'property', detail: 'resource ID' },
  { label: 'payload.hostname', type: 'property', detail: 'infra hostname' },
  { label: 'payload.artifact', type: 'property', detail: 'registry artifact' },
  { label: 'payload.networkSlug', type: 'property', detail: 'chain network' },
  { label: 'payload.eventArgs.from', type: 'property', detail: 'chain from addr' },
  { label: 'payload.eventArgs.to', type: 'property', detail: 'chain to addr' },
  { label: 'payload.userIdentity.arn', type: 'property', detail: 'AWS user ARN' },
  { label: 'payload.awsRegion', type: 'property', detail: 'AWS region' },
];

const ALERT_FIELDS: Completion[] = [
  { label: 'severity', type: 'property', detail: 'column' },
  { label: 'title', type: 'property', detail: 'column' },
  { label: 'description', type: 'property', detail: 'column' },
  { label: 'triggerType', type: 'property', detail: 'column' },
  { label: 'notificationStatus', type: 'property', detail: 'column' },
  { label: 'detectionId', type: 'property', detail: 'column' },
  { label: 'eventId', type: 'property', detail: 'column' },
  { label: 'triggerData.ruleType', type: 'property', detail: 'trigger data' },
  { label: 'triggerData.module', type: 'property', detail: 'trigger data' },
  { label: 'triggerData.correlationType', type: 'property', detail: 'correlation' },
  { label: 'triggerData.eventName', type: 'property', detail: 'event name' },
  { label: 'triggerData.sourceIPAddress', type: 'property', detail: 'source IP' },
  { label: 'triggerData.contractAddress', type: 'property', detail: 'contract' },
  { label: 'triggerData.hostname', type: 'property', detail: 'hostname' },
  { label: 'triggerData.artifact', type: 'property', detail: 'artifact' },
];

const KEYWORDS: Completion[] = [
  { label: 'WHERE', type: 'keyword' },
  { label: 'AND', type: 'keyword' },
  { label: 'OR', type: 'keyword' },
  { label: 'SINCE', type: 'keyword' },
  { label: 'LIMIT', type: 'keyword' },
  { label: 'ORDER BY', type: 'keyword' },
  { label: 'ASC', type: 'keyword' },
  { label: 'DESC', type: 'keyword' },
  { label: 'GROUP BY', type: 'keyword' },
  { label: 'IN', type: 'keyword' },
  { label: 'EXISTS', type: 'keyword' },
  { label: 'NOT_EXISTS', type: 'keyword' },
  { label: 'CONTAINS', type: 'keyword' },
  { label: 'NOT_CONTAINS', type: 'keyword' },
];

const COLLECTIONS: Completion[] = [
  { label: 'events', type: 'type', detail: 'collection' },
  { label: 'alerts', type: 'type', detail: 'collection' },
];

const OPERATORS: Completion[] = [
  { label: '=', type: 'operator', detail: 'equals' },
  { label: '!=', type: 'operator', detail: 'not equals' },
  { label: '>', type: 'operator', detail: 'greater than' },
  { label: '<', type: 'operator', detail: 'less than' },
  { label: '>=', type: 'operator', detail: 'greater or equal' },
  { label: '<=', type: 'operator', detail: 'less or equal' },
  { label: 'CONTAINS', type: 'operator', detail: 'substring match' },
  { label: 'NOT_CONTAINS', type: 'operator', detail: 'no substring' },
  { label: 'IN', type: 'operator', detail: 'in set' },
  { label: 'EXISTS', type: 'operator', detail: 'is not null' },
  { label: 'NOT_EXISTS', type: 'operator', detail: 'is null' },
];

const DURATION_PRESETS: Completion[] = [
  { label: '1h', type: 'constant', detail: '1 hour' },
  { label: '6h', type: 'constant', detail: '6 hours' },
  { label: '24h', type: 'constant', detail: '24 hours' },
  { label: '7d', type: 'constant', detail: '7 days' },
  { label: '30d', type: 'constant', detail: '30 days' },
];

const VALUE_SUGGESTIONS: Record<string, Completion[]> = {
  moduleId: [
    { label: '"github"', type: 'text', detail: 'module' },
    { label: '"aws"', type: 'text', detail: 'module' },
    { label: '"chain"', type: 'text', detail: 'module' },
    { label: '"infra"', type: 'text', detail: 'module' },
    { label: '"registry"', type: 'text', detail: 'module' },
  ],
  severity: [
    { label: '"critical"', type: 'text', detail: 'severity' },
    { label: '"high"', type: 'text', detail: 'severity' },
    { label: '"medium"', type: 'text', detail: 'severity' },
    { label: '"low"', type: 'text', detail: 'severity' },
  ],
  triggerType: [
    { label: '"immediate"', type: 'text', detail: 'trigger type' },
    { label: '"windowed"', type: 'text', detail: 'trigger type' },
    { label: '"correlated"', type: 'text', detail: 'trigger type' },
    { label: '"deferred"', type: 'text', detail: 'trigger type' },
  ],
  notificationStatus: [
    { label: '"pending"', type: 'text', detail: 'status' },
    { label: '"sent"', type: 'text', detail: 'status' },
    { label: '"failed"', type: 'text', detail: 'status' },
  ],
};

// ---------------------------------------------------------------------------
// Context detection
// ---------------------------------------------------------------------------

function getContext(text: string): 'start' | 'after_collection' | 'field' | 'operator' | 'value' | 'after_clause' | 'since' | 'limit' {
  const trimmed = text.trimEnd();
  const upper = trimmed.toUpperCase();

  if (!trimmed || /^\s*$/.test(trimmed)) return 'start';
  if (/SINCE\s*$/i.test(upper)) return 'since';
  if (/LIMIT\s*$/i.test(upper)) return 'limit';

  // After a value (string, number, EXISTS, NOT_EXISTS) → expect AND/OR/SINCE/LIMIT
  if (/"\s*$/.test(trimmed) || /\d+[hdms]?\s*$/.test(trimmed) || /EXISTS\s*$/i.test(upper) || /NOT_EXISTS\s*$/i.test(upper) || /\)\s*$/.test(trimmed)) {
    return 'after_clause';
  }

  // After operator → expect value
  if (/(?:=|!=|>=?|<=?|CONTAINS|NOT_CONTAINS|IN)\s*$/i.test(upper)) return 'value';

  // After WHERE/AND/OR → expect field
  if (/(?:WHERE|AND|OR)\s*$/i.test(upper)) return 'field';

  // After collection name → expect WHERE
  if (/^(?:events|alerts)\s*$/i.test(trimmed)) return 'after_collection';

  // If we have a word that looks like a field name (no operator yet on this clause)
  const lastLine = trimmed.split(/(?:WHERE|AND|OR)/i).pop()?.trim() ?? '';
  if (lastLine && !lastLine.includes('=') && !lastLine.includes('>') && !lastLine.includes('<') && !/CONTAINS|IN|EXISTS/i.test(lastLine)) {
    // Still typing a field name, or need an operator
    if (/\s$/.test(text)) return 'operator';
    return 'field';
  }

  return 'after_clause';
}

function getCollection(text: string): 'events' | 'alerts' {
  const match = text.match(/^\s*(events|alerts)/i);
  return (match?.[1]?.toLowerCase() as 'events' | 'alerts') ?? 'events';
}

function getLastField(text: string): string | null {
  // Find the last field name before the operator
  const match = text.match(/([a-zA-Z_][a-zA-Z0-9_.]*)\s*(?:=|!=|>=?|<=?|CONTAINS|NOT_CONTAINS|IN)\s*$/i);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Completion provider
// ---------------------------------------------------------------------------

export function sentinelCompletions(context: CompletionContext): CompletionResult | null {
  const before = context.state.doc.sliceString(0, context.pos);
  const wordMatch = context.matchBefore(/[a-zA-Z0-9_."]*$/);

  if (!wordMatch && !context.explicit) return null;

  const from = wordMatch?.from ?? context.pos;
  const ctx = getContext(before);
  const collection = getCollection(before);

  let options: Completion[];

  switch (ctx) {
    case 'start':
      options = COLLECTIONS;
      break;
    case 'after_collection':
      options = [{ label: 'WHERE', type: 'keyword' }];
      break;
    case 'field':
      options = collection === 'events' ? EVENT_FIELDS : ALERT_FIELDS;
      break;
    case 'operator':
      options = OPERATORS;
      break;
    case 'value': {
      const lastField = getLastField(before);
      if (lastField && VALUE_SUGGESTIONS[lastField]) {
        options = VALUE_SUGGESTIONS[lastField];
      } else {
        options = [
          { label: '""', type: 'text', detail: 'string value', apply: (view, _c, from, to) => {
            view.dispatch({ changes: { from, to, insert: '""' }, selection: { anchor: from + 1 } });
          }},
        ];
      }
      break;
    }
    case 'since':
      options = DURATION_PRESETS;
      break;
    case 'limit':
      options = [
        { label: '10', type: 'constant' },
        { label: '25', type: 'constant' },
        { label: '50', type: 'constant' },
        { label: '100', type: 'constant' },
      ];
      break;
    case 'after_clause':
      options = KEYWORDS.filter(k => ['AND', 'OR', 'SINCE', 'LIMIT', 'ORDER BY', 'GROUP BY'].includes(k.label));
      break;
    default:
      options = [...KEYWORDS, ...(collection === 'events' ? EVENT_FIELDS : ALERT_FIELDS)];
  }

  return { from, options, validFor: /^[a-zA-Z0-9_."]*$/ };
}
