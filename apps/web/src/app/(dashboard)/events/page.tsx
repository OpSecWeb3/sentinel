"use client";

import { Suspense, useCallback, useEffect, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { SearchInput } from "@/components/ui/search-input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  alertCount: number;
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

const MODULE_COLORS: Record<string, string> = {
  chain: "text-yellow-500",
  github: "text-purple-400",
  infra: "text-blue-400",
  "registry": "text-teal-400",
  aws: "text-orange-400",
};

const DATE_PRESETS = [
  { value: "1h", label: "1h", hours: 1 },
  { value: "6h", label: "6h", hours: 6 },
  { value: "24h", label: "24h", hours: 24 },
  { value: "7d", label: "7d", hours: 168 },
  { value: "30d", label: "30d", hours: 720 },
];

const LIMIT = 25;

/* ── helpers ─────────────────────────────────────────────────── */

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

/** Extract a human-readable summary line from event payload */
function payloadSummary(event: Event): string {
  const p = event.payload;
  if (event.moduleId === "chain") {
    const name = (p.eventName as string) ?? "";
    const addr = (p.contractAddress as string) ?? "";
    const tx = (p.transactionHash as string) ?? "";
    if (name && addr) return `${name} on ${addr.slice(0, 10)}...${addr.slice(-4)}`;
    if (tx) return `tx ${tx.slice(0, 14)}...`;
  }
  if (event.externalId) return event.externalId;
  return "--";
}

/* ── page ────────────────────────────────────────────────────── */

export default function EventsPage() {
  return (
    <Suspense>
      <EventsPageInner />
    </Suspense>
  );
}

function EventsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL-driven state
  const currentPage = Number(searchParams.get("page") ?? "1");
  const currentModule = searchParams.get("moduleId") ?? null;
  const currentEventType = searchParams.get("eventType") ?? null;
  const currentSearch = searchParams.get("search") ?? null;
  const currentTimeRange = searchParams.get("range") ?? null;
  // Default to showing only triggered events (ones that generated alerts)
  const currentTriggered = searchParams.get("triggered") !== "false";

  // Data state
  const [data, setData] = useState<Event[]>([]);
  const [meta, setMeta] = useState<EventsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);

  // Dynamic event type options (fetched once from /events/filters)
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [modules, setModules] = useState<string[]>([]);

  // Local search input (debounced)
  const [searchInput, setSearchInput] = useState(currentSearch ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch filter options once on mount
  useEffect(() => {
    apiFetch<{ modules: string[]; eventTypes: string[] }>(
      "/api/events/filters",
      { credentials: "include" },
    ).then((res) => {
      setModules(res.modules);
      setEventTypes(res.eventTypes);
    }).catch(() => {
      // non-critical — filters will just be empty
    });
  }, []);

  const buildQs = useCallback(
    (overrides: Record<string, string | null>) => {
      const params = new URLSearchParams();
      const merged: Record<string, string | null> = {
        page: String(currentPage),
        moduleId: currentModule,
        eventType: currentEventType,
        search: currentSearch,
        range: currentTimeRange,
        triggered: currentTriggered ? null : "false",
        ...overrides,
      };
      for (const [k, v] of Object.entries(merged)) {
        if (v !== null && v !== undefined && v !== "") params.set(k, v);
      }
      return params.toString();
    },
    [currentPage, currentModule, currentEventType, currentSearch, currentTimeRange, currentTriggered],
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
      if (currentSearch) qs.set("search", currentSearch);
      if (currentTriggered) qs.set("triggered", "true");
      if (currentTimeRange) {
        const preset = DATE_PRESETS.find((p) => p.value === currentTimeRange);
        if (preset) {
          qs.set("from", new Date(Date.now() - preset.hours * 3600_000).toISOString());
        }
      }

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
  }, [currentPage, currentModule, currentEventType, currentSearch, currentTimeRange, currentTriggered]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const navigate = (qs: string) => router.push(`/events?${qs}`);

  const goToPage = (page: number) => {
    navigate(buildQs({ page: String(page) }));
  };

  // Debounced search
  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      navigate(buildQs({ search: value || null, page: "1" }));
    }, 400);
  };

  // Sync search input with URL
  useEffect(() => {
    setSearchInput(currentSearch ?? "");
  }, [currentSearch]);

  const activeFilterCount = [currentModule, currentEventType, currentTimeRange, !currentTriggered ? true : null].filter(Boolean).length;

  // Dynamic command
  const cmdParts = ["$  events ls"];
  if (currentTriggered) cmdParts.push("--triggered");
  if (currentSearch) cmdParts.push(`--search "${currentSearch}"`);
  if (currentModule) cmdParts.push(`--module ${currentModule}`);
  if (currentEventType) cmdParts.push(`--type ${currentEventType}`);
  if (currentTimeRange) cmdParts.push(`--since ${currentTimeRange}`);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          {cmdParts.join(" ")}
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} {currentTriggered ? "events that triggered alerts" : "raw events received from modules"}
          {meta && !loading && (
            <span className="text-foreground/70 ml-2">
              [{meta.total} total{activeFilterCount > 0 ? `, ${activeFilterCount} filter${activeFilterCount > 1 ? "s" : ""} active` : ""}]
            </span>
          )}
        </p>
      </div>

      {/* Search + Filters row */}
      <div className="flex flex-col sm:flex-row gap-3">
        <SearchInput
          value={searchInput}
          onChange={handleSearchChange}
          placeholder="search events..."
          className="sm:w-72"
        />
        <button
          onClick={() =>
            navigate(buildQs({ triggered: currentTriggered ? "false" : null, page: "1" }))
          }
          className={cn(
            "shrink-0 h-8 px-3 text-xs font-mono border transition-colors",
            currentTriggered
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {currentTriggered ? "[x] triggered only" : "[ ] triggered only"}
        </button>
        <div className="flex-1">
          <FilterBar
            filters={[
              {
                key: "module",
                label: "module",
                value: currentModule,
                options: modules.map((m) => ({ value: m, label: m })),
                onChange: (v) =>
                  navigate(buildQs({ moduleId: v, page: "1" })),
              },
              {
                key: "type",
                label: "type",
                value: currentEventType,
                options: eventTypes.map((et) => ({ value: et, label: et })),
                onChange: (v) =>
                  navigate(buildQs({ eventType: v, page: "1" })),
              },
              {
                key: "range",
                label: "time",
                value: currentTimeRange,
                allLabel: "all time",
                options: DATE_PRESETS.map((p) => ({
                  value: p.value,
                  label: p.label,
                })),
                onChange: (v) =>
                  navigate(buildQs({ range: v, page: "1" })),
              },
            ]}
            onClearAll={() =>
              navigate(buildQs({ moduleId: null, eventType: null, range: null, search: null, triggered: null, page: "1" }))
            }
          />
        </div>
      </div>

      {/* Content */}
      <div className="min-h-[400px]">
        {/* Loading */}
        {showLoading && (
          <div className="py-16 text-center">
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
              {">"} /var/log/events: empty.
              {(currentSearch || activeFilterCount > 0) ? " no events match current filters." : " no events captured yet."}
            </p>
            {(currentSearch || activeFilterCount > 0) && (
              <Button
                variant="outline"
                size="sm"
                className="mt-4 text-xs"
                onClick={() => navigate("")}
              >
                $ clear filters
              </Button>
            )}
          </div>
        )}

        {/* Event list */}
        {!showLoading && !loading && !error && data.length > 0 && (
          <div className="animate-content-ready overflow-x-auto">
            {/* Fixed: Module 80 + Alerts 60 + Received 100 = 240px; Type & Summary split the rest equally (table-layout: fixed). */}
            <Table className="min-w-[640px]">
              <colgroup>
                <col className="w-[80px]" />
                <col />
                <col />
                <col className="w-[60px]" />
                <col className="w-[100px]" />
              </colgroup>
              <TableHeader>
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableHead scope="col">Module</TableHead>
                  <TableHead scope="col">Type</TableHead>
                  <TableHead scope="col">Summary</TableHead>
                  <TableHead scope="col">Alerts</TableHead>
                  <TableHead scope="col">Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="animate-stagger">
                {data.map((event) => {
                  const open = () => router.push(`/events/${event.id}`);
                  return (
                    <TableRow
                      key={event.id}
                      role="link"
                      tabIndex={0}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open();
                        }
                      }}
                      className="group cursor-pointer border border-transparent text-sm transition-colors hover:border-border hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <TableCell
                        className={cn(
                          "text-xs font-mono",
                          MODULE_COLORS[event.moduleId] ?? "text-primary",
                        )}
                      >
                        [{event.moduleId}]
                      </TableCell>
                      <TableCell className="max-w-0 min-w-0">
                        <span
                          className="block truncate text-xs font-medium text-foreground"
                          title={event.eventType}
                        >
                          {event.eventType}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-0 min-w-0">
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={payloadSummary(event)}
                        >
                          {payloadSummary(event)}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {event.alertCount > 0 ? (
                          <span className="font-mono text-destructive">{event.alertCount}</span>
                        ) : (
                          <span className="text-muted-foreground/40">--</span>
                        )}
                      </TableCell>
                      <TableCell
                        className="text-xs text-muted-foreground"
                        title={new Date(event.receivedAt).toLocaleString()}
                      >
                        {timeAgo(event.receivedAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
          <span>
            {meta.total} event{meta.total !== 1 ? "s" : ""} &middot; page {meta.page}/{meta.totalPages}
          </span>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              disabled={meta.page <= 1}
              onClick={() => goToPage(1)}
            >
              [{"<<"} first]
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              disabled={meta.page <= 1}
              onClick={() => goToPage(meta.page - 1)}
            >
              [{"<"} prev]
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              disabled={meta.page >= meta.totalPages}
              onClick={() => goToPage(meta.page + 1)}
            >
              [next {">"}]
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              disabled={meta.page >= meta.totalPages}
              onClick={() => goToPage(meta.totalPages)}
            >
              [last {">>"}]
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
