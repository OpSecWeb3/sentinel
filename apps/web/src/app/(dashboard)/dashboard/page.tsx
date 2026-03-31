"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { apiFetch } from "@/lib/api";
import { tableRowLinkKeyDown } from "@/lib/table-row-a11y";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
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

/* ── types ─────────────────────────────────────────────────────── */

interface RecentAlert {
  id: number;
  severity: string;
  title: string | null;
  createdAt: string;
  detectionName: string | null;
}

interface StatsResponse {
  total: number;
  today: number;
  thisWeek: number;
  activeDetections: number;
  bySeverity: Record<string, number>;
  recent: RecentAlert[];
}

interface RecentEvent {
  id: string;
  moduleId: string;
  eventType: string;
  externalId: string | null;
  receivedAt: string;
}


interface EventsResponse {
  data: RecentEvent[];
  meta: { total: number };
}

/* ── severity helpers ──────────────────────────────────────────── */

const severityTag: Record<string, string> = {
  critical: "[!!]",
  high: "[!]",
  medium: "[~]",
  low: "[--]",
};

const severityBarColor: Record<string, string> = {
  critical: "bg-destructive",
  high: "bg-warning",
  medium: "bg-primary",
  low: "bg-muted-foreground",
};

const severityTextColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

const severityKeys = ["critical", "high", "medium", "low"] as const;

