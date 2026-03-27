import { describe, it, expect } from 'vitest';
import { getField, compare, evaluateConditions, type Condition } from '../conditions.js';

// ===========================================================================
// getField — dotted path resolution
// ===========================================================================

describe('getField', () => {
  it('resolves a top-level field', () => {
    expect(getField({ name: 'alice' }, 'name')).toBe('alice');
  });

  it('resolves a nested dotted path', () => {
    expect(getField({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined for missing top-level field', () => {
    expect(getField({ name: 'alice' }, 'age')).toBeUndefined();
  });

  it('returns undefined for missing nested field', () => {
    expect(getField({ a: { b: 1 } }, 'a.c.d')).toBeUndefined();
  });

  it('returns undefined when traversing through null', () => {
    expect(getField({ a: null } as any, 'a.b')).toBeUndefined();
  });

  it('returns undefined when traversing through a primitive', () => {
    expect(getField({ a: 42 } as any, 'a.b')).toBeUndefined();
  });

  it('handles empty path segments (single key)', () => {
    expect(getField({ '': 'empty' }, '')).toBe('empty');
  });
});

// ===========================================================================
// compare — operator tests
// ===========================================================================

describe('compare', () => {
  describe('== operator', () => {
    it('returns true for equal strings', () => {
      expect(compare('hello', '==', 'hello')).toBe(true);
    });

    it('returns false for different strings', () => {
      expect(compare('hello', '==', 'world')).toBe(false);
    });

    it('returns true for equal numbers', () => {
      expect(compare(42, '==', 42)).toBe(true);
    });

    it('returns false for different numbers', () => {
      expect(compare(42, '==', 43)).toBe(false);
    });
  });

  describe('!= operator', () => {
    it('returns true for different values', () => {
      expect(compare('hello', '!=', 'world')).toBe(true);
    });

    it('returns false for equal values', () => {
      expect(compare('hello', '!=', 'hello')).toBe(false);
    });

    it('works with numbers', () => {
      expect(compare(1, '!=', 2)).toBe(true);
      expect(compare(1, '!=', 1)).toBe(false);
    });
  });

  describe('> operator', () => {
    it('returns true when actual > expected (numbers)', () => {
      expect(compare(10, '>', 5)).toBe(true);
    });

    it('returns false when actual <= expected (numbers)', () => {
      expect(compare(5, '>', 10)).toBe(false);
      expect(compare(5, '>', 5)).toBe(false);
    });

    it('works with string comparison', () => {
      expect(compare('b', '>', 'a')).toBe(true);
      expect(compare('a', '>', 'b')).toBe(false);
    });
  });

  describe('< operator', () => {
    it('returns true when actual < expected (numbers)', () => {
      expect(compare(5, '<', 10)).toBe(true);
    });

    it('returns false when actual >= expected', () => {
      expect(compare(10, '<', 5)).toBe(false);
      expect(compare(5, '<', 5)).toBe(false);
    });
  });

  describe('>= operator', () => {
    it('returns true when actual >= expected', () => {
      expect(compare(10, '>=', 5)).toBe(true);
      expect(compare(5, '>=', 5)).toBe(true);
    });

    it('returns false when actual < expected', () => {
      expect(compare(4, '>=', 5)).toBe(false);
    });
  });

  describe('<= operator', () => {
    it('returns true when actual <= expected', () => {
      expect(compare(5, '<=', 10)).toBe(true);
      expect(compare(5, '<=', 5)).toBe(true);
    });

    it('returns false when actual > expected', () => {
      expect(compare(6, '<=', 5)).toBe(false);
    });
  });

  describe('BigInt comparison', () => {
    it('compares bigints with == operator', () => {
      expect(compare(BigInt(100), '==', BigInt(100))).toBe(true);
      expect(compare(BigInt(100), '==', BigInt(200))).toBe(false);
    });

    it('compares bigints with > operator', () => {
      expect(compare(BigInt(200), '>', BigInt(100))).toBe(true);
      expect(compare(BigInt(50), '>', BigInt(100))).toBe(false);
    });

    it('compares bigints with < operator', () => {
      expect(compare(BigInt(50), '<', BigInt(100))).toBe(true);
    });

    it('compares bigints with >= and <= operators', () => {
      expect(compare(BigInt(100), '>=', BigInt(100))).toBe(true);
      expect(compare(BigInt(100), '<=', BigInt(100))).toBe(true);
    });

    it('compares bigint with != operator', () => {
      expect(compare(BigInt(100), '!=', BigInt(200))).toBe(true);
      expect(compare(BigInt(100), '!=', BigInt(100))).toBe(false);
    });

    it('coerces number to bigint for comparison when one is bigint', () => {
      expect(compare(BigInt(100), '==', 100)).toBe(true);
      expect(compare(100, '==', BigInt(100))).toBe(true);
      expect(compare(BigInt(200), '>', 100)).toBe(true);
    });

    it('coerces both numbers to bigint for numeric comparison', () => {
      expect(compare(10, '>', 5)).toBe(true);
      expect(compare(5, '<', 10)).toBe(true);
    });
  });
});

// ===========================================================================
// evaluateConditions — AND logic
// ===========================================================================

describe('evaluateConditions', () => {
  it('returns true for empty conditions list', () => {
    expect(evaluateConditions({ foo: 'bar' }, [])).toBe(true);
  });

  it('evaluates single condition — match', () => {
    const conditions: Condition[] = [
      { field: 'action', operator: '==', value: 'publicized' },
    ];
    expect(
      evaluateConditions({ action: 'publicized' }, conditions),
    ).toBe(true);
  });

  it('evaluates single condition — no match', () => {
    const conditions: Condition[] = [
      { field: 'action', operator: '==', value: 'privatized' },
    ];
    expect(
      evaluateConditions({ action: 'publicized' }, conditions),
    ).toBe(false);
  });

  it('evaluates multiple conditions with AND logic — all pass', () => {
    const conditions: Condition[] = [
      { field: 'action', operator: '==', value: 'created' },
      { field: 'severity', operator: '!=', value: 'low' },
      { field: 'count', operator: '>', value: 5 },
    ];
    expect(
      evaluateConditions({ action: 'created', severity: 'high', count: 10 }, conditions),
    ).toBe(true);
  });

  it('evaluates multiple conditions with AND logic — one fails', () => {
    const conditions: Condition[] = [
      { field: 'action', operator: '==', value: 'created' },
      { field: 'count', operator: '>', value: 100 },
    ];
    expect(
      evaluateConditions({ action: 'created', count: 10 }, conditions),
    ).toBe(false);
  });

  it('returns false when field is missing from payload', () => {
    const conditions: Condition[] = [
      { field: 'nonexistent', operator: '==', value: 'anything' },
    ];
    expect(
      evaluateConditions({ action: 'created' }, conditions),
    ).toBe(false);
  });

  it('uses dotted field paths', () => {
    const conditions: Condition[] = [
      { field: 'repository.full_name', operator: '==', value: 'acme/core' },
    ];
    expect(
      evaluateConditions(
        { repository: { full_name: 'acme/core' } },
        conditions,
      ),
    ).toBe(true);
  });

  it('returns false when dotted path leads to missing field', () => {
    const conditions: Condition[] = [
      { field: 'repository.owner.login', operator: '==', value: 'acme' },
    ];
    expect(
      evaluateConditions({ repository: { full_name: 'acme/core' } }, conditions),
    ).toBe(false);
  });

  it('handles deeply nested dotted paths', () => {
    const conditions: Condition[] = [
      { field: 'a.b.c.d', operator: '==', value: 'deep' },
    ];
    expect(
      evaluateConditions({ a: { b: { c: { d: 'deep' } } } }, conditions),
    ).toBe(true);
  });

  it('works with numeric comparison operators on nested fields', () => {
    const conditions: Condition[] = [
      { field: 'stats.count', operator: '>=', value: 100 },
      { field: 'stats.errorRate', operator: '<', value: 5 },
    ];
    expect(
      evaluateConditions(
        { stats: { count: 150, errorRate: 2 } },
        conditions,
      ),
    ).toBe(true);
  });

  it('handles BigInt values in conditions', () => {
    const conditions: Condition[] = [
      { field: 'blockNumber', operator: '>', value: BigInt(1000000) },
    ];
    expect(
      evaluateConditions({ blockNumber: BigInt(1500000) }, conditions),
    ).toBe(true);
  });
});
