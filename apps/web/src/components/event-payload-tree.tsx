"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

function TreeLine({ last = false }: { last?: boolean }) {
  return (
    <span className="text-muted-foreground/50 select-none">
      {last ? "└── " : "├── "}
    </span>
  );
}

interface TreeValueProps {
  label: string;
  value: ReactNode;
  last?: boolean;
  valueClassName?: string;
}

export function TreeValue({
  label,
  value,
  last = false,
  valueClassName,
}: TreeValueProps) {
  return (
    <div className="flex">
      <TreeLine last={last} />
      <span className="text-muted-foreground">{label}:</span>
      <span
        className={cn(
          "ml-1 min-w-0 break-all",
          valueClassName ?? "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function primitiveDisplay(value: unknown): {
  display: string;
  className: string;
} {
  if (value === null) {
    return { display: "null", className: "text-muted-foreground/70" };
  }
  if (value === undefined) {
    return { display: "undefined", className: "text-muted-foreground/70" };
  }
  if (typeof value === "string") {
    return { display: `"${value}"`, className: "text-foreground" };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { display: String(value), className: "text-primary" };
  }
  return { display: JSON.stringify(value), className: "text-foreground" };
}

function isComposite(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function Node({
  label,
  value,
  last = false,
}: {
  label: string;
  value: unknown;
  last?: boolean;
}) {
  if (!isComposite(value)) {
    const { display, className } = primitiveDisplay(value);
    return (
      <TreeValue
        label={label}
        value={display}
        last={last}
        valueClassName={className}
      />
    );
  }

  const entries: ReadonlyArray<readonly [string, unknown]> = Array.isArray(
    value,
  )
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value);

  const summary = Array.isArray(value)
    ? `[${entries.length}]`
    : `{${entries.length}}`;

  return (
    <div>
      <div className="flex">
        <TreeLine last={last} />
        <span className="text-muted-foreground">{label}:</span>
        <span className="ml-1 text-muted-foreground/70">{summary}</span>
      </div>
      {entries.length > 0 && (
        <div className="pl-4">
          {entries.map(([k, v], i) => (
            <Node key={k} label={k} value={v} last={i === entries.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export interface PayloadTreeProps {
  payload: unknown;
  rootLabel?: string;
  className?: string;
}

export function PayloadTree({
  payload,
  rootLabel = "event/",
  className,
}: PayloadTreeProps) {
  const entries: ReadonlyArray<readonly [string, unknown]> = isComposite(
    payload,
  )
    ? Array.isArray(payload)
      ? payload.map((v, i) => [String(i), v] as const)
      : Object.entries(payload)
    : [];

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-card p-4 font-mono text-xs leading-relaxed",
        className,
      )}
    >
      <div className="mb-1 font-bold text-foreground">{rootLabel}</div>
      {entries.length === 0 ? (
        <div className="text-muted-foreground/70">(empty)</div>
      ) : (
        entries.map(([k, v], i) => (
          <Node key={k} label={k} value={v} last={i === entries.length - 1} />
        ))
      )}
    </div>
  );
}
