"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterConfig {
  key: string;
  label: string;
  value: string | null; // null = "all" / unset
  options: FilterOption[];
  onChange: (value: string | null) => void;
  allLabel?: string;
}

interface FilterBarProps {
  filters: FilterConfig[];
  onClearAll?: () => void;
  hasActiveFilters?: boolean;
  className?: string;
}

function FilterChip({ config }: { config: FilterConfig }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const isActive = config.value !== null;
  const allLabel = config.allLabel ?? "all";
  const selectedLabel = isActive
    ? (config.options.find((o) => o.value === config.value)?.label ?? config.value)
    : allLabel;

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleEsc(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 border px-2.5 py-1.5 text-xs font-mono transition-colors",
          isActive
            ? "border-primary/50 bg-primary/5"
            : "border-border hover:border-primary/30 hover:text-foreground",
          open && "border-primary/50",
        )}
      >
        <span className="text-muted-foreground/70">{config.label}:</span>
        <span className={cn(isActive ? "text-primary" : "text-foreground/80")}>
          {selectedLabel}
        </span>
        <ChevronDown
          className={cn(
            "h-2.5 w-2.5 shrink-0 text-muted-foreground/50 transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1 min-w-full w-max border border-border bg-popover shadow-lg shadow-black/20">
          <div className="py-1">
            <button
              type="button"
              className={cn(
                "w-full px-3 py-1.5 text-left text-xs font-mono transition-colors",
                !isActive
                  ? "text-primary bg-primary/5"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              onClick={() => {
                config.onChange(null);
                setOpen(false);
              }}
            >
              {allLabel}
            </button>
            {config.options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={cn(
                  "w-full px-3 py-1.5 text-left text-xs font-mono transition-colors",
                  config.value === opt.value
                    ? "text-primary bg-primary/5"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
                onClick={() => {
                  config.onChange(opt.value);
                  setOpen(false);
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function FilterBar({
  filters,
  onClearAll,
  hasActiveFilters,
  className,
}: FilterBarProps) {
  const activeCheck =
    hasActiveFilters ?? filters.some((f) => f.value !== null);

  return (
    <div className={cn("flex items-center gap-2 flex-wrap", className)}>
      {filters.map((filter) => (
        <FilterChip key={filter.key} config={filter} />
      ))}
      {activeCheck && onClearAll && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-xs font-mono text-muted-foreground hover:text-destructive transition-colors px-1"
        >
          [clear]
        </button>
      )}
    </div>
  );
}
