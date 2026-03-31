"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiGet } from "@/lib/api";
import { tableRowToggleKeyDown } from "@/lib/table-row-a11y";

/* -- types --------------------------------------------------------- */

interface GithubEvent {
  id: string;
  moduleId: string;
  eventType: string;
  payload: Record<string, unknown>;
  processedAt: string | null;
  createdAt: string;
}

interface EventsMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface EventsResponse {
  data: GithubEvent[];
  meta: EventsMeta;
}

/* -- helpers ------------------------------------------------------- */

const PAGE_SIZE = 20;

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleString();
}

function summarizePayload(payload: Record<string, unknown>): string {
  // Try to extract a useful summary from common GitHub webhook payload patterns
  const action = payload.action as string | undefined;
  const sender = payload.sender as { login?: string } | undefined;
  const repo = payload.repository as { full_name?: string } | undefined;

  const parts: string[] = [];
  if (action) parts.push(action);
  if (repo?.full_name) parts.push(repo.full_name);
  if (sender?.login) parts.push(`by ${sender.login}`);

  if (parts.length > 0) return parts.join(" | ");

  // Fallback: show first few keys
  const keys = Object.keys(payload).slice(0, 3);
  return keys.length > 0 ? `keys: ${keys.join(", ")}` : "(empty)";
}

/* -- page ---------------------------------------------------------- */

export default function GitHubEventsPage() {
  const [events, setEvents] = useState<GithubEvent[]>([]);
  const [meta, setMeta] = useState<EventsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const fetchEvents = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      params.set("moduleId", "github");
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));

      const res = await apiGet<EventsResponse>(`/api/events?${params.toString()}`);
      setEvents(res.data);
      setMeta(res.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ github events ls
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} github webhook event log
          </p>
        </div>
        <Link
          href="/github"
          className="text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          [back]
        </Link>
      </div>

      {/* Content */}
      <div className="min-h-[400px]">
        {showLoading ? (
          <div className="space-y-1">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center gap-x-3 px-3 py-2">
                <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                <div className="h-3 w-48 animate-pulse rounded bg-muted" />
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : error ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-destructive">[ERR] {error}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={fetchEvents}>
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : events.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} /var/log/github-events: empty
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                no github events have been received yet
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto animate-content-ready">
            <div className="min-w-[700px]">
              <Table>
                <colgroup>
                  <col className="w-[140px]" />
                  <col />
                  <col className="w-[120px]" />
                  <col className="w-[60px]" />
                </colgroup>
                <TableHeader>
                  <TableRow className="border-b border-border hover:bg-transparent">
                    <TableHead scope="col">Event Type</TableHead>
                    <TableHead scope="col">Summary</TableHead>
                    <TableHead scope="col">Timestamp</TableHead>
                    <TableHead scope="col" className="text-right">
                      Detail
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow className="border-0 hover:bg-transparent">
                    <TableCell
                      colSpan={4}
                      className="border-0 py-2 text-xs text-muted-foreground"
                    >
                      {meta ? meta.total : events.length} event
                      {(meta ? meta.total : events.length) !== 1 ? "s" : ""}
                      {meta && meta.totalPages > 1
                        ? ` -- page ${meta.page} of ${meta.totalPages}`
                        : ""}
                    </TableCell>
                  </TableRow>
                  {events.map((event) => {
                    const isExpanded = expandedIds.has(event.id);
                    const toggle = () => toggleExpand(event.id);

                    return (
                      <Fragment key={event.id}>
                        <TableRow
                          role="button"
                          tabIndex={0}
                          aria-expanded={isExpanded}
                          onClick={toggle}
                          onKeyDown={(e) => tableRowToggleKeyDown(e, toggle)}
                          className="group cursor-pointer border border-transparent text-sm transition-colors hover:border-border hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <TableCell className="font-mono text-xs text-primary">
                            {event.eventType}
                          </TableCell>
                          <TableCell className="max-w-0 font-mono text-xs text-muted-foreground">
                            <span className="block truncate">
                              {summarizePayload(event.payload)}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatTimestamp(event.createdAt)}
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground transition-colors group-hover:text-primary">
                            {isExpanded ? "[hide]" : "[show]"}
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow className="border-0 hover:bg-transparent">
                            <TableCell colSpan={4} className="border-l-2 border-primary/30 py-2 pl-4">
                              <pre className="max-h-80 overflow-y-auto overflow-x-auto rounded border border-border bg-muted/20 p-3 font-mono text-xs text-muted-foreground">
                                {JSON.stringify(event.payload, null, 2)}
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
          </div>
        )}
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            showing {(meta.page - 1) * PAGE_SIZE + 1}
            {"\u2013"}
            {Math.min(meta.page * PAGE_SIZE, meta.total)} of {meta.total}
          </span>
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="transition-colors hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              [{"<"} prev]
            </button>
            <span className="text-primary font-mono">
              [{meta.page}/{meta.totalPages}]
            </span>
            <button
              disabled={page >= meta.totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="transition-colors hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              [next {">"}]
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
