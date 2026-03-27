"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NavTabs, type NavTab } from "@/components/ui/nav-tabs";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* ── types ─────────────────────────────────────────────────────── */

interface DetectionRule {
  id: string;
  ruleType: string;
  config: Record<string, unknown>;
  status: string;
  priority: number;
}

interface DetectionDetail {
  id: string;
  name: string;
  description: string | null;
  severity: string;
  status: string;
  cooldownMinutes: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  rules: DetectionRule[];
}

interface DetectionDetailResponse {
  data: DetectionDetail;
}

/* ── helpers ───────────────────────────────────────────────────── */

const CHAIN_TABS: NavTab[] = [
  { href: "/chain", label: "overview" },
  { href: "/chain/networks", label: "networks" },
  { href: "/chain/contracts", label: "contracts" },
  { href: "/chain/detections", label: "detections" },
  { href: "/chain/rpc", label: "rpc" },
  { href: "/chain/templates", label: "templates" },
  { href: "/chain/events", label: "events" },
  { href: "/chain/state-changes", label: "state-changes" },
];

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

function formatDate(iso: string): string {
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
  return d.toLocaleDateString();
}

function truncateAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/* ── page ──────────────────────────────────────────────────────── */

export default function ChainDetectionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [detection, setDetection] = useState<DetectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);

  const fetchDetection = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<DetectionDetailResponse>(
        `/modules/chain/detections/${id}`,
        { credentials: "include" },
      );
      setDetection(res.data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "failed to fetch detection",
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDetection();
  }, [fetchDetection]);

  /* ── render ──────────────────────────────────────────────────── */

  return (
    <div className="space-y-8 font-mono">
      {/* Back link */}
      <Link
        href="/chain/detections"
        className="text-xs text-muted-foreground hover:text-primary transition-colors"
      >
        {"<"} detections
      </Link>

      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ chain detect{" "}
          {showLoading ? (
            <span className="text-muted-foreground">...</span>
          ) : detection ? (
            <span>{detection.name}</span>
          ) : (
            <span className="text-muted-foreground">{id}</span>
          )}
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} detection rule details
        </p>
      </div>

      {/* Navigation */}
      <NavTabs tabs={CHAIN_TABS} />

      {/* Content */}
      {showLoading || loading ? (
        <div
          className={
            showLoading ? "space-y-4" : "space-y-4 invisible"
          }
        >
          <Card>
            <CardContent className="p-4 space-y-3 animate-pulse">
              <div className="h-3 w-48 bg-muted-foreground/20 rounded" />
              <div className="h-3 w-32 bg-muted-foreground/20 rounded" />
              <div className="h-3 w-64 bg-muted-foreground/20 rounded" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 space-y-3 animate-pulse">
              <div className="h-3 w-36 bg-muted-foreground/20 rounded" />
              <div className="h-3 w-full bg-muted-foreground/20 rounded" />
              <div className="h-3 w-3/4 bg-muted-foreground/20 rounded" />
            </CardContent>
          </Card>
        </div>
      ) : error ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive">[ERR] {error}</p>
          <Button variant="outline" size="sm" onClick={fetchDetection}>
            $ retry
          </Button>
        </div>
      ) : detection ? (
        <div className="space-y-6 animate-content-ready">
          {/* Metadata */}
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-3">
                $ chain detect {detection.name} --info
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-xs">
                <div>
                  <p className="text-muted-foreground">severity</p>
                  <p
                    className={cn(
                      "font-mono mt-0.5",
                      severityColor[detection.severity] ??
                        "text-foreground",
                    )}
                  >
                    {severityTag[detection.severity] ??
                      `[${detection.severity}]`}
                    {" "}
                    {detection.severity}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">status</p>
                  <p
                    className={cn(
                      "font-mono mt-0.5",
                      detection.status === "active"
                        ? "text-primary"
                        : "text-muted-foreground",
                    )}
                  >
                    {detection.status === "active"
                      ? "[active]"
                      : "[paused]"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">cooldown</p>
                  <p className="text-foreground mt-0.5">
                    {detection.cooldownMinutes === 0
                      ? "none"
                      : `${detection.cooldownMinutes}m`}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">created</p>
                  <p className="text-foreground mt-0.5">
                    {formatDate(detection.createdAt)}
                  </p>
                </div>
                {detection.lastTriggeredAt && (
                  <div>
                    <p className="text-muted-foreground">last triggered</p>
                    <p className="text-foreground mt-0.5">
                      {formatDate(detection.lastTriggeredAt)}
                    </p>
                  </div>
                )}
                {detection.description && (
                  <div className="sm:col-span-2 lg:col-span-4">
                    <p className="text-muted-foreground">description</p>
                    <p className="text-foreground mt-0.5">
                      {detection.description}
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Rules */}
          <section>
            <p className="mb-3 text-xs text-muted-foreground">
              $ chain detect {detection.name} --rules (
              {detection.rules.length})
            </p>
            {detection.rules.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {">"} no rules configured
              </p>
            ) : (
              <div className="space-y-3">
                {detection.rules.map((rule, idx) => {
                  const configEntries = Object.entries(rule.config).filter(
                    ([, v]) => v !== undefined && v !== null && v !== "",
                  );
                  const networkSlug =
                    typeof rule.config.networkSlug === "string"
                      ? rule.config.networkSlug
                      : null;
                  const contractAddress =
                    typeof rule.config.contractAddress === "string"
                      ? rule.config.contractAddress
                      : null;

                  return (
                    <Card key={rule.id ?? idx}>
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-mono text-primary">
                            [{rule.ruleType}]
                          </p>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span>priority: {rule.priority}</span>
                            <span
                              className={cn(
                                "font-mono",
                                rule.status === "active"
                                  ? "text-primary"
                                  : "text-muted-foreground",
                              )}
                            >
                              {rule.status === "active"
                                ? "[active]"
                                : `[${rule.status}]`}
                            </span>
                          </div>
                        </div>

                        {/* Network / contract quick view */}
                        {(networkSlug || contractAddress) && (
                          <div className="flex items-center gap-4 text-xs">
                            {networkSlug && (
                              <span>
                                <span className="text-muted-foreground">
                                  network:{" "}
                                </span>
                                <span className="text-primary font-mono">
                                  [{networkSlug}]
                                </span>
                              </span>
                            )}
                            {contractAddress && (
                              <span>
                                <span className="text-muted-foreground">
                                  contract:{" "}
                                </span>
                                <span className="text-foreground font-mono">
                                  {truncateAddress(contractAddress)}
                                </span>
                              </span>
                            )}
                          </div>
                        )}

                        {/* Full config key-value */}
                        <div className="space-y-0.5">
                          {configEntries.map(([key, value]) => (
                            <div
                              key={key}
                              className="flex gap-2 text-xs flex-wrap"
                            >
                              <span className="text-muted-foreground shrink-0">
                                {key}:
                              </span>
                              <span className="text-foreground font-mono break-all">
                                {typeof value === "object"
                                  ? JSON.stringify(value)
                                  : String(value)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
