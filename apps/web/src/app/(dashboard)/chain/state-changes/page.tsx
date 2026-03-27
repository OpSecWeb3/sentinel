"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FilterBar } from "@/components/ui/filter-bar";
import { NavTabs, type NavTab } from "@/components/ui/nav-tabs";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* ── types ───────────────────────────────────────────────────── */

interface StateChange {
  id: string;
  detectionId: string;
  detectionName: string;
  address: string;
  networkName: string;
  explorerUrl: string | null;
  snapshotType: "balance" | "storage" | "view-call";
  label: string | null;
  previousValue: string | null;
  currentValue: string;
  triggered: boolean;
  blockNumber: number | null;
  createdAt: string;
}

interface StateChangesMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface StateChangesResponse {
  data: StateChange[];
  meta: StateChangesMeta;
}

/* ── constants ───────────────────────────────────────────────── */

const SNAPSHOT_TYPES = ["balance", "storage", "view-call"] as const;
const LIMIT = 20;

const CHAIN_TABS: NavTab[] = [
  { href: "/chain", label: "overview" },
  { href: "/chain/networks", label: "networks" },
  { href: "/chain/contracts", label: "contracts" },
  { href: "/chain/rpc", label: "rpc" },
  { href: "/chain/templates", label: "templates" },
  { href: "/chain/events", label: "events" },
  { href: "/chain/state-changes", label: "state-changes" },
];

/* ── helpers ─────────────────────────────────────────────────── */

function truncateAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

const snapshotTypeColor: Record<string, string> = {
  balance: "text-primary",
  storage: "text-warning",
  "view-call": "text-muted-foreground",
};

/* ── page ────────────────────────────────────────────────────── */

