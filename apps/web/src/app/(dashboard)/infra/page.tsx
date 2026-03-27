"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* -- types --------------------------------------------------------- */

interface InfraStats {
  hostCount: number;
  averageScore: number;
  expiringCerts: number;
  recentScans: number;
  gradeDistribution: Record<string, number>;
}

interface InfraAlert {
  id: string;
  type: string;
  hostname: string;
  severity: string;
  message: string;
  createdAt: string;
}

interface InfraOverviewResponse {
  stats: InfraStats;
  recentAlerts: InfraAlert[];
}

/* -- helpers -------------------------------------------------------- */

const gradeColors: Record<string, string> = {
  A: "bg-primary",
  B: "bg-primary/70",
  C: "bg-warning",
  D: "bg-warning/70",
  F: "bg-destructive",
};

const gradeTextColors: Record<string, string> = {
  A: "text-primary",
  B: "text-primary/70",
  C: "text-warning",
  D: "text-warning/70",
  F: "text-destructive",
};

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

const GRADES = ["A", "B", "C", "D", "F"] as const;

/* -- page ----------------------------------------------------------- */

export default function InfraOverviewPage() {
  const [data, setData] = useState<InfraOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<InfraOverviewResponse>(
        "/modules/infra/overview",
        { credentials: "include" },
      );
      setData(res);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load infra overview",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  const stats = data?.stats;
  const totalGraded = stats
    ? GRADES.reduce((sum, g) => sum + (stats.gradeDistribution[g] ?? 0), 0)
    : 0;

  const statEntries = stats
    ? [
        { key: "HOSTS", value: stats.hostCount },
        { key: "AVG_SCORE", value: stats.averageScore },
        { key: "EXPIRING_CERTS", value: stats.expiringCerts },
        { key: "RECENT_SCANS", value: stats.recentScans },
      ]
    : [];

  return (
    <div className="font-mono space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ infra status
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} infrastructure monitoring overview
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/infra/hosts">hosts/</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/infra/cdn-providers">cdn-providers/</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/infra/changes">changes/</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/infra/worldview">worldview/</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/infra/templates">templates/</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/infra/events">events/</Link>
          </Button>
        </div>
      </div>

      {!loading && (error || !data) ? (
        <>
          <p className="text-sm text-destructive">
            [ERR] failed to fetch infra overview
          </p>
          {error && (
            <p className="text-xs text-muted-foreground">{">"} {error}</p>
          )}
          <Button variant="outline" size="sm" onClick={fetchOverview}>
            $ retry
          </Button>
        </>
      ) : (
        <>
          {/* Stats row */}
          <section>
            <p className="mb-3 text-xs text-muted-foreground">
              infrastructure status
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 min-h-[104px]">
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
                      <Card key={s.key} className="animate-content-ready">
                        <CardContent className="p-4">
                          <p className="text-xs text-muted-foreground">
                            {s.key}
                          </p>
                          <p className="mt-1 text-2xl font-bold text-primary text-glow">
                            {s.key === "AVG_SCORE"
                              ? `${s.value}/100`
                              : s.value}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {s.key === "EXPIRING_CERTS" && s.value > 0
                              ? "[!!] action required"
                              : "[OK]"}
                          </p>
                        </CardContent>
                      </Card>
                    ))
                  : null}
            </div>
          </section>

          {/* Grade distribution */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                $ infra grades --distribution
              </p>
              <Link
                href="/infra/hosts"
                className="text-xs text-primary hover:underline"
              >
                view all hosts {">"}
              </Link>
            </div>
            <div className="min-h-[80px]">
              {showLoading ? (
                <Card>
                  <CardContent className="p-4 space-y-3 animate-pulse">
                    <div className="h-3 bg-muted-foreground/20 rounded w-full" />
                    <div className="flex gap-6">
                      {[0, 1, 2, 3, 4].map((i) => (
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
                    {totalGraded > 0 ? (
                      <div className="flex h-3 overflow-hidden border border-border">
                        {GRADES.map((g) => {
                          const c = stats.gradeDistribution[g] ?? 0;
                          if (c === 0) return null;
                          const pct = (c / totalGraded) * 100;
                          return (
                            <div
                              key={g}
                              className={cn(gradeColors[g])}
                              style={{ width: `${pct}%` }}
                              title={`${g}: ${c} hosts`}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <div className="h-3 border border-border bg-muted/30" />
                    )}

                    {/* text breakdown */}
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                      {GRADES.map((g) => {
                        const c = stats.gradeDistribution[g] ?? 0;
                        return (
                          <span key={g} className="text-muted-foreground">
                            <span className={gradeTextColors[g]}>[{g}]</span>{" "}
                            <span className="text-foreground">{c}</span>{" "}
                            host{c !== 1 ? "s" : ""}
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
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                $ tail -n 10 /var/log/infra/alerts
              </p>
              <Link
                href="/infra/events"
                className="text-xs text-primary hover:underline"
              >
                view all events {">"}
              </Link>
            </div>
            <div className="min-h-[120px]">
              {showLoading ? (
                <div className="space-y-2 animate-pulse">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex gap-3">
                      <div className="h-3 w-12 bg-muted-foreground/20 rounded" />
                      <div className="h-3 w-32 bg-muted-foreground/20 rounded" />
                      <div className="h-3 w-48 bg-muted-foreground/20 rounded" />
                    </div>
                  ))}
                </div>
              ) : data && data.recentAlerts.length > 0 ? (
                <Card className="animate-content-ready">
                  <CardContent className="p-0">
                    {data.recentAlerts.map((alert) => (
                      <div
                        key={alert.id}
                        className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs last:border-b-0"
                      >
                        <span
                          className={cn(
                            "w-8 shrink-0 font-mono",
                            severityColor[alert.severity] ??
                              "text-muted-foreground",
                          )}
                        >
                          {severityTag[alert.severity] ?? `[${alert.severity}]`}
                        </span>
                        <span className="text-primary shrink-0">
                          [{alert.type}]
                        </span>
                        <span className="text-foreground shrink-0">
                          {alert.hostname}
                        </span>
                        <span className="truncate text-muted-foreground">
                          {alert.message}
                        </span>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {new Date(alert.createdAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ) : data ? (
                <p className="text-xs text-muted-foreground">
                  {">"} /var/log/infra/alerts: empty. no recent alerts.
                </p>
              ) : null}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
