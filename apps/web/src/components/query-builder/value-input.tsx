"use client";

import type { QueryOperator } from "./types";
import { NO_VALUE_OPS } from "./utils";

interface ValueInputProps {
  operator: QueryOperator;
  value: string | string[];
  onChange: (v: string | string[]) => void;
}

export function ValueInput({ operator, value, onChange }: ValueInputProps) {
  if (NO_VALUE_OPS.includes(operator)) {
    return <span className="text-xs text-muted-foreground italic px-2">--</span>;
  }

  if (operator === "in") {
    const arr = Array.isArray(value) ? value : value ? [value] : [];
    return (
      <input
        type="text"
        className="flex-1 min-w-[120px] h-10 border-b border-border bg-transparent px-1 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
        placeholder="val1, val2, ..."
        value={arr.join(", ")}
        onChange={(e) => {
          const vals = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
          onChange(vals.length > 0 ? vals : []);
        }}
      />
    );
  }

  return (
    <input
      type="text"
      className="flex-1 min-w-[120px] h-10 border-b border-border bg-transparent px-1 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
      placeholder="value..."
      value={Array.isArray(value) ? value.join(", ") : value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
