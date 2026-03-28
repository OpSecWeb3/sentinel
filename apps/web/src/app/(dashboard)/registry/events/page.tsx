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
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  receivedAt: string;
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
  "registry.docker.digest_change": "digest_change",
  "registry.docker.new_tag": "new_tag",
  "registry.docker.tag_removed": "tag_removed",
  "registry.npm.version_published": "version_published",
  "registry.npm.version_deprecated": "version_deprecated",
  "registry.npm.version_unpublished": "version_unpublished",
  "registry.npm.maintainer_changed": "maintainer_changed",
  "registry.npm.dist_tag_updated": "dist_tag_updated",
  "registry.verification.signature_missing": "signature_missing",
  "registry.verification.provenance_missing": "provenance_missing",
  "registry.verification.signature_invalid": "signature_invalid",
  "registry.verification.provenance_invalid": "provenance_invalid",
  "registry.attribution.unattributed_change": "unattributed_change",
  "registry.attribution.attribution_mismatch": "attribution_mismatch",
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

function truncate(s: string | null | undefined, len: number): string {
  if (!s) return "--";
  return s.length > len ? s.slice(0, len) + "…" : s;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button
      onClick={handleCopy}
      className="ml-1 text-muted-foreground/60 hover:text-foreground transition-colors"
    >
      {copied ? "[copied]" : "[copy]"}
    </button>
  );
}

function AttributionBadge({ status }: { status: string | undefined }) {
  if (status === "verified")
    return <span className="text-primary">[verified]</span>;
  if (status === "inferred")
    return <span className="text-warning">[inferred]</span>;
  if (status === "unattributed")
    return <span className="text-destructive">[unattributed]</span>;
  if (status === "pending")
    return <span className="text-muted-foreground">[pending]</span>;
  return <span className="text-muted-foreground">[--]</span>;
}

