"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api";

/* -- types --------------------------------------------------------- */

interface RawEvent {
  id: string;
  integrationId: string;
  cloudTrailEventId: string;
  eventName: string;
  eventSource: string;
  awsRegion: string;
  principalId: string | null;
  userArn: string | null;
  userType: string | null;
  sourceIpAddress: string | null;
  errorCode: string | null;
  eventTime: string;
  receivedAt: string;
  promoted: boolean;
  platformEventId: string | null;
}

interface EventsMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface EventsResponse {
  data: RawEvent[];
  meta: EventsMeta;
}

/* -- helpers ------------------------------------------------------- */

const PAGE_SIZE = 50;

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function serviceFromSource(source: string): string {
  return source.replace(".amazonaws.com", "");
}

function TreeLine({ last = false }: { last?: boolean }) {
  return (
    <span className="text-muted-foreground/50 select-none">
      {last ? "└── " : "├── "}
    </span>
  );
}

function TreeValue({
  label,
  value,
  last = false,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  last?: boolean;
  valueClassName?: string;
}) {
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

function awsEventDetailRows(event: RawEvent) {
  const rows: { label: string; value: ReactNode; valueClassName?: string }[] = [
    { label: "event_id", value: event.cloudTrailEventId },
    { label: "service", value: event.eventSource },
    { label: "region", value: event.awsRegion },
  ];
  if (event.principalId) {
    rows.push({ label: "principal_id", value: event.principalId });
  }
  if (event.userArn) {
    rows.push({ label: "arn", value: event.userArn });
  }
  if (event.userType) {
    rows.push({ label: "user_type", value: event.userType });
  }
  if (event.sourceIpAddress) {
    rows.push({ label: "source_ip", value: event.sourceIpAddress });
  }
  rows.push(
    { label: "event_time", value: new Date(event.eventTime).toISOString() },
    { label: "received_at", value: new Date(event.receivedAt).toISOString() },
  );
  if (event.errorCode) {
    rows.push({
      label: "error",
      value: event.errorCode,
      valueClassName: "text-warning",
    });
  }
  if (event.promoted && event.platformEventId) {
    rows.push({
      label: "platform_event_id",
      value: event.platformEventId,
      valueClassName: "text-primary",
    });
  }
  return rows;
}

/* -- page ---------------------------------------------------------- */

export default function AwsEventsPage() {
  const [events, setEvents] = useState<RawEvent[]>([]);
  const [meta, setMeta] = useState<EventsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [eventNameFilter, setEventNameFilter] = useState("");

  const fetchEvents = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      if (eventNameFilter) params.set("search", eventNameFilter);

      const res = await apiGet<EventsResponse>(`/modules/aws/events?${params}`);
      setEvents(res.data);
      setMeta(res.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load events");
    } finally {
      setLoading(false);
    }
  }, [page, eventNameFilter]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ aws events ls
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} 7-day cloudtrail event buffer · promoted events appear in /detections
          </p>
        </div>
        <Link href="/aws" className="text-xs text-muted-foreground hover:text-primary transition-colors">
          [back]
        </Link>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted-foreground w-20">--search</span>
        <input
          value={eventNameFilter}
          onChange={(e) => { setEventNameFilter(e.target.value); setPage(1); }}
          placeholder="search events, services, principals, IPs..."
          className="rounded border border-border bg-background px-3 py-1 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary w-56"
        />
        {eventNameFilter && (
          <button
            onClick={() => { setEventNameFilter(""); setPage(1); }}
            className="text-muted-foreground hover:text-foreground"
          >
            [clear]
          </button>
        )}
      </div>

      {/* Content */}
      <div className="min-h-[300px]">
        {showLoading ? (
          <div className="space-y-2">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded border border-border bg-muted/20" />
            ))}
          </div>
        ) : error ? (
          <Card>
            <CardContent className="flex flex-col items-center py-12">
              <p className="text-sm text-destructive">[ERR] {error}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={fetchEvents}>$ retry</Button>
            </CardContent>
          </Card>
        ) : events.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center py-16">
              <p className="text-sm text-muted-foreground">{">"} no events in buffer</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {eventNameFilter ? "Try a different filter." : "Add an integration to start ingesting CloudTrail events."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="animate-content-ready space-y-2">
            {meta && (
              <p className="text-xs text-muted-foreground">
                {meta.total.toLocaleString()} events · page {meta.page} of {meta.totalPages}
              </p>
            )}

            {events.map((event) => {
              const expanded = expandedIds.has(event.id);
              return (
                <div key={event.id} className="rounded border border-border bg-card">
                  <button
                    onClick={() => toggleExpand(event.id)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/20 transition-colors"
                  >
                    <span className="text-xs text-muted-foreground shrink-0">
                      {expanded ? "[-]" : "[+]"}
                    </span>
                    <span className={cn(
                      "text-xs font-mono shrink-0",
                      event.errorCode ? "text-warning" : "text-foreground"
                    )}>
                      {event.eventName}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {serviceFromSource(event.eventSource)}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">{event.awsRegion}</span>
                    {event.principalId && (
                      <span className="text-xs text-muted-foreground truncate min-w-0">
                        {event.principalId}
                      </span>
                    )}
                    {event.errorCode && (
                      <Badge variant="warning" className="shrink-0 text-[10px]">{event.errorCode}</Badge>
                    )}
                    {event.promoted && (
                      <Badge variant="default" className="shrink-0 text-[10px]">[promoted]</Badge>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground shrink-0">
                      {formatTimestamp(event.eventTime)}
                    </span>
                  </button>

                  {expanded && (
                    <div className="border-t border-border px-4 py-3">
                      <div className="rounded-md border border-border bg-card p-4 font-mono text-xs leading-relaxed">
                        <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-primary">
                          CloudTrail event
                        </div>
                        <div className="mb-1 font-bold text-foreground">event/</div>
                        {awsEventDetailRows(event).map((row, i, arr) => (
                          <TreeValue
                            key={`${row.label}-${i}`}
                            label={row.label}
                            value={row.value}
                            last={i === arr.length - 1}
                            valueClassName={row.valueClassName}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Pagination */}
            {meta && meta.totalPages > 1 && (
              <div className="flex items-center justify-between pt-2 text-xs">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
                >
                  [prev]
                </button>
                <span className="text-muted-foreground">
                  {page} / {meta.totalPages}
                </span>
                <button
                  disabled={page >= meta.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
                >
                  [next]
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
