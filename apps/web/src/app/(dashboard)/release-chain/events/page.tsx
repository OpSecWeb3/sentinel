"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* -- types ----------------------------------------------------------- */

interface ReleaseEvent {
  id: string;
  moduleId: string;
  type: string;
  artifactName?: string;
  metadata?: Record<string, unknown>;
  signature?: boolean;
  provenance?: boolean;
  attributionStatus?: string;
  createdAt: string;
}

interface EventsMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface EventsResponse {
  data: ReleaseEvent[];
  meta: EventsMeta;
}

/* -- helpers --------------------------------------------------------- */

const PAGE_SIZE = 25;

const eventTypeLabels: Record<string, string> = {
  "release-chain.docker.digest_change": "digest_change",
  "release-chain.docker.new_tag": "new_tag",
  "release-chain.docker.tag_removed": "tag_removed",
  "release-chain.npm.version_published": "version_published",
  "release-chain.npm.version_deprecated": "version_deprecated",
  "release-chain.npm.version_unpublished": "version_unpublished",
  "release-chain.npm.maintainer_changed": "maintainer_changed",
  "release-chain.npm.dist_tag_updated": "dist_tag_updated",
  "release-chain.verification.signature_missing": "signature_missing",
  "release-chain.verification.provenance_missing": "provenance_missing",
  "release-chain.verification.signature_invalid": "signature_invalid",
  "release-chain.verification.provenance_invalid": "provenance_invalid",
  "release-chain.attribution.unattributed_change": "unattributed_change",
  "release-chain.attribution.attribution_mismatch": "attribution_mismatch",
};

const eventTypeColor: Record<string, string> = {
  digest_change: "text-warning",
  new_tag: "text-primary",
  tag_removed: "text-destructive",
  version_published: "text-primary",
  version_deprecated: "text-warning",
  version_unpublished: "text-destructive",
  maintainer_changed: "text-warning",
  dist_tag_updated: "text-muted-foreground",
  signature_missing: "text-destructive",
  provenance_missing: "text-destructive",
  signature_invalid: "text-destructive",
  provenance_invalid: "text-destructive",
  unattributed_change: "text-warning",
  attribution_mismatch: "text-warning",
};

function getShortType(type: string): string {
  return eventTypeLabels[type] ?? type.split(".").pop() ?? type;
}

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

const EVENT_TYPE_FILTER_OPTIONS = [
  "all",
  "digest_change",
  "new_tag",
  "tag_removed",
  "version_published",
  "maintainer_changed",
  "signature_missing",
  "provenance_missing",
  "unattributed_change",
];

/* -- page ------------------------------------------------------------ */

