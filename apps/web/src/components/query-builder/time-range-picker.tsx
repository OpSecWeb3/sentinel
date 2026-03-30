"use client";

import { cn } from "@/lib/utils";
import { TIME_PRESETS } from "./utils";

interface TimeRangePickerProps {
  from: string | null;
  to: string | null;
  onChange: (from: string | null, to: string | null) => void;
}

export function TimeRangePicker({ from, to, onChange }: TimeRangePickerProps) {
  const activePreset = TIME_PRESETS.find((p) => {
    if (!from || to) return false;
    const expected = Date.now() - p.hours * 3600_000;
    return Math.abs(new Date(from).getTime() - expected) < 60_000;
  });

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-muted-foreground font-mono">TIME</span>
      {TIME_PRESETS.map((p) => (
        <button
          key={p.label}
          type="button"
          onClick={() => {
            const now = new Date();
            const start = new Date(now.getTime() - p.hours * 3600_000);
            onChange(start.toISOString(), null);
          }}
          className={cn(
            "px-2 py-1 text-xs font-mono border transition-colors",
            activePreset?.label === p.label
              ? "border-primary text-primary text-glow"
              : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50",
          )}
        >
          {p.label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onChange(null, null)}
        className={cn(
          "px-2 py-1 text-xs font-mono border transition-colors",
          !from && !to
            ? "border-primary text-primary text-glow"
            : "border-border text-muted-foreground hover:text-foreground hover:border-primary/50",
        )}
      >
        all
      </button>
    </div>
  );
}
