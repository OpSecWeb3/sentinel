"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NavTabs, type NavTab } from "@/components/ui/nav-tabs";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* ── types ─────────────────────────────────────────────────────── */

interface NetworkStatus {
  id: number;
  name: string;
  chainId: number;
  currentBlock: number;
  pollingActive: boolean;
  lastPolledAt: string | null;
}

interface ChainOverviewStats {
  trackedContracts: number;
  activeDetections: number;
  recentAlerts: number;
  totalEvents: number;
}

interface RecentEvent {
  id: string;
  eventName: string;
  contractAddress: string;
  networkName: string;
  blockNumber: number;
  txHash: string;
  createdAt: string;
}

interface ChainOverviewResponse {
  stats: ChainOverviewStats;
  networks: NetworkStatus[];
  recentEvents: RecentEvent[];
}

/* ── helpers ───────────────────────────────────────────────────── */

const CHAIN_TABS: NavTab[] = [
  { href: "/chain", label: "overview" },
  { href: "/chain/networks", label: "networks" },
  { href: "/chain/contracts", label: "contracts" },
  { href: "/chain/rpc", label: "rpc" },
  { href: "/chain/templates", label: "templates" },
  { href: "/chain/events", label: "events" },
  { href: "/chain/state-changes", label: "state-changes" },
];

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

/* ── page ──────────────────────────────────────────────────────── */

export default function ChainOverviewPage() {
  const [data, setData] = useState<ChainOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<ChainOverviewResponse>(
        "/modules/chain/overview",
        { credentials: "include" },
      );
      setData(res);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "failed to fetch chain overview",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  /* ── derived ─────────────────────────────────────────────────── */

  const statEntries = data
    ? [
        { key: "TRACKED_CONTRACTS", value: data.stats.trackedContracts },
        { key: "ACTIVE_DETECTIONS", value: data.stats.activeDetections },
        { key: "RECENT_ALERTS", value: data.stats.recentAlerts },
        { key: "TOTAL_EVENTS", value: data.stats.totalEvents },
      ]
    : [];

  /* ── render ──────────────────────────────────────────────────── */

  return (
    <div className="font-mono space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ chain status
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} on-chain monitoring module overview
        </p>
      </div>

      {/* Navigation */}
      <NavTabs tabs={CHAIN_TABS} />

      {!loading && (error || !data) ? (
        <>
          <p className="text-sm text-destructive">
            [ERR] failed to fetch chain overview
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
              chain module status
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
                : data
                  ? statEntries.map((s) => (
                      <Card key={s.key} className="animate-content-ready">
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

          {/* Network status */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                $ chain networks --status
              </p>
              <Link
                href="/chain/networks"
                className="text-xs text-primary hover:underline"
              >
                manage networks {">"}
              </Link>
            </div>
            <div className="min-h-[80px]">
              {showLoading ? (
                <Card>
                  <CardContent className="p-4 space-y-3 animate-pulse">
                    <div className="h-3 bg-muted-foreground/20 rounded w-full" />
                    <div className="h-3 bg-muted-foreground/20 rounded w-3/4" />
                    <div className="h-3 bg-muted-foreground/20 rounded w-1/2" />
                  </CardContent>
                </Card>
              ) : data && data.networks.length > 0 ? (
                <Card className="animate-content-ready">
                  <CardContent className="p-0">
                    <div className="grid grid-cols-[minmax(120px,1fr)_80px_120px_100px_100px] gap-x-3 border-b border-border px-4 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      <span>Network</span>
                      <span>Chain ID</span>
                      <span>Block Height</span>
                      <span>Polling</span>
                      <span>Last Polled</span>
                    </div>
                    {data.networks.map((net) => (
                      <div
                        key={net.id}
                        className="grid grid-cols-[minmax(120px,1fr)_80px_120px_100px_100px] items-center gap-x-3 border-b border-border px-4 py-2 text-xs last:border-b-0 transition-colors hover:bg-muted/30"
                      >
                        <span className="text-foreground font-medium">
                          {net.name}
                        </span>
                        <span className="text-muted-foreground">
                          {net.chainId}
                        </span>
                        <span className="text-primary">
                          #{net.currentBlock.toLocaleString()}
                        </span>
                        <span
                          className={cn(
                            "font-mono",
                            net.pollingActive
                              ? "text-primary"
                              : "text-muted-foreground",
                          )}
                        >
                          {net.pollingActive ? "[active]" : "[paused]"}
                        </span>
                        <span className="text-muted-foreground">
                          {net.lastPolledAt
                            ? formatDate(net.lastPolledAt)
                            : "--"}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ) : data ? (
                <p className="text-xs text-muted-foreground">
                  {">"} no networks configured yet
                </p>
              ) : null}
            </div>
          </section>

          {/* Recent events feed */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                $ tail -n 10 /var/log/chain/events
              </p>
              <Link
                href="/chain/events"
                className="text-xs text-primary hover:underline"
              >
                all events {">"}
              </Link>
            </div>
            <div className="min-h-[120px]">
              {showLoading ? (
                <div className="space-y-2 animate-pulse">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex gap-3">
                      <div className="h-3 w-16 bg-muted-foreground/20 rounded" />
                      <div className="h-3 w-24 bg-muted-foreground/20 rounded" />
                      <div className="h-3 w-48 bg-muted-foreground/20 rounded" />
                      <div className="h-3 w-20 bg-muted-foreground/20 rounded" />
                    </div>
                  ))}
                </div>
              ) : data && data.recentEvents.length > 0 ? (
                <Card className="animate-content-ready">
                  <CardContent className="p-0">
                    {data.recentEvents.map((event) => (
                      <Link
                        key={event.id}
                        href={`/chain/events?eventId=${event.id}`}
                        className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs transition-colors hover:bg-muted/30 last:border-b-0"
                      >
                        <span className="shrink-0 text-primary font-mono">
                          [{event.networkName}]
                        </span>
                        <span className="text-foreground font-medium truncate">
                          {event.eventName}
                        </span>
                        <span className="text-muted-foreground truncate">
                          {truncateAddress(event.contractAddress)}
                        </span>
                        <span className="text-muted-foreground shrink-0">
                          #{event.blockNumber.toLocaleString()}
                        </span>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {formatDate(event.createdAt)}
                        </span>
                      </Link>
                    ))}
                  </CardContent>
                </Card>
              ) : data ? (
                <p className="text-xs text-muted-foreground">
                  {">"} /var/log/chain/events: empty. no events captured yet.
                </p>
              ) : null}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
