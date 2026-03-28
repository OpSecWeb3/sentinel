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

  // Try numeric comparison when one or both operands are numeric strings.
  // Only treat a string as a number if it is a valid decimal integer or
  // decimal float — hex strings (0x…) must NOT be coerced because fields
  // like blockchain addresses or git SHAs share that prefix and would
  // produce nonsensical numeric comparisons (e.g. "0xff" → 255).
  const isDecimalNumericString = (s: string): boolean =>
    s.trim() !== '' && !/0[xX]/.test(s) && Number.isFinite(Number(s));
  const na = typeof a === 'number' ? a : typeof a === 'string' && isDecimalNumericString(a) ? Number(a) : NaN;
  const nb = typeof b === 'number' ? b : typeof b === 'string' && isDecimalNumericString(b) ? Number(b) : NaN;
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

  // ISO 8601 timestamp comparison — detect strings that look like ISO dates
  // and compare them as Date objects so that ordering is always chronological.
  // Match ISO 8601 dates: either date-only ("2024-01-15") which is unambiguously
  // UTC per the Date.parse spec, or date-time with a mandatory timezone offset
  // ("2024-01-15T12:00:00Z", "2024-01-15T12:00:00+05:30").  Date-time WITHOUT
  // a timezone (e.g. "2024-01-15T12:00:00") is rejected because Date.parse
  // treats it as local time, making comparisons non-deterministic across servers.
  const ISO_8601_RE =
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))?$/;
  const sa = String(a);
  const sb = String(b);
  if (ISO_8601_RE.test(sa) && ISO_8601_RE.test(sb)) {
    const da = Date.parse(sa);
    const db = Date.parse(sb);
    // If either string fails to parse (NaN), fall through to lexicographic.
    if (!Number.isNaN(da) && !Number.isNaN(db)) {
      switch (operator) {
        case '==': return da === db;
        case '!=': return da !== db;
        case '>':  return da > db;
        case '<':  return da < db;
        case '>=': return da >= db;
        case '<=': return da <= db;
      }
    }
  }

  // General string (lexicographic) comparison — last resort.
  //
  // KNOWN LIMITATION: lexicographic ordering is only meaningful for strings
  // whose natural sort order matches character-code order, such as fixed-width
  // identifiers or (as a special case handled above) ISO 8601 timestamps.
  // Notably wrong for:
  //   • Semantic versions  — "1.9.0" > "1.10.0" (correct numerically, wrong lexicographically)
  //   • Human-readable numbers embedded in strings — "item9" vs "item10"
  //   • Mixed-case strings where locale collation matters
  // If these value types need relational operators, callers should normalise
  // them to numbers or use a dedicated comparison function before calling
  // evaluateConditions().
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
    // Allow null through for equality checks (null == null should be true),
    // but reject null for relational operators where comparison is meaningless.
    if (actual === null && c.operator !== '==' && c.operator !== '!=') return false;
    return compare(actual, c.operator, c.value);
  });
}
