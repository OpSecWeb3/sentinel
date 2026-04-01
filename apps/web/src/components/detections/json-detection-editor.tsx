"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { bracketMatching, foldGutter } from "@codemirror/language";
import { sentinelTheme } from "@/components/query-builder/text-editor/theme";

export interface JsonDetectionEditorHandle {
  updateContent: (json: string) => void;
}

interface JsonDetectionEditorProps {
  initialValue: string;
  onChange: (json: string) => void;
  readOnly?: boolean;
}

export const JsonDetectionEditor = forwardRef<
  JsonDetectionEditorHandle,
  JsonDetectionEditorProps
>(function JsonDetectionEditor({ initialValue, onChange, readOnly }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [parseError, setParseError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    updateContent(newJson: string) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: newJson },
      });
    },
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        json(),
        sentinelTheme,
        history(),
        lineNumbers(),
        bracketMatching(),
        foldGutter(),
        EditorView.lineWrapping,
        keymap.of(historyKeymap),
        EditorState.readOnly.of(!!readOnly),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          onChangeRef.current(text);
          try {
            JSON.parse(text);
            setParseError(null);
          } catch (err) {
            setParseError(
              err instanceof SyntaxError ? err.message : "Invalid JSON",
            );
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  return (
    <div className="space-y-0">
      <div className="flex items-center justify-between border border-b-0 border-border bg-muted/10 px-3 py-1.5 rounded-t-sm">
        <span className="text-[10px] text-muted-foreground font-mono">
          detection.json
        </span>
        {readOnly && (
          <span className="text-[10px] text-muted-foreground/60">
            read-only
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        className="border border-border bg-muted/10 rounded-b-sm min-h-[200px] max-h-[500px] overflow-auto"
      />
      {parseError && (
        <p className="text-[10px] font-mono text-destructive mt-1 px-1">
          [ERR] {parseError}
        </p>
      )}
    </div>
  );
});
