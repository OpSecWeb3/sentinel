"use client";

import { Fragment, useState } from "react";
import { cn } from "@/lib/utils";
import { tableRowToggleKeyDown } from "@/lib/table-row-a11y";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

      <div className="overflow-x-auto">
        <Table className={isEvents ? "min-w-[560px]" : "min-w-[480px]"}>
          {isEvents ? (
            <colgroup>
              <col className="w-[80px]" />
              <col className="w-[160px]" />
              <col />
              <col className="w-[100px]" />
            </colgroup>
          ) : (
            <colgroup>
              <col className="w-[80px]" />
              <col />
              <col className="w-[100px]" />
              <col className="w-[100px]" />
            </colgroup>
          )}
          <TableHeader>
            <TableRow className="border-b border-border hover:bg-transparent">
              {isEvents ? (
                <>
                  <TableHead scope="col">Module</TableHead>
                  <TableHead scope="col">Type</TableHead>
                  <TableHead scope="col">External ID</TableHead>
                  <TableHead scope="col">Received</TableHead>
                </>
              ) : (
                <>
                  <TableHead scope="col">Severity</TableHead>
                  <TableHead scope="col">Title</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Created</TableHead>
                </>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => {
              const id = String(row.id);
              const expanded = expandedId === id;
              const toggle = () => setExpandedId(expanded ? null : id);

              return (
                <Fragment key={id}>
                  <TableRow
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded}
                    onClick={toggle}
                    onKeyDown={(e) => tableRowToggleKeyDown(e, toggle)}
                    className="group cursor-pointer border border-transparent text-sm transition-colors hover:border-border hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {isEvents ? (
                      <>
                        <TableCell
                          className={cn(
                            "text-xs font-mono",
                            MODULE_COLORS[row.moduleId as string] ?? "text-primary",
                          )}
                        >
                          [{row.moduleId as string}]
                        </TableCell>
                        <TableCell className="max-w-0 text-xs font-medium text-foreground">
                          <span className="block truncate">{row.eventType as string}</span>
                        </TableCell>
                        <TableCell className="max-w-0 text-xs text-muted-foreground">
                          <span className="block truncate">
                            {(row.externalId as string) ?? "--"}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {timeAgo(row.receivedAt as string)}
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell
                          className={cn(
                            "text-xs font-mono",
                            row.severity === "critical"
                              ? "text-red-500"
                              : row.severity === "high"
                                ? "text-orange-400"
                                : row.severity === "medium"
                                  ? "text-yellow-500"
                                  : "text-muted-foreground",
                          )}
                        >
                          [{row.severity as string}]
                        </TableCell>
                        <TableCell className="max-w-0 text-xs font-medium text-foreground">
                          <span className="block truncate">{row.title as string}</span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {row.notificationStatus as string}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {timeAgo(row.createdAt as string)}
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                  {expanded && (
                    <TableRow className="border-0 hover:bg-transparent">
                      <TableCell colSpan={4} className="border-l-2 border-primary/30 bg-muted/10 py-3 pl-4">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-xs text-muted-foreground">
                            $ cat {collection}/{id.slice(0, 8)}.json
                          </p>
                          <button
                            type="button"
                            className="text-xs text-muted-foreground transition-colors hover:text-primary"
                            onClick={() =>
                              navigator.clipboard.writeText(JSON.stringify(row, null, 2))
                            }
                          >
                            [copy]
                          </button>
                        </div>
                        <pre className="max-h-64 overflow-y-auto overflow-x-auto text-xs text-foreground">
                          {JSON.stringify(row, null, 2)}
                        </pre>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
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
