"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Collection } from "./types";

interface ResultsMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface QueryResultsProps {
  collection: Collection;
  data: Record<string, unknown>[];
  meta: ResultsMeta | null;
  loading: boolean;
  error: string | null;
  onPageChange: (page: number) => void;
}

const MODULE_COLORS: Record<string, string> = {
  chain: "text-yellow-500",
  github: "text-purple-400",
  infra: "text-blue-400",
  registry: "text-teal-400",
  aws: "text-orange-400",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h ago`;
}

export function QueryResults({ collection, data, meta, loading, error, onPageChange }: QueryResultsProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-primary">{">"} executing query...<span className="ml-1 animate-pulse">_</span></p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-destructive">[ERR] {error}</p>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-muted-foreground">{">"} query returned 0 rows</p>
      </div>
    );
  }

  const isEvents = collection === "events";

  return (
    <div className="space-y-2">
      {meta && (
        <p className="text-xs text-muted-foreground">
          {">"} {meta.total} result{meta.total !== 1 ? "s" : ""} · page {meta.page}/{meta.totalPages}
        </p>
      )}

      {isEvents ? (
        <div className="grid grid-cols-[80px_160px_minmax(100px,1fr)_100px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <span>Module</span><span>Type</span><span>External ID</span><span>Received</span>
        </div>
      ) : (
        <div className="grid grid-cols-[80px_minmax(100px,1fr)_100px_100px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <span>Severity</span><span>Title</span><span>Status</span><span>Created</span>
        </div>
      )}

      <div>
        {data.map((row) => {
          const id = String(row.id);
          const expanded = expandedId === id;

          return (
            <div key={id}>
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : id)}
                className={cn(
                  "group w-full text-left text-sm transition-colors border border-transparent hover:border-border hover:bg-muted/30 px-3 py-2",
                  isEvents
                    ? "grid grid-cols-[80px_160px_minmax(100px,1fr)_100px] gap-x-3 items-center"
                    : "grid grid-cols-[80px_minmax(100px,1fr)_100px_100px] gap-x-3 items-center",
                )}
              >
                {isEvents ? (
                  <>
                    <span className={cn("text-xs font-mono", MODULE_COLORS[row.moduleId as string] ?? "text-primary")}>[{row.moduleId as string}]</span>
                    <span className="text-foreground text-xs font-medium truncate">{row.eventType as string}</span>
                    <span className="truncate text-muted-foreground text-xs">{(row.externalId as string) ?? "--"}</span>
                    <span className="text-muted-foreground text-xs">{timeAgo(row.receivedAt as string)}</span>
                  </>
                ) : (
                  <>
                    <span className={cn("text-xs font-mono",
                      row.severity === "critical" ? "text-red-500" :
                      row.severity === "high" ? "text-orange-400" :
                      row.severity === "medium" ? "text-yellow-500" : "text-muted-foreground",
                    )}>[{row.severity as string}]</span>
                    <span className="text-foreground text-xs font-medium truncate">{row.title as string}</span>
                    <span className="text-muted-foreground text-xs">{row.notificationStatus as string}</span>
                    <span className="text-muted-foreground text-xs">{timeAgo(row.createdAt as string)}</span>
                  </>
                )}
              </button>

              {expanded && (
                <div className="border-l-2 border-primary/30 bg-muted/10 ml-3 mb-2 pl-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-muted-foreground">$ cat {collection}/{id.slice(0, 8)}.json</p>
                    <button type="button" className="text-xs text-muted-foreground hover:text-primary transition-colors" onClick={() => navigator.clipboard.writeText(JSON.stringify(row, null, 2))}>
                      [copy]
                    </button>
                  </div>
                  <pre className="text-xs text-foreground overflow-x-auto max-h-64 overflow-y-auto">{JSON.stringify(row, null, 2)}</pre>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
          <span>{meta.total} result{meta.total !== 1 ? "s" : ""} · page {meta.page}/{meta.totalPages}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="text-xs h-7" disabled={meta.page <= 1} onClick={() => onPageChange(1)}>[{"<<"} first]</Button>
            <Button variant="ghost" size="sm" className="text-xs h-7" disabled={meta.page <= 1} onClick={() => onPageChange(meta.page - 1)}>[{"<"} prev]</Button>
            <Button variant="ghost" size="sm" className="text-xs h-7" disabled={meta.page >= meta.totalPages} onClick={() => onPageChange(meta.page + 1)}>[next {">"}]</Button>
            <Button variant="ghost" size="sm" className="text-xs h-7" disabled={meta.page >= meta.totalPages} onClick={() => onPageChange(meta.totalPages)}>[last {">>"}]</Button>
          </div>
        </div>
      )}
    </div>
  );
}