/* ── page ──────────────────────────────────────────────────────── */

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);

  const [recentEvents, setRecentEvents] = useState<RecentEvent[]>([]);
  const [eventsTotal, setEventsTotal] = useState<number>(0);
  const [eventsLoading, setEventsLoading] = useState(true);
  const showEventsLoading = useDelayedLoading(eventsLoading);


  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<StatsResponse>("/api/alerts/stats", {
        credentials: "include",
      });
      setStats(res);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "failed to fetch dashboard data",
      );
    } finally {
      setLoading(false);
    }
  }, []);


  const fetchRecentEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const res = await apiFetch<EventsResponse>(
        "/api/events?page=1&limit=10&triggered=true",
        { credentials: "include" },
      );
      setRecentEvents(res.data);
      setEventsTotal(res.meta.total);
    } catch {
      // non-critical — dashboard still works without events
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    fetchRecentEvents();
  }, [fetchStats, fetchRecentEvents]);

  /* ── derived data ──────────────────────────────────────────── */

  const statEntries = stats
    ? [
        { key: "ALERTS_TODAY", value: stats.today },
        { key: "ALERTS_THIS_WEEK", value: stats.thisWeek },
        { key: "TOTAL_ALERTS", value: stats.total },
        { key: "ACTIVE_DETECTIONS", value: stats.activeDetections },
      ]
    : [];

  const totalSeverity = stats
    ? severityKeys.reduce((sum, k) => sum + (stats.bySeverity[k] ?? 0), 0)
    : 0;

  /* ── render ────────────────────────────────────────────────── */

  return (
    <div className="font-mono space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ status
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} system overview
        </p>
      </div>

      {!loading && (error || !stats) ? (
        <>
          <p className="text-sm text-destructive">
            [ERR] failed to fetch dashboard data
          </p>
          {error && (
            <p className="text-xs text-muted-foreground">{">"} {error}</p>
          )}
          <Button variant="outline" size="sm" onClick={fetchStats}>
            $ retry
          </Button>
        </>
      ) : (
        <>
          {/* Stats row */}
          <section>
            <p className="mb-3 text-xs text-muted-foreground">system status</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 min-h-[104px] animate-stagger">
              {showLoading
                ? [0, 1, 2, 3].map((i) => (
                    <Card key={i}>
                      <CardContent className="p-4 space-y-3 animate-pulse">
                        <div className="h-3 bg-muted-foreground/20 rounded w-1/3" />
                        <div className="h-8 bg-muted-foreground/20 rounded w-1/2" />
                        <div className="h-3 bg-muted-foreground/20 rounded w-2/3" />
                      </CardContent>
                    </Card>
                  ))
                : stats
                  ? statEntries.map((s) => (
                      <Card key={s.key}>
                        <CardContent className="p-4">
                          <p className="text-xs text-muted-foreground">
                            {s.key}
                          </p>
                          <p className="mt-1 text-2xl font-bold text-primary text-glow">
                            {s.value}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {s.value > 0 ? "[OK]" : "[--]"}
                          </p>
                        </CardContent>
                      </Card>
                    ))
                  : null}
            </div>
          </section>

          {/* Severity breakdown */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                $ alerts summarise
              </p>
              <Link
                href="/alerts"
                className="text-xs text-primary hover:underline"
              >
                view all alerts {">"}
              </Link>
            </div>
            <div className="min-h-[80px]">
              {showLoading ? (
                <Card>
                  <CardContent className="p-4 space-y-3 animate-pulse">
                    <div className="h-3 bg-muted-foreground/20 rounded w-full" />
                    <div className="flex gap-6">
                      {[0, 1, 2, 3].map((i) => (
                        <div
                          key={i}
                          className="h-3 bg-muted-foreground/20 rounded w-16"
                        />
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : stats ? (
                <Card className="animate-content-ready">
                  <CardContent className="p-4 space-y-3">
                    {/* bar */}
                    {totalSeverity > 0 ? (
                      <div className="flex h-3 overflow-hidden border border-border">
                        {severityKeys.map((k) => {
                          const c = stats.bySeverity[k] ?? 0;
                          if (c === 0) return null;
                          const pct = (c / totalSeverity) * 100;
                          return (
                            <div
                              key={k}
                              className={cn(severityBarColor[k])}
                              style={{ width: `${pct}%` }}
                              title={`${k}: ${c}`}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <div className="h-3 border border-border bg-muted/30" />
                    )}

                    {/* text breakdown */}
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                      {severityKeys.map((k) => {
                        const c = stats.bySeverity[k] ?? 0;
                        return (
                          <span key={k} className="text-muted-foreground">
                            {severityTag[k]}{" "}
                            <span className="uppercase">{k}</span>{" "}
                            <span className="text-foreground">{c}</span>
                          </span>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              ) : null}
            </div>
          </section>

          {/* Recent alerts feed */}
          <section>
            <p className="mb-3 text-xs text-muted-foreground">
              $ tail -n 10 /var/log/alerts
            </p>
            <div className="min-h-[120px]">
              {showLoading ? (
                <div className="space-y-2 animate-pulse">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex gap-3">
                      <div className="h-3 w-12 bg-muted-foreground/20 rounded" />
                      <div className="h-3 w-48 bg-muted-foreground/20 rounded" />
                      <div className="h-3 w-32 bg-muted-foreground/20 rounded" />
                    </div>
                  ))}
                </div>
              ) : stats && stats.recent.length > 0 ? (
                <Card className="animate-content-ready">
                  <CardContent className="p-0">
                    <div className="animate-stagger">
                    {stats.recent.map((alert) => (
                      <Link
                        key={alert.id}
                        href={`/alerts/${alert.id}`}
                        className="group flex items-center gap-3 border-b border-border px-4 py-2 text-xs transition-colors hover:bg-muted/30 last:border-b-0"
                      >
                        <span
                          className={cn(
                            "w-12 shrink-0 font-mono uppercase",
                            severityTextColor[alert.severity] ?? "text-muted-foreground",
                          )}
                        >
                          {severityTag[alert.severity] ?? `[${alert.severity}]`}
                        </span>
                        <span className="truncate text-foreground group-hover:text-primary transition-colors">
                          {alert.title ?? alert.detectionName ?? "Untitled alert"}
                        </span>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {new Date(alert.createdAt).toLocaleString()}
                        </span>
                      </Link>
                    ))}
                    </div>
                  </CardContent>
                </Card>
              ) : stats ? (
                <p className="text-xs text-muted-foreground">
                  {">"} /var/log/alerts: empty. no alerts to display.
                </p>
              ) : null}
            </div>
          </section>

          {/* Events summary */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                $ events summarise --triggered
              </p>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {eventsTotal > 0 && (
                  <span>{eventsTotal} total</span>
                )}
                <Link href="/events" className="text-primary hover:underline">
                  all events {">"}
                </Link>
              </div>
            </div>
            <div className="min-h-[80px]">
              {showEventsLoading ? (
                <Card>
                  <CardContent className="p-0">
                    <div className="animate-pulse divide-y divide-border">
                      {[0, 1, 2, 3].map((i) => (
                        <div key={i} className="flex gap-3 px-4 py-2">
                          <div className="h-3 w-16 rounded bg-muted-foreground/20" />
                          <div className="h-3 w-20 rounded bg-muted-foreground/20" />
                          <div className="h-3 w-32 rounded bg-muted-foreground/20" />
                          <div className="ml-auto h-3 w-28 rounded bg-muted-foreground/20" />
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : recentEvents.length > 0 ? (
                <Card className="animate-content-ready overflow-x-auto">
                  <CardContent className="p-0">
                    {/* Fixed: Module 80 + Received 100 = 180px; type & ref split the rest equally (table-layout: fixed). */}
                    <Table className="min-w-[640px]">
                      <colgroup>
                        <col className="w-[80px]" />
                        <col />
                        <col />
                        <col className="w-[100px]" />
                      </colgroup>
                      <TableHeader>
                        <TableRow className="border-b border-border hover:bg-transparent">
                          <TableHead
                            scope="col"
                            className="px-4 py-1.5 text-muted-foreground/60"
                          >
                            module
                          </TableHead>
                          <TableHead
                            scope="col"
                            className="px-4 py-1.5 text-muted-foreground/60"
                          >
                            type
                          </TableHead>
                          <TableHead
                            scope="col"
                            className="px-4 py-1.5 text-muted-foreground/60"
                          >
                            ref
                          </TableHead>
                          <TableHead
                            scope="col"
                            className="px-4 py-1.5 text-muted-foreground/60"
                          >
                            received
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody className="animate-stagger">
                        {recentEvents.map((event) => {
                          const go = () => {
                            router.push("/events");
                          };
                          const refLabel = event.externalId ?? "--";
                          return (
                            <TableRow
                              key={event.id}
                              role="link"
                              tabIndex={0}
                              aria-label="View events"
                              onClick={go}
                              onKeyDown={(e) => tableRowLinkKeyDown(e, go)}
                              className="cursor-pointer border-b border-border text-xs transition-colors last:border-b-0 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              <TableCell className="px-4 py-2 font-mono text-primary">
                                [{event.moduleId}]
                              </TableCell>
                              <TableCell className="max-w-0 min-w-0 px-4 py-2">
                                <span
                                  className="block truncate text-foreground"
                                  title={event.eventType}
                                >
                                  {event.eventType}
                                </span>
                              </TableCell>
                              <TableCell className="max-w-0 min-w-0 px-4 py-2">
                                <span
                                  className="block truncate text-muted-foreground"
                                  title={refLabel}
                                >
                                  {refLabel}
                                </span>
                              </TableCell>
                              <TableCell
                                className="px-4 py-2 text-muted-foreground"
                                title={new Date(event.receivedAt).toLocaleString()}
                              >
                                {new Date(event.receivedAt).toLocaleString()}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              ) : (
                !eventsLoading && (
                  <p className="text-xs text-muted-foreground">
                    {">"} /var/log/events: empty. no events captured yet.
                  </p>
                )
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
