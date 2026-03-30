"use client";

import { useRef, useEffect, useCallback } from "react";
import { EditorView, placeholder, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { autocompletion, acceptCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";

import { sentinelLanguage } from "./language";
import { sentinelTheme } from "./theme";
import { sentinelHighlightStyle } from "./highlights";
import { sentinelCompletions } from "./completions";
import { parseQuery, serializeToText } from "./parser";
import type { QueryState } from "../types";

interface QueryTextEditorProps {
  state: QueryState;
  onChange: (state: QueryState) => void;
  onRun: () => void;
}

export function QueryTextEditor({ state, onChange, onRun }: QueryTextEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const suppressSync = useRef(false);

  // Refs to always have the latest callbacks without recreating the editor
  const onRunRef = useRef(onRun);
  const onChangeRef = useRef(onChange);
  onRunRef.current = onRun;
  onChangeRef.current = onChange;

  const handleDocChange = useCallback((text: string) => {
    const parsed = parseQuery(text);
    if (parsed) {
      suppressSync.current = true;
      onChangeRef.current(parsed);
      requestAnimationFrame(() => { suppressSync.current = false; });
    }
  }, []);

  // Initialize editor
  useEffect(() => {
    if (!containerRef.current) return;

    const initialText = serializeToText(state);

    const startState = EditorState.create({
      doc: initialText,
      extensions: [
        sentinelLanguage,
        sentinelTheme,
        sentinelHighlightStyle,
        history(),
        autocompletion({
          override: [sentinelCompletions],
          activateOnTyping: true,
          defaultKeymap: true,
        }),
        placeholder('events WHERE moduleId = "github" SINCE 24h'),
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => { onRunRef.current(); return true; },
          },
          {
            key: 'Tab',
            run: acceptCompletion,
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            handleDocChange(update.state.doc.toString());
          }
        }),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync visual builder → text editor
  useEffect(() => {
    if (!viewRef.current || suppressSync.current) return;

    const newText = serializeToText(state);
    const currentText = viewRef.current.state.doc.toString();

    if (newText !== currentText) {
      viewRef.current.dispatch({
        changes: { from: 0, to: currentText.length, insert: newText },
      });
    }
  }, [state]);

  return (
    <div className="border border-border bg-muted/10 rounded-sm">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
        <span className="text-xs text-muted-foreground font-mono">$ sentinel-query</span>
        <span className="text-xs text-muted-foreground">Tab to complete · Ctrl+Enter to run</span>
      </div>
      <div ref={containerRef} className="min-h-[60px]" />
    </div>
  );
}
