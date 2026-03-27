"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FilterBar } from "@/components/ui/filter-bar";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* ── types ───────────────────────────────────────────────────── */

interface Event {
  id: string;
  orgId: string;
  moduleId: string;
  eventType: string;
  externalId: string | null;
  payload: Record<string, unknown>;
  receivedAt: string;
  createdAt: string;
}

interface EventsMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface EventsResponse {
  data: Event[];
  meta: EventsMeta;
}

/* ── constants ───────────────────────────────────────────────── */

const MODULES = ["github", "release-chain"];
const EVENT_TYPES = [
  "push",
  "pull_request",
  "release",
  "workflow_run",
  "package",
  "registry_change",
];
const LIMIT = 20;

/* ── page ────────────────────────────────────────────────────── */

export default function EventsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentPage = Number(searchParams.get("page") ?? "1");
  const currentModule = searchParams.get("moduleId") ?? null;
  const currentEventType = searchParams.get("eventType") ?? null;

  const [data, setData] = useState<Event[]>([]);
  const [meta, setMeta] = useState<EventsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const buildQs = useCallback(
    (overrides: Record<string, string | null>) => {
      const params = new URLSearchParams();
      const merged: Record<string, string | null> = {
        page: String(currentPage),
        moduleId: currentModule,
        eventType: currentEventType,
        ...overrides,
      };
      for (const [k, v] of Object.entries(merged)) {
        if (v !== null && v !== undefined) params.set(k, v);
      }
      return params.toString();
    },
    [currentPage, currentModule, currentEventType],
  );

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("page", String(currentPage));
      qs.set("limit", String(LIMIT));
      if (currentModule) qs.set("moduleId", currentModule);
      if (currentEventType) qs.set("eventType", currentEventType);

      const res = await apiFetch<EventsResponse>(
        `/api/events?${qs.toString()}`,
        { credentials: "include" },
      );
      setData(res.data);
      setMeta(res.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [currentPage, currentModule, currentEventType]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const navigate = (qs: string) => router.push(`/events?${qs}`);

  const goToPage = (page: number) => {
    navigate(buildQs({ page: String(page) }));
  };

  // Dynamic command
  const cmdParts = ["$   events ls"];
  if (currentModule) cmdParts.push(`--module ${currentModule}`);
  if (currentEventType) cmdParts.push(`--type ${currentEventType}`);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          {cmdParts.join(" ")}
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} raw events received from modules
        </p>
      </div>

      {/* Filters */}
      <FilterBar
        filters={[
          {
            key: "module",
            label: "module",
            value: currentModule,
            options: MODULES.map((m) => ({ value: m, label: m })),
            onChange: (v) =>
              navigate(buildQs({ moduleId: v, page: "1" })),
          },
          {
            key: "type",
            label: "type",
            value: currentEventType,
            options: EVENT_TYPES.map((et) => ({ value: et, label: et })),
            onChange: (v) =>
              navigate(buildQs({ eventType: v, page: "1" })),
          },
        ]}
        onClearAll={() =>
          navigate(buildQs({ moduleId: null, eventType: null, page: "1" }))
        }
      />

      {/* Content */}
      <div className="min-h-[400px]">
        {/* Loading */}
        {(showLoading || loading) && (
          <div
            className={
              showLoading
                ? "py-16 text-center"
                : "py-16 text-center invisible"
            }
          >
            <p className="text-sm text-primary">
              {">"} fetching event log...
              <span className="ml-1 animate-pulse">_</span>
            </p>
          </div>
        )}

        {/* Error */}
        {!showLoading && !loading && error && (
          <div className="py-16 text-center">
            <p className="text-sm text-destructive">
              [ERR] connection refused: {error}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4 text-xs"
              onClick={fetchEvents}
            >
              $ retry
            </Button>
          </div>
        )}

        {/* Empty */}
        {!showLoading && !loading && !error && data.length === 0 && (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {">"} /var/log/events: empty. no events captured yet.
            </p>
          </div>
        )}

        {/* Event list */}
        {!showLoading && !loading && !error && data.length > 0 && (
          <div className="animate-content-ready">
            {/* Header */}
            <div className="grid grid-cols-[100px_120px_minmax(100px,1fr)_180px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <span>Module</span>
              <span>Type</span>
              <span>External ID</span>
              <span>Received</span>
            </div>

            <p className="px-3 pt-2 text-xs text-muted-foreground">
              {meta?.total ?? data.length} event
              {(meta?.total ?? data.length) !== 1 ? "s" : ""}
            </p>

            {/* Rows */}
            {data.map((event) => (
              <div key={event.id}>
                <button
                  onClick={() =>
                    setExpandedId(expandedId === event.id ? null : event.id)
                  }
                  className="group grid w-full grid-cols-[100px_120px_minmax(100px,1fr)_180px] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30 text-left"
                >
                  <span className="text-primary text-xs">
                    [{event.moduleId}]
                  </span>
                  <span className="text-foreground text-xs">
                    {event.eventType}
                  </span>
                  <span className="truncate text-muted-foreground text-xs">
                    {event.externalId ?? "--"}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {new Date(event.receivedAt).toLocaleString()}
                  </span>
                </button>

                {/* Expanded payload */}
                {expandedId === event.id && (
                  <div className="border-l-2 border-primary/30 bg-muted/10 ml-3 mb-2 pl-4 py-3">
                    <p className="text-xs text-muted-foreground mb-2">
                      $ cat event/{event.id.slice(0, 8)}/payload.json
                    </p>
                    <pre className="text-xs text-foreground overflow-x-auto max-h-64 overflow-y-auto">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground">
          <span>
            page {meta.page}/{meta.totalPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            disabled={meta.page <= 1}
            onClick={() => goToPage(meta.page - 1)}
          >
            [{"<"} prev]
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            disabled={meta.page >= meta.totalPages}
            onClick={() => goToPage(meta.page + 1)}
          >
            [next {">"}]
          </Button>
        </div>
      )}
    </div>
  );
}
