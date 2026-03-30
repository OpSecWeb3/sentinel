"use client";

import { cn } from "@/lib/utils";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onChange, disabled, className }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "h-3.5 w-3.5 shrink-0 border rounded-sm transition-colors focus:outline-none focus:ring-1 focus:ring-primary",
        checked
          ? "bg-primary border-primary text-primary-foreground"
          : "border-muted-foreground/40 bg-transparent",
        disabled && "opacity-50 cursor-not-allowed",
        className,
      )}
    >
      {checked && (
        <svg
          viewBox="0 0 14 14"
          fill="none"
          className="h-full w-full"
        >
          <path
            d="M3 7.5L5.5 10L11 4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