function EventDetail({ event }: { event: ReleaseEvent }) {
  const p = event.payload;
  const verification = p.verification as
    | {
        signature?: { hasSignature?: boolean; keyId?: string; issuer?: string };
        provenance?: {
          hasProvenance?: boolean;
          sourceRepo?: string;
          builder?: string;
          commit?: string;
        };
        rekor?: { hasRekorEntry?: boolean; logIndex?: number };
      }
    | undefined;

  const artifact = p.artifact as string | undefined;
  const tag = p.tag as string | undefined;
  const source = p.source as string | undefined;
  const oldDigest = p.oldDigest as string | null | undefined;
  const newDigest = p.newDigest as string | null | undefined;
  const attributionStatus = p.attributionStatus as string | undefined;
  const actor = p.actor as string | undefined;
  const workflow = p.workflow as string | undefined;
  const commit = p.commit as string | undefined;
  const ciRunId = p.ciRunId as string | undefined;
  const pusher = p.pusher as string | undefined;
  const githubRepo = p.githubRepo as string | undefined;

  const sig = verification?.signature;
  const prov = verification?.provenance;
  const rekor = verification?.rekor;

  return (
    <div className="border-x border-b border-border bg-muted/20 px-4 py-3 font-mono text-xs">
      {/* Core fields */}
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <div>
          <span className="text-muted-foreground">event id:    </span>
          <span className="text-foreground">{event.id.slice(0, 8)}…</span>
        </div>
        <div>
          <span className="text-muted-foreground">type:        </span>
          <span className="text-foreground">{event.eventType}</span>
        </div>
        <div>
          <span className="text-muted-foreground">time:        </span>
          <span className="text-foreground">
            {new Date(event.receivedAt).toISOString()}
          </span>
        </div>
        {artifact && (
          <div>
            <span className="text-muted-foreground">artifact:    </span>
            <span className="text-foreground">{artifact}</span>
          </div>
        )}
        {tag && (
          <div>
            <span className="text-muted-foreground">tag/version: </span>
            <span className="text-foreground">{tag}</span>
          </div>
        )}
        {source && (
          <div>
            <span className="text-muted-foreground">source:      </span>
            <span className="text-primary">[{source}]</span>
          </div>
        )}
      </div>

      {/* Digests */}
      {(oldDigest || newDigest) && (
        <div className="mt-3 space-y-1">
          <p className="text-muted-foreground">--- digests ---</p>
          <div>
            <span className="text-muted-foreground">old: </span>
            <span className="text-foreground">{truncate(oldDigest, 20)}</span>
            {oldDigest && <CopyButton value={oldDigest} />}
          </div>
          <div>
            <span className="text-muted-foreground">new: </span>
            <span className="text-foreground">{truncate(newDigest, 20)}</span>
            {newDigest && <CopyButton value={newDigest} />}
          </div>
        </div>
      )}

      {/* Attribution */}
      <div className="mt-3 space-y-1">
        <p className="text-muted-foreground">--- attribution ---</p>
        <div>
          <span className="text-muted-foreground">status:   </span>
          <AttributionBadge status={attributionStatus} />
        </div>
        <div>
          <span className="text-muted-foreground">actor:    </span>
          <span className="text-foreground">{actor ?? "--"}</span>
        </div>
        <div>
          <span className="text-muted-foreground">workflow: </span>
          <span className="text-foreground">{workflow ?? "--"}</span>
        </div>
        <div>
          <span className="text-muted-foreground">commit:   </span>
          {commit && githubRepo ? (
            <a
              href={`https://github.com/${githubRepo}/commit/${commit}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {commit.slice(0, 12)}
            </a>
          ) : (
            <span className="text-foreground">{commit ?? "--"}</span>
          )}
        </div>
        <div>
          <span className="text-muted-foreground">run id:   </span>
          <span className="text-foreground">{ciRunId ?? "--"}</span>
        </div>
        <div>
          <span className="text-muted-foreground">pusher:   </span>
          <span className="text-foreground">{pusher ?? "--"}</span>
        </div>
      </div>

      {/* Verification */}
      {verification && (
        <div className="mt-3 space-y-1">
          <p className="text-muted-foreground">--- verification ---</p>
          <div>
            <span className="text-muted-foreground">signature:  </span>
            {sig == null ? (
              <span className="text-muted-foreground">[--]</span>
            ) : sig.hasSignature ? (
              <span className="text-primary">
                [yes{sig.keyId ? `: keyId=${sig.keyId}` : ""}]
              </span>
            ) : (
              <span className="text-destructive">[no]</span>
            )}
          </div>
          <div>
            <span className="text-muted-foreground">provenance: </span>
            {prov == null ? (
              <span className="text-muted-foreground">[--]</span>
            ) : prov.hasProvenance ? (
              <span className="text-primary">
                [yes{prov.sourceRepo ? `: repo=${prov.sourceRepo}` : ""}]
              </span>
            ) : (
              <span className="text-destructive">[no]</span>
            )}
          </div>
          <div>
            <span className="text-muted-foreground">rekor:      </span>
            {rekor == null ? (
              <span className="text-muted-foreground">[--]</span>
            ) : rekor.hasRekorEntry && rekor.logIndex != null ? (
              <span className="text-primary">[logIndex={rekor.logIndex}]</span>
            ) : rekor.hasRekorEntry ? (
              <span className="text-primary">[yes]</span>
            ) : (
              <span className="text-muted-foreground">[--]</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
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

export default function RegistryEventsPage() {
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
      params.set("moduleId", "registry");
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      if (typeFilter !== "all") {
        // Find matching full event type
        const fullType = Object.keys(eventTypeLabels).find(
          (k) => eventTypeLabels[k] === typeFilter,
        );
        if (fullType) params.set("eventType", fullType);
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
    <div className="space-y-6 font-mono">
      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ registry events ls
          {hasActiveFilters && (
            <span className="text-muted-foreground"> --filter</span>
          )}
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} registry event log -- Docker and npm artifact changes
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
                {">"} no registry events found
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
                const shortType = getShortType(event.eventType);
                const color =
                  eventTypeColor[shortType] ?? "text-muted-foreground";
                const isExpanded = expandedId === event.id;

                const artifact = event.payload.artifact as string | undefined;
                const hasSignature = (
                  event.payload.verification as
                    | { signature?: { hasSignature?: boolean } }
                    | undefined
                )?.signature?.hasSignature;
                const hasProvenance = (
                  event.payload.verification as
                    | { provenance?: { hasProvenance?: boolean } }
                    | undefined
                )?.provenance?.hasProvenance;
                const attributionStatus = event.payload
                  .attributionStatus as string | undefined;

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
                        {artifact ?? "--"}
                      </span>

                      {/* Signature badge */}
                      <span className="text-xs">
                        {hasSignature === true ? (
                          <span className="text-primary">[sig:yes]</span>
                        ) : hasSignature === false ? (
                          <span className="text-destructive">[sig:no]</span>
                        ) : (
                          <span className="text-muted-foreground">[--]</span>
                        )}
                      </span>

                      {/* Provenance badge */}
                      <span className="text-xs">
                        {hasProvenance === true ? (
                          <span className="text-primary">[prov:yes]</span>
                        ) : hasProvenance === false ? (
                          <span className="text-destructive">[prov:no]</span>
                        ) : (
                          <span className="text-muted-foreground">[--]</span>
                        )}
                      </span>

                      {/* Attribution badge */}
                      <span className="text-xs">
                        <AttributionBadge status={attributionStatus} />
                      </span>

                      <span className="text-xs text-muted-foreground">
                        {formatTimestamp(event.receivedAt)}
                      </span>

                      <span className="text-right text-xs text-muted-foreground group-hover:text-primary transition-colors">
                        {isExpanded ? "[-]" : "[+]"}
                      </span>
                    </div>

                    {/* Expanded detail */}
                    {isExpanded && <EventDetail event={event} />}
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
