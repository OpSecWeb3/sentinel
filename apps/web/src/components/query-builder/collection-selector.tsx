"use client";

import type { Collection } from "./types";
import { cn } from "@/lib/utils";

interface CollectionSelectorProps {
  value: Collection;
  onChange: (c: Collection) => void;
}

export function CollectionSelector({ value, onChange }: CollectionSelectorProps) {
  return (
    <div className="flex items-center gap-1 text-sm font-mono">
      <span className="text-muted-foreground mr-1">FROM</span>
      {(["events", "alerts"] as const).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cn(
            "px-3 py-1.5 border transition-colors",
            value === c
              ? "border-primary text-primary text-glow bg-primary/5"
              : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50",
          )}
        >
          [{c}]
        </button>
      ))}
    </div>
  );
}
