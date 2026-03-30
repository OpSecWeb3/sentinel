/**
 * Syntax highlighting colors for the Sentinel language.
 */

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const sentinelHighlightStyle = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: 'hsl(var(--primary))' },
  { tag: tags.typeName, color: '#c792ea', fontWeight: '600' },
  { tag: tags.variableName, color: '#82aaff' },
  { tag: tags.string, color: '#c3e88d' },
  { tag: tags.number, color: '#f78c6c' },
  { tag: tags.operator, color: '#89ddff' },
  { tag: tags.bracket, color: 'hsl(var(--muted-foreground))' },
  { tag: tags.punctuation, color: 'hsl(var(--muted-foreground))' },
  { tag: tags.comment, color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' },
]));
