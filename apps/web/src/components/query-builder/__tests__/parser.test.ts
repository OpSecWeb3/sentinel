import { describe, it, expect } from 'vitest';
import { parseQuery, serializeToText } from '../text-editor/parser';

// ===========================================================================
// parseQuery — text to QueryState
// ===========================================================================

describe('parseQuery', () => {
  it('parses a simple events query', () => {
    const result = parseQuery('events WHERE moduleId = "github"');
    expect(result).not.toBeNull();
    expect(result!.collection).toBe('events');
    expect(result!.groups).toHaveLength(1);
    expect(result!.groups[0].clauses).toHaveLength(1);
    expect(result!.groups[0].clauses[0].field).toBe('moduleId');
    expect(result!.groups[0].clauses[0].operator).toBe('eq');
    expect(result!.groups[0].clauses[0].value).toBe('github');
  });

  it('parses alerts collection', () => {
    const result = parseQuery('alerts WHERE severity = "critical"');
    expect(result).not.toBeNull();
    expect(result!.collection).toBe('alerts');
  });

  it('parses AND clauses', () => {
    const result = parseQuery('events WHERE moduleId = "aws" AND payload.errorCode EXISTS');
    expect(result).not.toBeNull();
    expect(result!.groups[0].logic).toBe('AND');
    expect(result!.groups[0].clauses).toHaveLength(2);
    expect(result!.groups[0].clauses[1].field).toBe('payload.errorCode');
    expect(result!.groups[0].clauses[1].operator).toBe('exists');
  });

  it('parses OR clauses', () => {
    const result = parseQuery('alerts WHERE severity = "critical" OR severity = "high"');
    expect(result).not.toBeNull();
    expect(result!.groups[0].logic).toBe('OR');
    expect(result!.groups[0].clauses).toHaveLength(2);
  });

  it('parses != operator', () => {
    const result = parseQuery('events WHERE moduleId != "infra"');
    expect(result!.groups[0].clauses[0].operator).toBe('neq');
  });

  it('parses > operator', () => {
    const result = parseQuery('events WHERE payload.count > "10"');
    expect(result!.groups[0].clauses[0].operator).toBe('gt');
  });

  it('parses >= operator', () => {
    const result = parseQuery('events WHERE payload.count >= "5"');
    expect(result!.groups[0].clauses[0].operator).toBe('gte');
  });

  it('parses < operator', () => {
    const result = parseQuery('events WHERE payload.count < "100"');
    expect(result!.groups[0].clauses[0].operator).toBe('lt');
  });

  it('parses <= operator', () => {
    const result = parseQuery('events WHERE payload.count <= "50"');
    expect(result!.groups[0].clauses[0].operator).toBe('lte');
  });

  it('parses CONTAINS operator', () => {
    const result = parseQuery('events WHERE payload.action CONTAINS "delete"');
    expect(result!.groups[0].clauses[0].operator).toBe('contains');
    expect(result!.groups[0].clauses[0].value).toBe('delete');
  });

  it('parses NOT_CONTAINS operator', () => {
    const result = parseQuery('events WHERE payload.action NOT_CONTAINS "test"');
    expect(result!.groups[0].clauses[0].operator).toBe('not_contains');
  });

  it('parses EXISTS operator (no value)', () => {
    const result = parseQuery('events WHERE payload.errorCode EXISTS');
    expect(result!.groups[0].clauses[0].operator).toBe('exists');
    expect(result!.groups[0].clauses[0].value).toBe('');
  });

  it('parses NOT_EXISTS operator', () => {
    const result = parseQuery('events WHERE payload.errorCode NOT_EXISTS');
    expect(result!.groups[0].clauses[0].operator).toBe('not_exists');
  });

  it('parses IN operator with parenthesized values', () => {
    const result = parseQuery('events WHERE moduleId IN ("github", "aws", "chain")');
    expect(result!.groups[0].clauses[0].operator).toBe('in');
    expect(result!.groups[0].clauses[0].value).toEqual(['github', 'aws', 'chain']);
  });

  it('parses SINCE duration', () => {
    const result = parseQuery('events WHERE moduleId = "github" SINCE 24h');
    expect(result).not.toBeNull();
    expect(result!.timeRange.from).not.toBeNull();
    // Should be roughly 24 hours ago
    const diff = Date.now() - new Date(result!.timeRange.from!).getTime();
    expect(diff).toBeGreaterThan(23 * 3600_000);
    expect(diff).toBeLessThan(25 * 3600_000);
  });

  it('parses SINCE with day unit', () => {
    const result = parseQuery('events WHERE moduleId = "github" SINCE 7d');
    expect(result!.timeRange.from).not.toBeNull();
    const diff = Date.now() - new Date(result!.timeRange.from!).getTime();
    expect(diff).toBeGreaterThan(6 * 86400_000);
    expect(diff).toBeLessThan(8 * 86400_000);
  });

  it('parses LIMIT', () => {
    const result = parseQuery('events WHERE moduleId = "github" LIMIT 50');
    expect(result!.limit).toBe(50);
  });

  it('caps LIMIT at 100', () => {
    const result = parseQuery('events WHERE moduleId = "github" LIMIT 999');
    expect(result!.limit).toBe(100);
  });

  it('parses SINCE and LIMIT together', () => {
    const result = parseQuery('alerts WHERE severity = "critical" SINCE 7d LIMIT 10');
    expect(result!.timeRange.from).not.toBeNull();
    expect(result!.limit).toBe(10);
  });

  it('parses collection-only (no WHERE)', () => {
    const result = parseQuery('events');
    expect(result).not.toBeNull();
    expect(result!.collection).toBe('events');
    expect(result!.groups).toHaveLength(1);
  });

  it('returns null for empty input', () => {
    expect(parseQuery('')).toBeNull();
    expect(parseQuery('   ')).toBeNull();
  });

  it('returns null for invalid collection', () => {
    expect(parseQuery('users WHERE id = "1"')).toBeNull();
  });

  it('handles dotted payload field paths', () => {
    const result = parseQuery('events WHERE payload.sender.login = "octocat"');
    expect(result!.groups[0].clauses[0].field).toBe('payload.sender.login');
    expect(result!.groups[0].clauses[0].value).toBe('octocat');
  });

  it('handles unquoted numeric values', () => {
    const result = parseQuery('events WHERE payload.count > 10');
    expect(result!.groups[0].clauses[0].value).toBe('10');
  });
});

