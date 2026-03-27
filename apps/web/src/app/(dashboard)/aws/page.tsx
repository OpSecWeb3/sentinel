"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiGet } from "@/lib/api";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

interface Integration {
  id: string;
  name: string;
  accountId: string;
  status: string;
  lastPolledAt: string | null;
}

interface Overview {
  integrations: number;
  totalEvents: number;
  errorEvents: number;
  recentIntegrations: Integration[];
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
  return `${Math.floor(diffHours / 24)}d ago`;
}

const statusBadge: Record<string, "default" | "destructive" | "secondary"> = {
  active: "default",
  error: "destructive",
  disabled: "secondary",
};

export default function AwsOverviewPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiGet<{ data: Overview }>("/modules/aws/overview");
      setOverview(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load AWS overview");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ aws status
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} cloudtrail ingestion · detection · short-retention events
          </p>
        </div>
        <Link
          href="/aws/integrations"
          className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors"
        >
          [+ add integration]
        </Link>
      </div>

      {/* Stats */}
      {showLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded border border-border bg-muted/20" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-destructive">[ERR] {error}</p>
          </CardContent>
        </Card>
      ) : overview ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground font-mono">integrations</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-foreground">{overview.integrations}</p>
                <p className="text-xs text-muted-foreground">AWS accounts</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground font-mono">total events</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-foreground">{overview.totalEvents.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">in 7-day buffer</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground font-mono">error events</CardTitle>
              </CardHeader>
              <CardContent>
                <p className={`text-2xl font-bold ${overview.errorEvents > 0 ? "text-warning" : "text-foreground"}`}>
                  {overview.errorEvents.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">access denied / failed calls</p>
              </CardContent>
            </Card>
          </div>

          {/* Recent integrations */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs text-muted-foreground font-mono">recent integrations</p>
              <Link href="/aws/integrations" className="text-xs text-muted-foreground hover:text-primary transition-colors">
                [view all]
              </Link>
            </div>

            {overview.recentIntegrations.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-sm text-muted-foreground">{">"} no integrations configured</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add an AWS account to start ingesting CloudTrail events.
                  </p>
                  <Link
                    href="/aws/integrations"
                    className="mt-4 inline-block text-xs text-primary hover:underline"
                  >
                    [+ add integration]
                  </Link>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {overview.recentIntegrations.map((i) => (
                  <Link
                    key={i.id}
                    href={`/aws/integrations`}
                    className="flex items-center justify-between rounded border border-border bg-card px-4 py-3 text-sm hover:border-primary/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground font-mono">{"\u2514\u2500\u2500"}</span>
                      <span className="text-foreground font-mono">{i.name}</span>
                      <span className="text-xs text-muted-foreground">[{i.accountId}]</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {i.lastPolledAt && (
                        <span>polled {formatTimestamp(i.lastPolledAt)}</span>
                      )}
                      <Badge variant={statusBadge[i.status] ?? "secondary"}>
                        [{i.status}]
                      </Badge>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Quick links */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { href: "/aws/integrations", label: "integrations", desc: "manage AWS accounts" },
              { href: "/aws/events", label: "events", desc: "raw cloudtrail buffer" },
              { href: "/aws/templates", label: "templates", desc: "detection templates" },
              { href: "/detections", label: "detections", desc: "active rules" },
            ].map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded border border-border bg-card px-4 py-3 hover:border-primary/50 transition-colors"
              >
                <p className="text-xs font-mono text-primary">{link.label}/</p>
                <p className="mt-1 text-xs text-muted-foreground">{link.desc}</p>
              </Link>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
