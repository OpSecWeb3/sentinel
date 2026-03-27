"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
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
};

const NOTIF_COLOR: Record<string, string> = {
  sent: "text-primary",
  pending: "text-warning",
  failed: "text-destructive",
  partial: "text-warning",
};

const MODULES = ["github", "release-chain"];
const LIMIT = 20;

/* ── page ────────────────────────────────────────────────────── */

export default function AlertsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentPage = Number(searchParams.get("page") ?? "1");
  const currentSeverity = (searchParams.get("severity") as Severity | null) ?? null;
  const currentModule = searchParams.get("moduleId") ?? null;
  const currentNotifStatus = searchParams.get("notificationStatus") ?? null;

  const [data, setData] = useState<Alert[]>([]);
  const [meta, setMeta] = useState<AlertsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);

  const buildQs = useCallback(
    (overrides: Record<string, string | null>) => {
      const params = new URLSearchParams();
      const merged: Record<string, string | null> = {
        page: String(currentPage),
        severity: currentSeverity,
        moduleId: currentModule,
        notificationStatus: currentNotifStatus,
        ...overrides,
      };
      for (const [k, v] of Object.entries(merged)) {
        if (v !== null && v !== undefined) params.set(k, v);
      }
      return params.toString();
    },
    [currentPage, currentSeverity, currentModule, currentNotifStatus],
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
  }, [currentPage, currentSeverity, currentModule, currentNotifStatus]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  const navigate = (qs: string) => router.push(`/alerts?${qs}`);

  const goToPage = (page: number) => {
    navigate(buildQs({ page: String(page) }));
  };

  // Dynamic command string
  const cmdParts = ["$   alerts ls"];
  if (currentSeverity) cmdParts.push(`--severity ${currentSeverity}`);
  if (currentModule) cmdParts.push(`--module ${currentModule}`);
  if (currentNotifStatus) cmdParts.push(`--notif ${currentNotifStatus}`);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          {cmdParts.join(" ")}
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} alerts triggered across all detections
        </p>
      </div>

      {/* Filters */}
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
            options: MODULES.map((m) => ({ value: m, label: m })),
            onChange: (v) =>
              navigate(buildQs({ moduleId: v, page: "1" })),
          },
          {
            key: "notif",
            label: "notif",
            value: currentNotifStatus,
            options: ["pending", "sent", "failed", "partial"].map((s) => ({
              value: s,
              label: s,
            })),
            onChange: (v) =>
              navigate(buildQs({ notificationStatus: v, page: "1" })),
          },
        ]}
        onClearAll={() =>
          navigate(
            buildQs({
              severity: null,
              moduleId: null,
              notificationStatus: null,
              page: "1",
            }),
          )
        }
      />

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
              {">"} /var/log/alerts: empty. no alerts to display.
            </p>
          </div>
        )}

        {/* Alert List */}
        {!showLoading && !loading && !error && data.length > 0 && (
          <div className="overflow-x-auto animate-content-ready">
            <div className="min-w-[750px]">
              {/* Header */}
              <div className="grid grid-cols-[60px_minmax(70px,1fr)_100px_180px_100px_90px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Sev</span>
                <span>Detection</span>
                <span>Module</span>
                <span>Time</span>
                <span>Type</span>
                <span className="text-right">Notif</span>
              </div>

              <p className="px-3 pt-2 text-xs text-muted-foreground">
                {meta?.total ?? data.length} alert
                {(meta?.total ?? data.length) !== 1 ? "s" : ""}
              </p>

              {/* Rows */}
              <div className="animate-stagger">
              {data.map((alert) => {
                const sev = alert.severity.toLowerCase();
                return (
                  <Link
                    key={String(alert.id)}
                    href={`/alerts/${alert.id}`}
                    className="group grid grid-cols-[60px_minmax(70px,1fr)_100px_180px_100px_90px] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30"
                  >
                    <span
                      className={cn(
                        "font-mono uppercase",
                        SEVERITY_COLOR[sev] ?? "text-muted-foreground",
                      )}
                    >
                      {SEVERITY_LABEL[sev as Severity] ?? sev}
                    </span>

                    <span className="truncate text-foreground group-hover:text-primary font-medium">
                      {alert.title ?? alert.detectionName ?? "Untitled"}
                    </span>

                    <span className="text-muted-foreground text-xs">
                      {alert.moduleId ?? "--"}
                    </span>

                    <span className="text-muted-foreground text-xs">
                      {new Date(alert.createdAt).toLocaleString()}
                    </span>

                    <span className="text-muted-foreground text-xs">
                      [{alert.triggerType}]
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
