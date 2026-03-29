"use client";

import { Suspense, useCallback, useEffect, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { SearchInput } from "@/components/ui/search-input";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* ── types ───────────────────────────────────────────────────── */

type Severity = "critical" | "high" | "medium" | "low";

interface Alert {
  id: number;
  detectionId: string;
  severity: string;
  title: string | null;
  description: string | null;
  triggerType: string;
  notificationStatus: string;
  createdAt: string;
  detectionName: string | null;
  moduleId: string | null;
}

interface AlertsMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface AlertsResponse {
  data: Alert[];
  meta: AlertsMeta;
}

interface Detection {
  id: string;
  name: string;
  moduleId: string;
}

/* ── constants ───────────────────────────────────────────────── */

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED",
  low: "LOW",
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

const NOTIF_LABEL: Record<string, string> = {
  sent: "[sent]",
  pending: "[pending]",
  failed: "[fail]",
  partial: "[partial]",
  no_channels: "[--]",
};

const NOTIF_COLOR: Record<string, string> = {
  sent: "text-primary",
  pending: "text-warning",
  failed: "text-destructive",
  partial: "text-warning",
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

/* ── page ────────────────────────────────────────────────────── */

export default function AlertsPage() {
  return (
    <Suspense>
      <AlertsPageInner />
    </Suspense>
  );
}

function AlertsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL-driven state
  const currentPage = Number(searchParams.get("page") ?? "1");
  const currentSeverity = (searchParams.get("severity") as Severity | null) ?? null;
  const currentModule = searchParams.get("moduleId") ?? null;
  const currentNotifStatus = searchParams.get("notificationStatus") ?? null;
  const currentDetectionId = searchParams.get("detectionId") ?? null;
  const currentSearch = searchParams.get("search") ?? null;
  const currentTimeRange = searchParams.get("range") ?? null;

  // Data state
  const [data, setData] = useState<Alert[]>([]);
  const [meta, setMeta] = useState<AlertsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);

  // Dynamic filter options loaded from detections
  const [detections, setDetections] = useState<Detection[]>([]);
  const [modules, setModules] = useState<string[]>([]);

  // Local search input (debounced)
  const [searchInput, setSearchInput] = useState(currentSearch ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load detection list for filter dropdown
  useEffect(() => {
    apiFetch<{ data: Detection[] }>("/api/detections?limit=100", { credentials: "include" })
      .then((res) => {
        setDetections(res.data);
        const mods = [...new Set(res.data.map((d) => d.moduleId))].sort();
        setModules(mods);
      })
      .catch(() => {});
  }, []);

  const buildQs = useCallback(
    (overrides: Record<string, string | null>) => {
      const params = new URLSearchParams();
      const merged: Record<string, string | null> = {
        page: String(currentPage),
        severity: currentSeverity,
        moduleId: currentModule,
        notificationStatus: currentNotifStatus,
        detectionId: currentDetectionId,
        search: currentSearch,
        range: currentTimeRange,
        ...overrides,
      };
      for (const [k, v] of Object.entries(merged)) {
        if (v !== null && v !== undefined && v !== "") params.set(k, v);
      }
      return params.toString();
    },
    [currentPage, currentSeverity, currentModule, currentNotifStatus, currentDetectionId, currentSearch, currentTimeRange],
  );

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("page", String(currentPage));
      qs.set("limit", String(LIMIT));
      if (currentSeverity) qs.set("severity", currentSeverity);
      if (currentModule) qs.set("moduleId", currentModule);
      if (currentNotifStatus) qs.set("notificationStatus", currentNotifStatus);
      if (currentDetectionId) qs.set("detectionId", currentDetectionId);
      if (currentSearch) qs.set("search", currentSearch);
      if (currentTimeRange) {
        const preset = DATE_PRESETS.find((p) => p.value === currentTimeRange);
        if (preset) {
          qs.set("from", new Date(Date.now() - preset.hours * 3600_000).toISOString());
        }
      }

      const res = await apiFetch<AlertsResponse>(
        `/api/alerts?${qs.toString()}`,
        { credentials: "include" },
      );
      setData(res.data);
      setMeta(res.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [currentPage, currentSeverity, currentModule, currentNotifStatus, currentDetectionId, currentSearch, currentTimeRange]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  const navigate = (qs: string) => router.push(`/alerts?${qs}`);

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

  // Active filter count for badge
  const activeFilterCount = [currentSeverity, currentModule, currentNotifStatus, currentDetectionId, currentTimeRange].filter(Boolean).length;

  // Dynamic command string
  const cmdParts = ["$  alerts ls"];
  if (currentSearch) cmdParts.push(`--search "${currentSearch}"`);
  if (currentSeverity) cmdParts.push(`--severity ${currentSeverity}`);
  if (currentModule) cmdParts.push(`--module ${currentModule}`);
  if (currentDetectionId) {
    const det = detections.find((d) => d.id === currentDetectionId);
    cmdParts.push(`--detection "${det?.name ?? currentDetectionId.slice(0, 8)}"`);
  }
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
          {">"} alerts triggered across all detections
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
          placeholder="search alerts..."
          className="sm:w-72"
        />
        <div className="flex-1">
          <FilterBar
            filters={[
              {
                key: "severity",
                label: "severity",
                value: currentSeverity,
                options: SEVERITIES.map((s) => ({
                  value: s,
                  label: SEVERITY_LABEL[s],
                })),
                onChange: (v) =>
                  navigate(buildQs({ severity: v, page: "1" })),
              },
              {
                key: "module",
                label: "module",
                value: currentModule,
                options: modules.map((m) => ({ value: m, label: m })),
                onChange: (v) =>
                  navigate(buildQs({ moduleId: v, page: "1" })),
              },
              {
                key: "detection",
                label: "detection",
                value: currentDetectionId,
                options: detections.map((d) => ({
                  value: d.id,
                  label: d.name.length > 30 ? d.name.slice(0, 28) + "..." : d.name,
                })),
                onChange: (v) =>
                  navigate(buildQs({ detectionId: v, page: "1" })),
              },
              {
                key: "notif",
                label: "notif",
                value: currentNotifStatus,
                options: ["pending", "sent", "failed", "partial", "no_channels"].map((s) => ({
                  value: s,
                  label: s,
                })),
                onChange: (v) =>
                  navigate(buildQs({ notificationStatus: v, page: "1" })),
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
              navigate(
                buildQs({
                  severity: null,
                  moduleId: null,
                  notificationStatus: null,
                  detectionId: null,
                  range: null,
                  search: null,
                  page: "1",
                }),
              )
            }
          />
        </div>
      </div>

      {/* Content area */}
      <div className="min-h-[400px]">
        {/* Loading */}
        {showLoading && (
          <div className="py-16 text-center">
            <p className="text-sm text-primary">
              {">"} fetching alert log...
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
              onClick={fetchAlerts}
            >
              $ retry
            </Button>
          </div>
        )}

        {/* Empty */}
        {!showLoading && !loading && !error && data.length === 0 && (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {">"} /var/log/alerts: empty.
              {(currentSearch || activeFilterCount > 0) ? " no alerts match current filters." : " no alerts to display."}
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

        {/* Alert List */}
        {!showLoading && !loading && !error && data.length > 0 && (
          <div className="overflow-x-auto animate-content-ready">
            <div className="min-w-[800px]">
              {/* Header */}
              <div className="grid grid-cols-[50px_minmax(100px,2fr)_minmax(80px,1fr)_100px_120px_80px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Sev</span>
                <span>Title</span>
                <span>Detection</span>
                <span>Module</span>
                <span>Time</span>
                <span className="text-right">Notif</span>
              </div>

              {/* Rows */}
              <div className="animate-stagger">
                {data.map((alert) => {
                  const sev = alert.severity.toLowerCase();
                  return (
                    <Link
                      key={String(alert.id)}
                      href={`/alerts/${alert.id}`}
                      className="group grid grid-cols-[50px_minmax(100px,2fr)_minmax(80px,1fr)_100px_120px_80px] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30"
                    >
                      <span
                        className={cn(
                          "font-mono text-xs uppercase",
                          SEVERITY_COLOR[sev] ?? "text-muted-foreground",
                        )}
                      >
                        {SEVERITY_LABEL[sev as Severity] ?? sev}
                      </span>

                      <span className="truncate text-foreground group-hover:text-primary font-medium text-xs">
                        {alert.title ?? "Untitled"}
                      </span>

                      <span className="truncate text-muted-foreground text-xs">
                        {alert.detectionName ?? "--"}
                      </span>

                      <span className="text-muted-foreground text-xs">
                        {alert.moduleId ?? "--"}
                      </span>

                      <span className="text-muted-foreground text-xs" title={new Date(alert.createdAt).toLocaleString()}>
                        {timeAgo(alert.createdAt)}
                      </span>

                      <span
                        className={cn(
                          "text-right text-xs",
                          NOTIF_COLOR[alert.notificationStatus] ??
                            "text-muted-foreground",
                        )}
                      >
                        {NOTIF_LABEL[alert.notificationStatus] ??
                          `[${alert.notificationStatus}]`}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
          <span>
            {meta.total} alert{meta.total !== 1 ? "s" : ""} &middot; page {meta.page}/{meta.totalPages}
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
