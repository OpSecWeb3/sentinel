"use client";

import { cn } from "@/lib/utils";

interface ViewModeToggleProps {
  mode: "form" | "advanced";
  onChange: (mode: "form" | "advanced") => void;
  disabled?: boolean;
}

export function ViewModeToggle({ mode, onChange, disabled }: ViewModeToggleProps) {
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="text-muted-foreground">view</span>
      {(["form", "advanced"] as const).map((m) => (
        <button
          key={m}
          type="button"
          disabled={disabled}
          onClick={() => onChange(m)}
          className={cn(
            "transition-colors disabled:opacity-50",
            mode === m
              ? "text-foreground"
              : "text-muted-foreground/60 hover:text-foreground",
          )}
        >
          {mode === m ? `[${m}]` : m}
        </button>
      ))}
    </div>
  );
}
