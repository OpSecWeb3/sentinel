"use client";

import { Fragment, Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { tableRowToggleKeyDown } from "@/lib/table-row-a11y";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* -- types --------------------------------------------------------- */

interface InfraEvent {
  id: string;
  orgId: string;
  moduleId: string;
  eventType: string;
  externalId: string | null;
  payload: Record<string, unknown>;
  receivedAt: string;
  createdAt: string;
  hostname?: string;
  severity?: string;
}

interface EventsMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface EventsResponse {
  data: InfraEvent[];
  meta: EventsMeta;
}

/* -- constants ------------------------------------------------------ */

const EVENT_TYPES = [
  "cert.expiring",
  "cert.expired",
  "cert.renewed",
  "cert.chain.invalid",
  "dns.change",
  "dns.ns.change",
  "dns.spf.change",
  "host.unreachable",
  "host.recovered",
  "host.slow",
  "tls.weak.cipher",
  "tls.deprecated.protocol",
  "header.missing",
  "score.changed",
  "scan.completed",
  "scan.failed",
];

const SEVERITY_LEVELS = ["critical", "high", "medium", "low"];
const LIMIT = 20;

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

const severityTag: Record<string, string> = {
  critical: "[!!]",
  high: "[!]",
  medium: "[~]",
  low: "[--]",
};

const eventTypeColor: Record<string, string> = {
  "cert.expiring": "text-warning",
  "cert.expired": "text-destructive",
  "cert.renewed": "text-primary",
  "cert.chain.invalid": "text-destructive",
  "dns.change": "text-warning",
  "dns.ns.change": "text-destructive",
  "dns.spf.change": "text-warning",
  "host.unreachable": "text-destructive",
  "host.recovered": "text-primary",
  "host.slow": "text-warning",
  "tls.weak.cipher": "text-warning",
  "tls.deprecated.protocol": "text-destructive",
  "header.missing": "text-muted-foreground",
  "score.changed": "text-primary",
  "scan.completed": "text-primary",
  "scan.failed": "text-destructive",
};

/* -- page ----------------------------------------------------------- */

export default function InfraEventsPage() {
  return (
    <Suspense>
      <InfraEventsPageInner />
    </Suspense>
  );
}

function InfraEventsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentPage = Number(searchParams.get("page") ?? "1");
  const currentEventType = searchParams.get("eventType") ?? null;
  const currentSeverity = searchParams.get("severity") ?? null;

  const [data, setData] = useState<InfraEvent[]>([]);
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
        eventType: currentEventType,
        severity: currentSeverity,
        ...overrides,
      };
      for (const [k, v] of Object.entries(merged)) {
        if (v !== null && v !== undefined) params.set(k, v);
      }
      return params.toString();
    },
    [currentPage, currentEventType, currentSeverity],
  );

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("page", String(currentPage));
      qs.set("limit", String(LIMIT));
      qs.set("moduleId", "infra");
      if (currentEventType) qs.set("eventType", currentEventType);
      if (currentSeverity) qs.set("severity", currentSeverity);

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
  }, [currentPage, currentEventType, currentSeverity]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const navigate = (qs: string) => router.push(`/infra/events?${qs}`);

  const toggleEventType = (et: string) => {
    const next = currentEventType === et ? null : et;
    navigate(buildQs({ eventType: next, page: "1" }));
  };

  const toggleSeverity = (sev: string) => {
    const next = currentSeverity === sev ? null : sev;
    navigate(buildQs({ severity: next, page: "1" }));
  };

  const goToPage = (page: number) => {
    navigate(buildQs({ page: String(page) }));
  };

  const hasFilters = currentEventType !== null || currentSeverity !== null;

  // Dynamic command
  const cmdParts = ["$ infra events ls"];
  if (currentEventType) cmdParts.push(`--type ${currentEventType}`);
  if (currentSeverity) cmdParts.push(`--severity ${currentSeverity}`);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            {cmdParts.join(" ")}
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} infrastructure event log (module: infra)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/infra">{"<"} overview</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/events">all events</Link>
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="space-y-1.5 text-xs">
        {/* Severity filter */}
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground w-20">--severity</span>
          <button
            onClick={() =>
              navigate(buildQs({ severity: null, page: "1" }))
            }
            className={cn(
              "transition-colors",
              !currentSeverity
                ? "text-foreground"
                : "text-muted-foreground/60 hover:text-foreground",
            )}
          >
            {!currentSeverity ? "[all]" : "all"}
          </button>
          {SEVERITY_LEVELS.map((sev) => (
            <button
              key={sev}
              onClick={() => toggleSeverity(sev)}
              className={cn(
                "transition-colors",
                currentSeverity === sev
                  ? "text-foreground"
                  : "text-muted-foreground/60 hover:text-foreground",
              )}
            >
              {currentSeverity === sev ? `[${sev}]` : sev}
            </button>
          ))}
        </div>

        {/* Event type filter */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-muted-foreground w-20">--type</span>
          <button
            onClick={() =>
              navigate(buildQs({ eventType: null, page: "1" }))
            }
            className={cn(
              "transition-colors",
              !currentEventType
                ? "text-foreground"
                : "text-muted-foreground/60 hover:text-foreground",
            )}
          >
            {!currentEventType ? "[all]" : "all"}
          </button>
          {EVENT_TYPES.map((et) => (
            <button
              key={et}
              onClick={() => toggleEventType(et)}
              className={cn(
                "transition-colors",
                currentEventType === et
                  ? "text-foreground"
                  : "text-muted-foreground/60 hover:text-foreground",
              )}
            >
              {currentEventType === et ? `[${et}]` : et}
            </button>
          ))}
        </div>

        {hasFilters && (
          <button
            onClick={() =>
              navigate(
                buildQs({
                  eventType: null,
                  severity: null,
                  page: "1",
                }),
              )
            }
            className="text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            [clear all]
          </button>
        )}
      </div>

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
              {">"} fetching infra event log...
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
              {">"} /var/log/infra/events: empty. no events captured yet.
            </p>
            {hasFilters && (
              <p className="mt-1 text-xs text-muted-foreground">
                try adjusting or clearing your filters
              </p>
            )}
          </div>
        )}

        {/* Event list */}
        {!showLoading && !loading && !error && data.length > 0 && (
          <div className="animate-content-ready overflow-x-auto">
            <Table className="min-w-[640px]">
              <colgroup>
                <col className="w-[60px]" />
                <col className="w-[140px]" />
                <col className="w-[120px]" />
                <col />
                <col className="w-[160px]" />
              </colgroup>
              <TableHeader>
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableHead scope="col">Severity</TableHead>
                  <TableHead scope="col">Type</TableHead>
                  <TableHead scope="col">Host</TableHead>
                  <TableHead scope="col">Details</TableHead>
                  <TableHead scope="col">Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow className="border-0 hover:bg-transparent">
                  <TableCell
                    colSpan={5}
                    className="border-0 py-2 text-xs text-muted-foreground"
                  >
                    {meta?.total ?? data.length} event
                    {(meta?.total ?? data.length) !== 1 ? "s" : ""}
                  </TableCell>
                </TableRow>
                {data.map((event) => {
                  const severity =
                    event.severity ??
                    (event.payload.severity as string) ??
                    "low";
                  const hostname =
                    event.hostname ??
                    (event.payload.hostname as string) ??
                    "--";
                  const message =
                    (event.payload.message as string) ??
                    (event.payload.description as string) ??
                    event.eventType;
                  const expanded = expandedId === event.id;
                  const toggle = () =>
                    setExpandedId(expanded ? null : event.id);

                  return (
                    <Fragment key={event.id}>
                      <TableRow
                        role="button"
                        tabIndex={0}
                        aria-expanded={expanded}
                        onClick={toggle}
                        onKeyDown={(e) => tableRowToggleKeyDown(e, toggle)}
                        className="group cursor-pointer border border-transparent text-left text-sm transition-colors hover:border-border hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <TableCell
                          className={cn(
                            "font-mono text-xs",
                            severityColor[severity] ?? "text-muted-foreground",
                          )}
                        >
                          {severityTag[severity] ?? `[${severity}]`}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "font-mono text-xs",
                            eventTypeColor[event.eventType] ?? "text-foreground",
                          )}
                        >
                          {event.eventType}
                        </TableCell>
                        <TableCell className="max-w-0 text-xs text-primary">
                          <span className="block truncate">{hostname}</span>
                        </TableCell>
                        <TableCell className="max-w-0 text-xs text-muted-foreground">
                          <span className="block truncate">{message}</span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(event.receivedAt).toLocaleString()}
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow className="border-0 hover:bg-transparent">
                          <TableCell
                            colSpan={5}
                            className="border-l-2 border-primary/30 bg-muted/10 py-3 pl-4"
                          >
                            <p className="mb-2 text-xs text-muted-foreground">
                              $ cat event/{event.id.slice(0, 8)}/payload.json
                            </p>
                            <pre className="max-h-64 overflow-y-auto overflow-x-auto text-xs text-foreground">
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