// ===========================================================================
// serializeToText — QueryState to text
// ===========================================================================

describe('serializeToText', () => {
  it('serializes a simple events query', () => {
    const state = parseQuery('events WHERE moduleId = "github"')!;
    const text = serializeToText(state);
    expect(text).toContain('events');
    expect(text).toContain('WHERE');
    expect(text).toContain('moduleId');
    expect(text).toContain('"github"');
  });

  it('serializes collection-only', () => {
    const text = serializeToText({
      collection: 'alerts',
      groups: [{ id: 'g1', logic: 'AND', clauses: [{ id: 'c1', field: '', operator: 'eq', value: '' }] }],
      timeRange: { from: null, to: null },
      aggregation: null,
      orderBy: null,
      limit: 25,
      page: 1,
    });
    expect(text).toBe('alerts');
  });

  it('serializes EXISTS operator without value', () => {
    const state = parseQuery('events WHERE payload.errorCode EXISTS')!;
    const text = serializeToText(state);
    expect(text).toContain('EXISTS');
    expect(text).not.toContain('""');
  });

  it('serializes IN operator with parenthesized values', () => {
    const state = parseQuery('events WHERE moduleId IN ("github", "aws")')!;
    const text = serializeToText(state);
    expect(text).toContain('IN');
    expect(text).toContain('"github"');
    expect(text).toContain('"aws"');
  });

  it('serializes LIMIT when non-default', () => {
    const state = parseQuery('events WHERE moduleId = "github" LIMIT 10')!;
    const text = serializeToText(state);
    expect(text).toContain('LIMIT 10');
  });

  it('omits LIMIT when default (25)', () => {
    const state = parseQuery('events WHERE moduleId = "github"')!;
    const text = serializeToText(state);
    expect(text).not.toContain('LIMIT');
  });

  it('roundtrips a complex query', () => {
    const original = 'events WHERE moduleId = "github" AND payload.sender.login = "octocat"';
    const state = parseQuery(original)!;
    const text = serializeToText(state);
    const reparsed = parseQuery(text)!;

    expect(reparsed.collection).toBe(state.collection);
    expect(reparsed.groups[0].clauses).toHaveLength(state.groups[0].clauses.length);
    expect(reparsed.groups[0].clauses[0].field).toBe(state.groups[0].clauses[0].field);
    expect(reparsed.groups[0].clauses[1].field).toBe(state.groups[0].clauses[1].field);
  });
});
