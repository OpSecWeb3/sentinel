"use client";

import { type RefObject } from "react";

type InputRef = RefObject<HTMLInputElement> | RefObject<HTMLInputElement | null>;
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  inputRef?: InputRef;
}

export function SearchInput({
  value,
  onChange,
  placeholder = "search...",
  className,
  autoFocus,
  inputRef,
}: SearchInputProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border border-border bg-background px-3 py-2 text-sm transition-colors focus-within:border-primary",
        className,
      )}
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        autoFocus={autoFocus}
        className="w-full bg-transparent outline-none placeholder:text-muted-foreground font-mono text-sm"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors text-xs"
        >
          [x]
        </button>
      )}
    </div>
  );
}
