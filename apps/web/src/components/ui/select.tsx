"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  type KeyboardEvent,
} from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  id?: string;
  disabled?: boolean;
}

const Select = forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      value,
      onValueChange,
      options,
      placeholder = "Select...",
      className,
      id,
      disabled = false,
    },
    ref,
  ) => {
    const [open, setOpen] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState(-1);
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const selectedOption = options.find((o) => o.value === value);

    const enabledOptions = options.filter((o) => !o.disabled);

    const close = useCallback(() => {
      setOpen(false);
      setHighlightedIndex(-1);
    }, []);

    // Close on outside click
    useEffect(() => {
      if (!open) return;
      function handleClick(e: MouseEvent) {
        if (
          containerRef.current &&
          !containerRef.current.contains(e.target as Node)
        ) {
          close();
        }
      }
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }, [open, close]);

    // Close on escape (global)
    useEffect(() => {
      if (!open) return;
      function handleEsc(e: globalThis.KeyboardEvent) {
        if (e.key === "Escape") close();
      }
      document.addEventListener("keydown", handleEsc);
      return () => document.removeEventListener("keydown", handleEsc);
    }, [open, close]);

    // Scroll highlighted item into view
    useEffect(() => {
      if (!open || highlightedIndex < 0 || !listRef.current) return;
      const items = listRef.current.querySelectorAll("[data-option]");
      items[highlightedIndex]?.scrollIntoView({ block: "nearest" });
    }, [highlightedIndex, open]);

    function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
      if (disabled) return;

      switch (e.key) {
        case "ArrowDown":
        case "Down": {
          e.preventDefault();
          if (!open) {
            setOpen(true);
            setHighlightedIndex(
              enabledOptions.length > 0
                ? options.indexOf(enabledOptions[0])
                : 0,
            );
          } else {
            setHighlightedIndex((prev) => {
              const currentEnabled = enabledOptions.indexOf(options[prev]);
              const nextIdx =
                currentEnabled < enabledOptions.length - 1
                  ? currentEnabled + 1
                  : 0;
              return options.indexOf(enabledOptions[nextIdx]);
            });
          }
          break;
        }
        case "ArrowUp":
        case "Up": {
          e.preventDefault();
          if (!open) {
            setOpen(true);
            setHighlightedIndex(
              enabledOptions.length > 0
                ? options.indexOf(enabledOptions[enabledOptions.length - 1])
                : 0,
            );
          } else {
            setHighlightedIndex((prev) => {
              const currentEnabled = enabledOptions.indexOf(options[prev]);
              const nextIdx =
                currentEnabled > 0
                  ? currentEnabled - 1
                  : enabledOptions.length - 1;
              return options.indexOf(enabledOptions[nextIdx]);
            });
          }
          break;
        }
        case "Enter":
        case " ": {
          e.preventDefault();
          if (!open) {
            setOpen(true);
          } else if (
            highlightedIndex >= 0 &&
            !options[highlightedIndex]?.disabled
          ) {
            onValueChange(options[highlightedIndex].value);
            close();
          }
          break;
        }
        case "Home": {
          if (open) {
            e.preventDefault();
            if (enabledOptions.length > 0) {
              setHighlightedIndex(options.indexOf(enabledOptions[0]));
            }
          }
          break;
        }
        case "End": {
          if (open) {
            e.preventDefault();
            if (enabledOptions.length > 0) {
              setHighlightedIndex(
                options.indexOf(enabledOptions[enabledOptions.length - 1]),
              );
            }
          }
          break;
        }
      }
    }

    return (
      <div ref={containerRef} className={cn("relative inline-block", className)}>
        {/* Trigger */}
        <button
          ref={ref}
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          onClick={() => {
            if (!disabled) setOpen((v) => !v);
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            "flex h-10 w-full min-w-[150px] items-center justify-between border-b border-border bg-transparent px-1 py-2 text-sm font-mono",
            "text-foreground transition-colors",
            "hover:border-primary/50 focus:outline-none focus:border-primary",
            "disabled:cursor-not-allowed disabled:opacity-50",
            open && "border-primary",
          )}
        >
          <span
            className={cn(
              "truncate",
              !selectedOption && "text-muted-foreground",
            )}
          >
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          <ChevronDown
            className={cn(
              "ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              open && "rotate-180 text-primary",
            )}
          />
        </button>

        {/* Dropdown panel */}
        {open && (
          <div
            ref={listRef}
            role="listbox"
            aria-activedescendant={
              highlightedIndex >= 0
                ? `option-${options[highlightedIndex]?.value}`
                : undefined
            }
            className={cn(
              "absolute z-50 mt-1 min-w-full w-max overflow-hidden rounded-md border border-border bg-popover shadow-lg shadow-black/20",
              "animate-in fade-in-0 zoom-in-95 duration-100",
            )}
          >
            <div className="max-h-60 overflow-y-auto py-1">
              {options.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground font-mono">
                  {">"} no options
                </div>
              ) : (
                options.map((option, index) => {
                  const isSelected = option.value === value;
                  const isHighlighted = index === highlightedIndex;

                  return (
                    <div
                      key={option.value}
                      id={`option-${option.value}`}
                      role="option"
                      data-option
                      aria-selected={isSelected}
                      aria-disabled={option.disabled}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 text-sm font-mono cursor-pointer transition-colors",
                        isHighlighted && "bg-accent text-accent-foreground",
                        isSelected &&
                          !isHighlighted &&
                          "text-primary",
                        option.disabled &&
                          "cursor-not-allowed opacity-40",
                        !isHighlighted &&
                          !isSelected &&
                          !option.disabled &&
                          "text-foreground hover:bg-accent/50",
                      )}
                      onMouseEnter={() => {
                        if (!option.disabled) setHighlightedIndex(index);
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        if (!option.disabled) {
                          onValueChange(option.value);
                          close();
                        }
                      }}
                    >
                      <span className="w-4 shrink-0">
                        {isSelected && (
                          <Check className="h-3.5 w-3.5 text-primary" />
                        )}
                      </span>
                      <span className="truncate">{option.label}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    );
  },
);
Select.displayName = "Select";
export { Select };
