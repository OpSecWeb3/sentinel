import { describe, it, expect } from 'vitest';
import {
  queryStateSchema,
  isTopLevelColumn,
  isPayloadPath,
  EVENT_COLUMNS,
  ALERT_COLUMNS,
} from '../query.js';

// ===========================================================================
// isTopLevelColumn
// ===========================================================================

describe('isTopLevelColumn', () => {
  it('identifies event column names', () => {
    for (const col of EVENT_COLUMNS) {
      expect(isTopLevelColumn('events', col)).toBe(true);
    }
  });

  it('identifies alert column names', () => {
    for (const col of ALERT_COLUMNS) {
      expect(isTopLevelColumn('alerts', col)).toBe(true);
    }
  });

  it('returns false for payload paths', () => {
    expect(isTopLevelColumn('events', 'payload.sender.login')).toBe(false);
  });

  it('returns false for unknown field', () => {
    expect(isTopLevelColumn('events', 'nonexistent')).toBe(false);
  });

  it('does not cross-match event columns to alerts', () => {
    expect(isTopLevelColumn('alerts', 'moduleId')).toBe(false);
    expect(isTopLevelColumn('alerts', 'eventType')).toBe(false);
  });

  it('does not cross-match alert columns to events', () => {
    expect(isTopLevelColumn('events', 'severity')).toBe(false);
    expect(isTopLevelColumn('events', 'notificationStatus')).toBe(false);
  });
});

// ===========================================================================
// isPayloadPath
// ===========================================================================

describe('isPayloadPath', () => {
  it('returns true for payload-prefixed paths', () => {
    expect(isPayloadPath('payload.sender.login')).toBe(true);
    expect(isPayloadPath('payload.errorCode')).toBe(true);
  });

  it('returns false for non-payload paths', () => {
    expect(isPayloadPath('moduleId')).toBe(false);
    expect(isPayloadPath('triggerData.ruleType')).toBe(false);
  });
});

// ===========================================================================
// queryStateSchema — Zod validation
// ===========================================================================

describe('queryStateSchema', () => {
  const validState = {
    collection: 'events',
    groups: [{
      id: 'g1',
      logic: 'AND',
      clauses: [{ id: 'c1', field: 'moduleId', operator: 'eq', value: 'github' }],
    }],
    timeRange: { from: null, to: null },
    aggregation: null,
    orderBy: null,
    limit: 25,
    page: 1,
  };

  it('accepts a valid events query', () => {
    const result = queryStateSchema.safeParse(validState);
    expect(result.success).toBe(true);
  });

  it('accepts a valid alerts query', () => {
    const result = queryStateSchema.safeParse({ ...validState, collection: 'alerts' });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid collection', () => {
    const result = queryStateSchema.safeParse({ ...validState, collection: 'users' });
    expect(result.success).toBe(false);
  });

  it('rejects empty groups', () => {
    const result = queryStateSchema.safeParse({ ...validState, groups: [] });
    expect(result.success).toBe(false);
  });

  it('rejects empty clauses within a group', () => {
    const result = queryStateSchema.safeParse({
      ...validState,
      groups: [{ id: 'g1', logic: 'AND', clauses: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects field paths with invalid characters', () => {
    const result = queryStateSchema.safeParse({
      ...validState,
      groups: [{
        id: 'g1',
        logic: 'AND',
        clauses: [{ id: 'c1', field: 'payload; DROP TABLE', operator: 'eq', value: 'x' }],
      }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts dotted field paths', () => {
    const result = queryStateSchema.safeParse({
      ...validState,
      groups: [{
        id: 'g1',
        logic: 'AND',
        clauses: [{ id: 'c1', field: 'payload.sender.login', operator: 'eq', value: 'octocat' }],
      }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts IN operator with array value', () => {
    const result = queryStateSchema.safeParse({
      ...validState,
      groups: [{
        id: 'g1',
        logic: 'AND',
        clauses: [{ id: 'c1', field: 'moduleId', operator: 'in', value: ['github', 'aws'] }],
      }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts OR logic', () => {
    const result = queryStateSchema.safeParse({
      ...validState,
      groups: [{ ...validState.groups[0], logic: 'OR' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects limit above 100', () => {
    const result = queryStateSchema.safeParse({ ...validState, limit: 200 });
    expect(result.success).toBe(false);
  });

  it('accepts aggregation', () => {
    const result = queryStateSchema.safeParse({
      ...validState,
      aggregation: { fn: 'count', groupBy: ['moduleId'] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects aggregation with empty groupBy', () => {
    const result = queryStateSchema.safeParse({
      ...validState,
      aggregation: { fn: 'count', groupBy: [] },
    });
    expect(result.success).toBe(false);
  });

  it('accepts orderBy', () => {
    const result = queryStateSchema.safeParse({
      ...validState,
      orderBy: { field: 'receivedAt', dir: 'desc' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid operator', () => {
    const result = queryStateSchema.safeParse({
      ...validState,
      groups: [{
        id: 'g1',
        logic: 'AND',
        clauses: [{ id: 'c1', field: 'moduleId', operator: 'LIKE', value: '%github%' }],
      }],
    });
    expect(result.success).toBe(false);
  });
});
