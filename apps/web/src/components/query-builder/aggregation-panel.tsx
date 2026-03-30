"use client";

import type { Aggregation } from "./types";

interface AggregationPanelProps {
  aggregation: Aggregation | null;
  collection: string;
  onChange: (agg: Aggregation | null) => void;
}

export function AggregationPanel({ aggregation, collection: _collection, onChange }: AggregationPanelProps) {
  if (!aggregation) {
    return (
      <button type="button" onClick={() => onChange({ fn: 'count', groupBy: ['moduleId'] })} className="text-xs text-muted-foreground hover:text-primary transition-colors font-mono">
        [+ aggregation]
      </button>
    );
  }

  return (
    <div className="border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-primary">GROUP BY</span>
        <button type="button" onClick={() => onChange(null)} className="text-xs text-muted-foreground hover:text-destructive transition-colors">
          [remove]
        </button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={aggregation.fn}
          onChange={(e) => onChange({ ...aggregation, fn: e.target.value as 'count' | 'count_distinct' })}
          className="h-10 border-b border-border bg-transparent px-1 py-2 text-sm font-mono text-foreground focus:outline-none focus:border-primary"
        >
          <option value="count">COUNT(*)</option>
          <option value="count_distinct">COUNT(DISTINCT)</option>
        </select>
        <span className="text-xs text-muted-foreground">BY</span>
        <input
          type="text"
          className="h-10 w-48 border-b border-border bg-transparent px-1 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
          placeholder="field1, field2"
          value={aggregation.groupBy.join(", ")}
          onChange={(e) => {
            const groupBy = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
            onChange({ ...aggregation, groupBy: groupBy.length > 0 ? groupBy : ['moduleId'] });
          }}
        />
      </div>
    </div>
  );
}