export default function StateChangesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentPage = Number(searchParams.get("page") ?? "1");
  const currentType = searchParams.get("type") ?? null;
  const currentDetection = searchParams.get("detectionId") ?? null;
  const currentAddress = searchParams.get("address") ?? null;

  const [data, setData] = useState<StateChange[]>([]);
  const [meta, setMeta] = useState<StateChangesMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const buildQs = useCallback(
    (overrides: Record<string, string | null>) => {
      const params = new URLSearchParams();
      const merged: Record<string, string | null> = {
        page: String(currentPage),
        type: currentType,
        detectionId: currentDetection,
        address: currentAddress,
        ...overrides,
      };
      for (const [k, v] of Object.entries(merged)) {
        if (v !== null && v !== undefined) params.set(k, v);
      }
      return params.toString();
    },
    [currentPage, currentType, currentDetection, currentAddress],
  );

  const fetchStateChanges = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("page", String(currentPage));
      qs.set("limit", String(LIMIT));
      if (currentType) qs.set("type", currentType);
      if (currentDetection) qs.set("detectionId", currentDetection);
      if (currentAddress) qs.set("address", currentAddress);

      const res = await apiFetch<StateChangesResponse>(
        `/modules/chain/state-changes?${qs.toString()}`,
        { credentials: "include" },
      );
      setData(res.data);
      setMeta(res.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [currentPage, currentType, currentDetection, currentAddress]);

  useEffect(() => {
    fetchStateChanges();
  }, [fetchStateChanges]);

  const navigate = (qs: string) =>
    router.push(`/chain/state-changes?${qs}`);


  const goToPage = (page: number) => {
    navigate(buildQs({ page: String(page) }));
  };

  const clearFilters = () => {
    navigate(buildQs({ type: null, detectionId: null, address: null, page: "1" }));
  };

  const hasFilters = !!currentType || !!currentDetection || !!currentAddress;

  // Dynamic command
  const cmdParts = ["$ chain state-changes ls"];
  if (currentType) cmdParts.push(`--type ${currentType}`);
  if (currentDetection) cmdParts.push(`--detection ${currentDetection.slice(0, 8)}`);
  if (currentAddress) cmdParts.push(`--addr ${truncateAddress(currentAddress)}`);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          {cmdParts.join(" ")}
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} on-chain state change snapshots and trigger history
        </p>
      </div>

      {/* Navigation */}
      <NavTabs tabs={CHAIN_TABS} />

      {/* Filters */}
      <FilterBar
        filters={[
          {
            key: "type",
            label: "type",
            value: currentType,
            options: SNAPSHOT_TYPES.map((st) => ({ value: st, label: st })),
            onChange: (v) =>
              navigate(buildQs({ type: v, page: "1" })),
          },
        ]}
        onClearAll={clearFilters}
        hasActiveFilters={hasFilters}
      />

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
              {">"} fetching state change log...
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
              onClick={fetchStateChanges}
            >
              $ retry
            </Button>
          </div>
        )}

        {/* Empty */}
        {!showLoading && !loading && !error && data.length === 0 && (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {">"} /var/log/chain/state-changes: empty. no state changes recorded.
            </p>
          </div>
        )}

        {/* State changes list */}
        {!showLoading && !loading && !error && data.length > 0 && (
          <div className="animate-content-ready">
            {/* Header */}
            <div className="grid grid-cols-[minmax(80px,0.8fr)_80px_minmax(80px,0.6fr)_minmax(100px,1fr)_minmax(100px,1fr)_70px_120px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <span>Address</span>
              <span>Type</span>
              <span>Network</span>
              <span>Value</span>
              <span>Detection</span>
              <span>Triggered</span>
              <span>Time</span>
            </div>

            <p className="px-3 pt-2 text-xs text-muted-foreground">
              {meta?.total ?? data.length} state change
              {(meta?.total ?? data.length) !== 1 ? "s" : ""}
            </p>

            {/* Rows */}
            {data.map((sc) => (
              <div key={sc.id}>
                <button
                  onClick={() =>
                    setExpandedId(
                      expandedId === sc.id ? null : sc.id,
                    )
                  }
                  className="group grid w-full grid-cols-[minmax(80px,0.8fr)_80px_minmax(80px,0.6fr)_minmax(100px,1fr)_minmax(100px,1fr)_70px_120px] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30 text-left"
                >
                  <span className="text-xs truncate">
                    {sc.explorerUrl ? (
                      <a
                        href={`${sc.explorerUrl}/address/${sc.address}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {truncateAddress(sc.address)}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">
                        {truncateAddress(sc.address)}
                      </span>
                    )}
                  </span>

                  <span
                    className={cn(
                      "text-xs font-mono",
                      snapshotTypeColor[sc.snapshotType] ??
                        "text-muted-foreground",
                    )}
                  >
                    [{sc.snapshotType}]
                  </span>

                  <span className="text-xs text-primary">
                    [{sc.networkName}]
                  </span>

                  <span className="text-xs text-foreground truncate">
                    {sc.currentValue}
                  </span>

                  <span className="text-xs text-muted-foreground truncate">
                    <Link
                      href={`/detections/${sc.detectionId}`}
                      className="hover:text-primary transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {sc.detectionName}
                    </Link>
                  </span>

                  <span
                    className={cn(
                      "text-xs font-mono",
                      sc.triggered
                        ? "text-warning"
                        : "text-muted-foreground",
                    )}
                  >
                    {sc.triggered ? "[YES]" : "[no]"}
                  </span>

                  <span className="text-xs text-muted-foreground">
                    {new Date(sc.createdAt).toLocaleString()}
                  </span>
                </button>

                {/* Expanded detail */}
                {expandedId === sc.id && (
                  <div className="border-l-2 border-primary/30 bg-muted/10 ml-3 mb-2 pl-4 py-3 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      $ cat state-change/{sc.id.slice(0, 8)}/detail
                    </p>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">address: </span>
                        <span className="text-foreground break-all">
                          {sc.address}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">network: </span>
                        <span className="text-foreground">
                          {sc.networkName}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">
                          snapshot type:{" "}
                        </span>
                        <span className="text-foreground">
                          {sc.snapshotType}
                        </span>
                      </div>
                      {sc.label && (
                        <div>
                          <span className="text-muted-foreground">
                            label:{" "}
                          </span>
                          <span className="text-foreground">{sc.label}</span>
                        </div>
                      )}
                      {sc.blockNumber && (
                        <div>
                          <span className="text-muted-foreground">
                            block:{" "}
                          </span>
                          <span className="text-primary">
                            #{sc.blockNumber.toLocaleString()}
                          </span>
                        </div>
                      )}
                      <div>
                        <span className="text-muted-foreground">
                          detection:{" "}
                        </span>
                        <Link
                          href={`/detections/${sc.detectionId}`}
                          className="text-primary hover:underline"
                        >
                          {sc.detectionName}
                        </Link>
                      </div>
                    </div>

                    <div className="border-t border-border pt-2 space-y-1">
                      <div className="flex gap-2 text-xs">
                        <span className="text-muted-foreground shrink-0">
                          previous:
                        </span>
                        <span className="text-foreground break-all">
                          {sc.previousValue ?? "(none)"}
                        </span>
                      </div>
                      <div className="flex gap-2 text-xs">
                        <span className="text-muted-foreground shrink-0">
                          current:
                        </span>
                        <span className="text-foreground break-all">
                          {sc.currentValue}
                        </span>
                      </div>
                      <div className="flex gap-2 text-xs">
                        <span className="text-muted-foreground shrink-0">
                          triggered:
                        </span>
                        <span
                          className={
                            sc.triggered
                              ? "text-warning"
                              : "text-muted-foreground"
                          }
                        >
                          {sc.triggered ? "YES - alert fired" : "no"}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
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
