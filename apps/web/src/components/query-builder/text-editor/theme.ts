/**
 * Terminal-style CodeMirror theme matching Sentinel's dark aesthetic.
 */

import { EditorView } from '@codemirror/view';

export const sentinelTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'hsl(var(--foreground))',
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '13px',
    lineHeight: '1.6',
  },
  '.cm-content': {
    caretColor: 'hsl(var(--primary))',
    padding: '8px 0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'hsl(var(--primary))',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'hsl(var(--primary) / 0.15)',
  },
  '.cm-activeLine': {
    backgroundColor: 'hsl(var(--muted) / 0.2)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: '1px solid hsl(var(--border))',
    color: 'hsl(var(--muted-foreground))',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'hsl(var(--primary))',
  },
  // Autocomplete tooltip
  '.cm-tooltip': {
    backgroundColor: 'hsl(var(--popover))',
    border: '1px solid hsl(var(--border))',
    borderRadius: '6px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: '12px',
  },
  '.cm-tooltip-autocomplete ul li': {
    padding: '4px 8px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'hsl(var(--accent))',
    color: 'hsl(var(--accent-foreground))',
  },
  '.cm-completionLabel': {
    color: 'hsl(var(--foreground))',
  },
  '.cm-completionDetail': {
    color: 'hsl(var(--muted-foreground))',
    fontStyle: 'normal',
    marginLeft: '8px',
  },
  '.cm-completionMatchedText': {
    color: 'hsl(var(--primary))',
    textDecoration: 'none',
    fontWeight: '600',
  },
  // Placeholder
  '.cm-placeholder': {
    color: 'hsl(var(--muted-foreground))',
    fontStyle: 'italic',
  },
});
