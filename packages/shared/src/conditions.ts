/**
 * Condition evaluation — shared operators for rule configs.
 * Ported from ChainAlert's condition evaluation patterns.
 */

export type Operator = '==' | '!=' | '>' | '<' | '>=' | '<=';

export interface Condition {
  field: string;
  operator: Operator;
  value?: unknown;
}

/**
 * Resolve a dotted field path from an object.
 * e.g. getField({ a: { b: 1 } }, 'a.b') => 1
 */
export function getField(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Compare two values with the given operator.
 * Handles string, number, and bigint comparisons.
 */
export function compare(actual: unknown, operator: Operator, expected: unknown): boolean {
  // Safe BigInt coercion — only convert finite integers; leave floats/NaN/Infinity as numbers
  const toBigIntSafe = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) return BigInt(v);
    return v;
  };

  const a = toBigIntSafe(actual);
  const b = toBigIntSafe(expected);

  // Numeric comparison if both are bigints
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    switch (operator) {
      case '==': return a === b;
      case '!=': return a !== b;
      case '>':  return a > b;
      case '<':  return a < b;
      case '>=': return a >= b;
      case '<=': return a <= b;
    }
  }

  // Numeric comparison if both are finite numbers (handles floats, NaN-safe)
  if (typeof a === 'number' && typeof b === 'number') {
    // NaN comparisons always return false for relational ops, != returns true
    switch (operator) {
      case '==': return a === b;
      case '!=': return a !== b;
      case '>':  return a > b;
      case '<':  return a < b;
      case '>=': return a >= b;
      case '<=': return a <= b;
    }
  }

  // Try numeric comparison when one or both operands are numeric strings
  const na = typeof a === 'number' ? a : typeof a === 'string' ? Number(a) : NaN;
  const nb = typeof b === 'number' ? b : typeof b === 'string' ? Number(b) : NaN;
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    switch (operator) {
      case '==': return na === nb;
      case '!=': return na !== nb;
      case '>':  return na > nb;
      case '<':  return na < nb;
      case '>=': return na >= nb;
      case '<=': return na <= nb;
    }
  }

  // String/general comparison
  const sa = String(a);
  const sb = String(b);
  switch (operator) {
    case '==': return sa === sb;
    case '!=': return sa !== sb;
    case '>':  return sa > sb;
    case '<':  return sa < sb;
    case '>=': return sa >= sb;
    case '<=': return sa <= sb;
  }
}

/**
 * Evaluate all conditions against a payload. All must pass (AND logic).
 */
export function evaluateConditions(
  payload: Record<string, unknown>,
  conditions: Condition[],
): boolean {
  if (conditions.length === 0) return true;
  return conditions.every((c) => {
    const actual = getField(payload, c.field);
    if (actual === undefined) return false;
    return compare(actual, c.operator, c.value);
  });
}
