"use client";

import type { QueryState } from "./types";
import { buildSqlPreview } from "./utils";

interface QueryPreviewProps {
  state: QueryState;
}

export function QueryPreview({ state }: QueryPreviewProps) {
  const sql = buildSqlPreview(state);

  return (
    <div className="border border-border bg-muted/10 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground font-mono">$ cat query.sql</span>
        <button type="button" onClick={() => navigator.clipboard.writeText(sql)} className="text-xs text-muted-foreground hover:text-primary transition-colors">
          [copy]
        </button>
      </div>
      <pre className="text-xs text-foreground font-mono overflow-x-auto whitespace-pre-wrap">{sql}</pre>
    </div>
  );
}
