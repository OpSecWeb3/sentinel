"use client";

import type { QueryState } from "./types";
import { QUERY_TEMPLATES } from "./templates";

interface TemplateDrawerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (state: QueryState) => void;
}

export function TemplateDrawer({ open, onClose, onSelect }: TemplateDrawerProps) {
  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-background/60" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-80 border-l border-border bg-background overflow-y-auto">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-mono text-primary">$ templates/</span>
          <button type="button" onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground transition-colors">[x]</button>
        </div>
        <div className="p-4 space-y-3">
          {QUERY_TEMPLATES.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => { onSelect(t.state); onClose(); }}
              className="w-full text-left border border-border p-3 hover:border-primary/50 transition-colors group"
            >
              <div className="flex items-center gap-2">
                <span className="text-primary font-mono text-sm">{t.icon}</span>
                <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">{t.name}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{t.description}</p>
              <span className="text-xs text-muted-foreground/50 font-mono mt-1 inline-block">[{t.state.collection}]</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
