"use client";

import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { Search, ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
}

export interface ComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
  disabled?: boolean;
}

export function Combobox({
  value,
  onValueChange,
  options,
  placeholder = "Select...",
  searchPlaceholder = "search...",
  className,
  disabled = false,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.value === value);

  const filtered = query
    ? options.filter((o) => {
        const q = query.toLowerCase();
        return (
          o.label.toLowerCase().includes(q) ||
          o.value.toLowerCase().includes(q) ||
          (o.description?.toLowerCase().includes(q) ?? false)
        );
      })
    : options;

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setHighlightedIndex(-1);
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open, close]);

  // Close on escape
  useEffect(() => {
    if (!open) return;
    function handleEsc(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [open, close]);

  // Auto-focus search input when opened
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  // Scroll highlighted into view
  useEffect(() => {
    if (!open || highlightedIndex < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-option]");
    items[highlightedIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex, open]);

  // Reset highlight when filter changes
  useEffect(() => {
    setHighlightedIndex(filtered.length > 0 ? 0 : -1);
  }, [query, filtered.length]);

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        setHighlightedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
        break;
      }
      case "Enter": {
        e.preventDefault();
        if (highlightedIndex >= 0 && filtered[highlightedIndex]) {
          onValueChange(filtered[highlightedIndex].value);
          close();
        }
        break;
      }
    }
  }

  return (
    <div ref={containerRef} className={cn("relative inline-block", className)}>
      {/* Trigger button */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
        className={cn(
          "flex h-10 w-full min-w-[150px] items-center justify-between border-b border-border bg-transparent px-1 py-2 text-sm font-mono",
          "text-foreground transition-colors",
          "hover:border-primary/50 focus:outline-none focus:border-primary",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open && "border-primary",
        )}
      >
        <span className={cn("truncate", !selectedOption && "text-muted-foreground")}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          className={cn(
            "ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-180 text-primary",
          )}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className={cn(
            "absolute z-50 mt-1 min-w-full w-max overflow-hidden rounded-md border border-border bg-popover shadow-lg shadow-black/20",
            "animate-in fade-in-0 zoom-in-95 duration-100",
          )}
          style={{ minWidth: "100%", maxWidth: "400px" }}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              className="w-full bg-transparent outline-none placeholder:text-muted-foreground font-mono text-sm"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors text-xs"
              >
                [x]
              </button>
            )}
          </div>

          {/* Options list */}
          <div ref={listRef} className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground font-mono">
                {">"} no matches
              </div>
            ) : (
              filtered.map((option, index) => {
                const isSelected = option.value === value;
                const isHighlighted = index === highlightedIndex;

                return (
                  <div
                    key={option.value}
                    data-option
                    className={cn(
                      "flex items-start gap-2 px-3 py-2 cursor-pointer transition-colors",
                      isHighlighted && "bg-accent text-accent-foreground",
                      isSelected && !isHighlighted && "text-primary",
                      !isHighlighted && !isSelected && "text-foreground hover:bg-accent/50",
                    )}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onValueChange(option.value);
                      close();
                    }}
                  >
                    <span className="w-4 shrink-0 pt-0.5">
                      {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-mono truncate">{option.label}</p>
                      {option.description && (
                        <p className="text-xs text-muted-foreground truncate">{option.description}</p>
                      )}
                      <p className="text-xs text-muted-foreground/50 truncate">{option.value}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