export default function ReleaseChainEventsPage() {
  const [events, setEvents] = useState<ReleaseEvent[]>([]);
  const [meta, setMeta] = useState<EventsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Reset page on filter change
  useEffect(() => {
    setPage(1);
  }, [typeFilter]);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("moduleId", "release-chain");
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      if (typeFilter !== "all") {
        // Find matching full event type
        const fullType = Object.keys(eventTypeLabels).find(
          (k) => eventTypeLabels[k] === typeFilter,
        );
        if (fullType) params.set("type", fullType);
      }

      const res = await apiFetch<EventsResponse>(
        `/api/events?${params.toString()}`,
        { credentials: "include" },
      );
      setEvents(res.data);
      setMeta(res.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setLoading(false);
    }
  }, [page, typeFilter]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const hasActiveFilters = typeFilter !== "all";

  /* -- render -------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ release-chain events ls
          {hasActiveFilters && (
            <span className="text-muted-foreground"> --filter</span>
          )}
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} release chain event log -- Docker and npm artifact changes
        </p>
      </div>

      {/* Filters */}
      <div className="space-y-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground w-16">--type</span>
          {EVENT_TYPE_FILTER_OPTIONS.map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={cn(
                "transition-colors",
                typeFilter === t
                  ? "text-foreground"
                  : "text-muted-foreground/60 hover:text-foreground",
              )}
            >
              {typeFilter === t ? `[${t}]` : t}
            </button>
          ))}
        </div>
        {hasActiveFilters && (
          <button
            onClick={() => setTypeFilter("all")}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            [clear filter]
          </button>
        )}
      </div>

      {/* Content */}
      <div className="min-h-[300px]">
        {showLoading || loading ? (
          <div className={showLoading ? "space-y-1" : "space-y-1 invisible"}>
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center gap-x-3 px-3 py-2">
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : error ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-destructive">[ERR] {error}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={fetchEvents}
              >
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : events.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} no release chain events found
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {hasActiveFilters
                  ? "try adjusting or clearing your filters"
                  : "events will appear here when monitored artifacts change"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto animate-content-ready">
            <div className="min-w-[800px]">
              {/* Header */}
              <div className="grid grid-cols-[140px_minmax(160px,2fr)_90px_90px_100px_80px_60px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Type</span>
                <span>Artifact</span>
                <span>Signature</span>
                <span>Provenance</span>
                <span>Attribution</span>
                <span>Time</span>
                <span className="text-right">Detail</span>
              </div>

              <p className="px-3 pt-2 text-xs text-muted-foreground">
                {meta ? meta.total : events.length} event
                {(meta ? meta.total : events.length) !== 1 ? "s" : ""}
                {meta && meta.totalPages > 1
                  ? ` -- page ${meta.page} of ${meta.totalPages}`
                  : ""}
              </p>

              {/* Rows */}
              {events.map((event) => {
                const shortType = getShortType(event.type);
                const color = eventTypeColor[shortType] ?? "text-muted-foreground";
                const isExpanded = expandedId === event.id;

                return (
                  <div key={event.id}>
                    <div
                      className="group grid grid-cols-[140px_minmax(160px,2fr)_90px_90px_100px_80px_60px] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30 cursor-pointer"
                      onClick={() =>
                        setExpandedId(isExpanded ? null : event.id)
                      }
                    >
                      <span
                        className={cn("font-mono text-xs truncate", color)}
                      >
                        {shortType}
                      </span>

                      <span className="text-xs text-foreground truncate">
                        {event.artifactName ??
                          (event.metadata?.image as string) ??
                          (event.metadata?.package as string) ??
                          "--"}
                      </span>

                      {/* Signature badge */}
                      <span className="text-xs">
                        {event.signature === true ? (
                          <span className="text-primary">[sig:yes]</span>
                        ) : event.signature === false ? (
                          <span className="text-destructive">[sig:no]</span>
                        ) : (
                          <span className="text-muted-foreground">[--]</span>
                        )}
                      </span>

                      {/* Provenance badge */}
                      <span className="text-xs">
                        {event.provenance === true ? (
                          <span className="text-primary">[prov:yes]</span>
                        ) : event.provenance === false ? (
                          <span className="text-destructive">[prov:no]</span>
                        ) : (
                          <span className="text-muted-foreground">[--]</span>
                        )}
                      </span>

                      {/* Attribution badge */}
                      <span className="text-xs">
                        {event.attributionStatus === "verified" ? (
                          <span className="text-primary">[verified]</span>
                        ) : event.attributionStatus === "inferred" ? (
                          <span className="text-warning">[inferred]</span>
                        ) : event.attributionStatus === "unattributed" ? (
                          <span className="text-destructive">
                            [unattributed]
                          </span>
                        ) : (
                          <span className="text-muted-foreground">[--]</span>
                        )}
                      </span>

                      <span className="text-xs text-muted-foreground">
                        {formatTimestamp(event.createdAt)}
                      </span>

                      <span className="text-right text-xs text-muted-foreground group-hover:text-primary transition-colors">
                        {isExpanded ? "[-]" : "[+]"}
                      </span>
                    </div>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="border-x border-b border-border bg-muted/20 px-4 py-3 text-xs">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <div>
                            <span className="text-muted-foreground">id: </span>
                            <span className="font-mono text-foreground">
                              {event.id}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">
                              full type:{" "}
                            </span>
                            <span className="font-mono text-foreground">
                              {event.type}
                            </span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">
                              timestamp:{" "}
                            </span>
                            <span className="text-foreground">
                              {new Date(event.createdAt).toLocaleString()}
                            </span>
                          </div>
                          {event.artifactName && (
                            <div>
                              <span className="text-muted-foreground">
                                artifact:{" "}
                              </span>
                              <span className="text-foreground">
                                {event.artifactName}
                              </span>
                            </div>
                          )}
                        </div>

                        {event.metadata &&
                          Object.keys(event.metadata).length > 0 && (
                            <div className="mt-3">
                              <p className="mb-1 text-muted-foreground">
                                metadata:
                              </p>
                              <pre className="rounded border border-border bg-background p-2 font-mono text-xs text-foreground overflow-x-auto">
                                {JSON.stringify(event.metadata, null, 2)}
                              </pre>
                            </div>
                          )}
                      </div>
                    )}
                  </div>
                );
              })}
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
