"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FilterBar } from "@/components/ui/filter-bar";
import { NavTabs, type NavTab } from "@/components/ui/nav-tabs";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* ── types ───────────────────────────────────────────────────── */

interface ChainEvent {
  id: string;
  eventName: string;
  contractAddress: string;
  contractLabel: string | null;
  networkName: string;
  networkSlug: string;
  explorerUrl: string | null;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  decodedArgs: Record<string, unknown> | null;
  rawTopics: string[];
  rawData: string | null;
  createdAt: string;
}

interface EventsMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface EventsResponse {
  data: ChainEvent[];
  meta: EventsMeta;
}

/* ── constants ───────────────────────────────────────────────── */

const EVENT_TYPES = [
  "Transfer",
  "Approval",
  "OwnershipTransferred",
  "Upgraded",
  "Paused",
  "Unpaused",
];

const CHAIN_TABS: NavTab[] = [
  { href: "/chain", label: "overview" },
  { href: "/chain/networks", label: "networks" },
  { href: "/chain/contracts", label: "contracts" },
  { href: "/chain/rpc", label: "rpc" },
  { href: "/chain/templates", label: "templates" },
  { href: "/chain/events", label: "events" },
  { href: "/chain/state-changes", label: "state-changes" },
];

const LIMIT = 20;

/* ── helpers ─────────────────────────────────────────────────── */

function truncateAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function truncateHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-4)}`;
}

/* ── page ────────────────────────────────────────────────────── */

export default function ChainEventsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentPage = Number(searchParams.get("page") ?? "1");
  const currentEventName = searchParams.get("eventName") ?? null;
  const currentNetwork = searchParams.get("network") ?? null;

  const [data, setData] = useState<ChainEvent[]>([]);
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
        eventName: currentEventName,
        network: currentNetwork,
        ...overrides,
      };
      for (const [k, v] of Object.entries(merged)) {
        if (v !== null && v !== undefined) params.set(k, v);
      }
      return params.toString();
    },
    [currentPage, currentEventName, currentNetwork],
  );

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set("moduleId", "chain");
      qs.set("page", String(currentPage));
      qs.set("limit", String(LIMIT));
      if (currentEventName) qs.set("eventName", currentEventName);
      if (currentNetwork) qs.set("network", currentNetwork);

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
  }, [currentPage, currentEventName, currentNetwork]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const navigate = (qs: string) => router.push(`/chain/events?${qs}`);


  const goToPage = (page: number) => {
    navigate(buildQs({ page: String(page) }));
  };

  // Dynamic command
  const cmdParts = ["$ chain events ls"];
  if (currentEventName) cmdParts.push(`--name ${currentEventName}`);
  if (currentNetwork) cmdParts.push(`--network ${currentNetwork}`);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          {cmdParts.join(" ")}
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} on-chain event log from monitored contracts
        </p>
      </div>

      {/* Navigation */}
      <NavTabs tabs={CHAIN_TABS} />

      {/* Filters */}
      <FilterBar
        filters={[
          {
            key: "event",
            label: "event",
            value: currentEventName,
            options: EVENT_TYPES.map((et) => ({ value: et, label: et })),
            onChange: (v) =>
              navigate(buildQs({ eventName: v, page: "1" })),
          },
        ]}
        onClearAll={() =>
          navigate(buildQs({ eventName: null, page: "1" }))
        }
      />

      {/* Content */}
      <div className="min-h-[400px]">
        {/* Loading */}
        {showLoading && (
          <div className="py-16 text-center">
            <p className="text-sm text-primary">
              {">"} fetching on-chain event log...
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
              {">"} /var/log/chain/events: empty. no on-chain events captured yet.
            </p>
          </div>
        )}

        {/* Event list */}
        {!showLoading && !loading && !error && data.length > 0 && (
          <div className="animate-content-ready">
            {/* Header */}
            <div className="grid grid-cols-[minmax(100px,1fr)_minmax(100px,0.8fr)_80px_90px_minmax(80px,0.6fr)_120px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <span>Event</span>
              <span>Contract</span>
              <span>Network</span>
              <span>Block</span>
              <span>Tx Hash</span>
              <span>Time</span>
            </div>

            <p className="px-3 pt-2 text-xs text-muted-foreground">
              {meta?.total ?? data.length} event
              {(meta?.total ?? data.length) !== 1 ? "s" : ""}
            </p>

            {/* Rows */}
            {data.map((event) => (
              <div key={event.id}>
                <button
                  onClick={() =>
                    setExpandedId(
                      expandedId === event.id ? null : event.id,
                    )
                  }
                  className="group grid w-full grid-cols-[minmax(100px,1fr)_minmax(100px,0.8fr)_80px_90px_minmax(80px,0.6fr)_120px] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30 text-left"
                >
                  <span className="text-foreground text-xs font-medium group-hover:text-primary transition-colors">
                    {event.eventName}
                  </span>

                  <span className="text-xs truncate">
                    <span className="text-muted-foreground">
                      {event.contractLabel || truncateAddress(event.contractAddress)}
                    </span>
                  </span>

                  <span className="text-xs text-primary">
                    [{event.networkName}]
                  </span>

                  <span className="text-xs text-muted-foreground">
                    #{event.blockNumber.toLocaleString()}
                  </span>

                  <span className="text-xs truncate">
                    {event.explorerUrl ? (
                      <a
                        href={`${event.explorerUrl}/tx/${event.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {truncateHash(event.txHash)}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">
                        {truncateHash(event.txHash)}
                      </span>
                    )}
                  </span>

                  <span className="text-xs text-muted-foreground">
                    {new Date(event.createdAt).toLocaleString()}
                  </span>
                </button>

                {/* Expanded detail: decoded args */}
                {expandedId === event.id && (
                  <div className="border-l-2 border-primary/30 bg-muted/10 ml-3 mb-2 pl-4 py-3 space-y-3">
                    <p className="text-xs text-muted-foreground">
                      $ cat event/{event.id.slice(0, 8)}/decoded
                    </p>

                    {event.decodedArgs &&
                    Object.keys(event.decodedArgs).length > 0 ? (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground font-medium">
                          decoded args:
                        </p>
                        {Object.entries(event.decodedArgs).map(
                          ([key, val]) => (
                            <div
                              key={key}
                              className="flex gap-2 text-xs"
                            >
                              <span className="text-primary font-medium shrink-0">
                                {key}:
                              </span>
                              <span className="text-foreground break-all">
                                {typeof val === "object"
                                  ? JSON.stringify(val)
                                  : String(val)}
                              </span>
                            </div>
                          ),
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        no decoded args available
                      </p>
                    )}

                    {/* Raw data */}
                    <details>
                      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                        raw log data
                      </summary>
                      <div className="mt-2 space-y-1">
                        <p className="text-xs text-muted-foreground">
                          topics:
                        </p>
                        <pre className="text-xs text-foreground overflow-x-auto">
                          {JSON.stringify(event.rawTopics, null, 2)}
                        </pre>
                        {event.rawData && (
                          <>
                            <p className="text-xs text-muted-foreground mt-1">
                              data:
                            </p>
                            <pre className="text-xs text-foreground overflow-x-auto break-all">
                              {event.rawData}
                            </pre>
                          </>
                        )}
                      </div>
                    </details>

                    {/* Links */}
                    <div className="flex gap-3 text-xs">
                      {event.explorerUrl && (
                        <a
                          href={`${event.explorerUrl}/tx/${event.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          [view on explorer]
                        </a>
                      )}
                      {event.explorerUrl && (
                        <a
                          href={`${event.explorerUrl}/address/${event.contractAddress}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          [view contract]
                        </a>
                      )}
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
