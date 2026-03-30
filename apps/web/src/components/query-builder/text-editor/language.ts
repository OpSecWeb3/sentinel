/**
 * Sentinel Query Language (SQL-like) definition for CodeMirror.
 *
 * Grammar:
 *   <collection> WHERE <clause> [AND|OR <clause>]* [SINCE <duration>] [LIMIT <n>]
 *
 * Clause:
 *   <field> <operator> <value>
 *   <field> EXISTS | NOT_EXISTS
 *   <field> IN (<value>, ...)
 *
 * Examples:
 *   events WHERE moduleId = "github" AND payload.sender.login = "octocat" SINCE 24h LIMIT 25
 *   alerts WHERE severity = "critical" OR notificationStatus IN ("pending", "failed") SINCE 7d
 */

import { StreamLanguage, type StreamParser } from '@codemirror/language';

const KEYWORDS = new Set([
  'WHERE', 'AND', 'OR', 'SINCE', 'LIMIT', 'ORDER', 'BY', 'ASC', 'DESC',
  'IN', 'EXISTS', 'NOT_EXISTS', 'GROUP',
]);

const COLLECTIONS = new Set(['events', 'alerts']);

const OPERATORS = new Set(['=', '!=', '>', '<', '>=', '<=', 'CONTAINS', 'NOT_CONTAINS']);

interface SentinelState {
  inString: boolean;
  stringChar: string;
}

const sentinelParser: StreamParser<SentinelState> = {
  startState(): SentinelState {
    return { inString: false, stringChar: '' };
  },

  token(stream, state): string | null {
    // Continue string
    if (state.inString) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === state.stringChar) {
          state.inString = false;
          return 'string';
        }
        if (ch === '\\') stream.next(); // escape
      }
      return 'string';
    }

    // Skip whitespace
    if (stream.eatSpace()) return null;

    // Comments (-- to end of line)
    if (stream.match('--')) {
      stream.skipToEnd();
      return 'comment';
    }

    // Strings
    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      state.inString = true;
      state.stringChar = ch;
      stream.next();
      return 'string';
    }

    // Numbers
    if (stream.match(/^\d+(\.\d+)?/)) {
      return 'number';
    }

    // Parentheses
    if (ch === '(' || ch === ')') {
      stream.next();
      return 'bracket';
    }

    // Comma
    if (ch === ',') {
      stream.next();
      return 'punctuation';
    }

    // Multi-char operators
    if (stream.match('!=') || stream.match('>=') || stream.match('<=')) {
      return 'operator';
    }

    // Single-char operators
    if (ch === '=' || ch === '>' || ch === '<') {
      stream.next();
      return 'operator';
    }

    // Words
    if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_.]*/, true)) {
      const word = stream.current();
      const upper = word.toUpperCase();

      if (COLLECTIONS.has(word.toLowerCase())) return 'typeName';
      if (KEYWORDS.has(upper)) return 'keyword';
      if (OPERATORS.has(upper)) return 'operator';

      // Duration literals like 1h, 24h, 7d, 30d
      if (/^\d+[hdms]$/i.test(word)) return 'number';

      // Field paths (contain dots or known column names)
      return 'variableName';
    }

    // Skip unknown
    stream.next();
    return null;
  },
};

export const sentinelLanguage = StreamLanguage.define(sentinelParser);
