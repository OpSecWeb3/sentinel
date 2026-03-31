"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

const HELP_COLLAPSE_AT = 110;

export function TemplateFieldHeader({
  htmlFor,
  label,
  required,
  help,
  className,
}: {
  htmlFor: string;
  label: string;
  required?: boolean;
  help?: string;
  className?: string;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const longHelp = help && help.length >= HELP_COLLAPSE_AT;

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <label
          htmlFor={htmlFor}
          className="text-xs font-medium text-foreground"
        >
          {label}
        </label>
        {required && (
          <span className="text-[10px] font-mono text-destructive">[required]</span>
        )}
        {help && longHelp && (
          <button
            type="button"
            className="text-[10px] font-mono text-primary hover:text-primary/80"
            onClick={() => setHelpOpen((o) => !o)}
            aria-expanded={helpOpen}
          >
            {helpOpen ? "[− help]" : "[+ help]"}
          </button>
        )}
      </div>
      {help && !longHelp && (
        <p className="text-[10px] leading-relaxed text-muted-foreground/80">
          {help}
        </p>
      )}
      {help && longHelp && helpOpen && (
        <p className="border-l border-border pl-2 text-[10px] leading-relaxed text-muted-foreground/80">
          {help}
        </p>
      )}
    </div>
  );
}
