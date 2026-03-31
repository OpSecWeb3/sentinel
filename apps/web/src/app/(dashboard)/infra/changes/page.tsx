"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/* -- types --------------------------------------------------------- */

interface Change {
  id: string;
  hostId: string;
  hostname: string;
  type: string;
  field: string;
  oldValue: string;
  newValue: string;
  severity: string;
  detectedAt: string;
}

/* -- helpers -------------------------------------------------------- */

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  warning: "text-warning",
  info: "text-muted-foreground",
};


const PAGE_SIZE = 25;

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const TYPE_OPTIONS = [
  { value: "all", label: "all types" },
  { value: "dns", label: "dns" },
  { value: "whois", label: "whois" },
  { value: "cert", label: "cert" },
  { value: "infra", label: "infra" },
];

const SEVERITY_OPTIONS = [
  { value: "all", label: "all severities" },
  { value: "critical", label: "critical" },
  { value: "warning", label: "warning" },
  { value: "info", label: "info" },
];

/* -- page ----------------------------------------------------------- */

export default function InfraChangesPage() {
  const [changes, setChanges] = useState<Change[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const { toast, toasts, dismiss } = useToast();

  // Filters
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [hostSearch, setHostSearch] = useState("");

  const fetchChanges = useCallback(
    async (append = false) => {
      if (!append) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", String(append ? offset : 0));
        if (typeFilter !== "all") params.set("type", typeFilter);
        if (severityFilter !== "all") params.set("severity", severityFilter);

        const res = await apiFetch<{ data: Change[] }>(
          `/modules/infra/changes?${params.toString()}`,
          { credentials: "include" },
        );

        if (append) {
          setChanges((prev) => [...prev, ...res.data]);
        } else {
          setChanges(res.data);
        }

        setHasMore(res.data.length === PAGE_SIZE);
        if (!append) {
          setOffset(res.data.length);
        } else {
          setOffset((prev) => prev + res.data.length);
        }
      } catch (err) {
        if (!append) {
          setError(err instanceof Error ? err.message : "Failed to load changes");
        } else {
          toast("Failed to load more changes.");
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [typeFilter, severityFilter, offset, toast],
  );

  // Reset and fetch on filter change
  useEffect(() => {
    setOffset(0);
    setChanges([]);
    setHasMore(true);
  }, [typeFilter, severityFilter]);

  useEffect(() => {
    if (changes.length === 0 && hasMore) {
      fetchChanges(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, severityFilter]);

  // Client-side host search filtering
  const filteredChanges = hostSearch
    ? changes.filter((c) =>
        c.hostname.toLowerCase().includes(hostSearch.toLowerCase()),
      )
    : changes;

  /* -- render ------------------------------------------------------- */

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ infra changes
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} infrastructure change feed
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/infra">{"<"} overview</Link>
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">type</span>
          <Select
            value={typeFilter}
            onValueChange={setTypeFilter}
            options={TYPE_OPTIONS}
            className="w-36"
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">severity</span>
          <Select
            value={severityFilter}
            onValueChange={setSeverityFilter}
            options={SEVERITY_OPTIONS}
            className="w-40"
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">hostname</span>
          <div className="flex items-center gap-2 border-b border-border px-1 py-2 text-sm font-mono focus-within:border-primary transition-colors h-10">
            <span className="text-muted-foreground">{">"}</span>
            <input
              type="text"
              placeholder="filter by hostname..."
              value={hostSearch}
              onChange={(e) => setHostSearch(e.target.value)}
              className="bg-transparent outline-none text-foreground w-40 font-mono text-sm"
            />
          </div>
        </div>

        {(typeFilter !== "all" || severityFilter !== "all" || hostSearch) && (
          <button
            onClick={() => {
              setTypeFilter("all");
              setSeverityFilter("all");
              setHostSearch("");
            }}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors pb-2"
          >
            [clear]
          </button>
        )}
      </div>

      {/* Content */}
      <div className="min-h-[300px]">
        {showLoading ? (
          <div className="border border-border">
            <Table>
              <colgroup>
                <col className="w-[160px]" />
                <col className="w-[180px]" />
                <col className="w-20" />
                <col className="w-[90px]" />
                <col />
              </colgroup>
              <TableHeader>
                <TableRow className="border-b border-border bg-muted/20 hover:bg-muted/20">
                  {["time", "host", "type", "severity", "details"].map((h) => (
                    <TableHead
                      key={h}
                      scope="col"
                      className="px-3 py-2 font-mono text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...Array(8)].map((_, i) => (
                  <TableRow key={i} className="border-b border-border/50 hover:bg-transparent">
                    <TableCell className="px-3 py-2.5">
                      <div className="h-3 w-28 animate-pulse rounded bg-muted" />
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <div className="h-3 w-12 animate-pulse rounded bg-muted" />
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <div className="h-3 w-14 animate-pulse rounded bg-muted" />
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <div className="h-3 w-48 animate-pulse rounded bg-muted" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : error ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-destructive">[ERR] {error}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => fetchChanges(false)}
              >
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : filteredChanges.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">
                {">"} no changes found
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {hostSearch
                  ? "try adjusting your hostname filter"
                  : "no infrastructure changes have been detected yet"}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="animate-content-ready">
            <p className="mb-2 text-xs text-muted-foreground">
              {filteredChanges.length} change{filteredChanges.length !== 1 ? "s" : ""}
              {hostSearch && " (filtered)"}
            </p>

            <div className="border border-border">
              <Table>
                <colgroup>
                  <col className="w-[160px]" />
                  <col className="w-[180px]" />
                  <col className="w-20" />
                  <col className="w-[90px]" />
                  <col />
                </colgroup>
                <TableHeader>
                  <TableRow className="border-b border-border bg-muted/20 hover:bg-muted/20">
                    <TableHead
                      scope="col"
                      className="px-3 py-2 font-mono text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      time
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="px-3 py-2 font-mono text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      host
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="px-3 py-2 font-mono text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      type
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="px-3 py-2 font-mono text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      severity
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="px-3 py-2 font-mono text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      details
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredChanges.map((change, idx) => (
                    <TableRow
                      key={change.id}
                      className={cn(
                        "font-mono text-xs transition-colors hover:bg-muted/20",
                        idx !== filteredChanges.length - 1 && "border-b border-border/50",
                      )}
                    >
                      <TableCell className="shrink-0 px-3 py-2.5 tabular-nums text-muted-foreground">
                        {formatDateTime(change.detectedAt)}
                      </TableCell>
                      <TableCell className="max-w-0 px-3 py-2.5">
                        <Link
                          href={`/infra/hosts/${change.hostId}`}
                          className="block truncate pr-2 text-foreground transition-colors hover:text-primary"
                        >
                          {change.hostname}
                        </Link>
                      </TableCell>
                      <TableCell className="shrink-0 px-3 py-2.5 text-primary">
                        {change.type}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "shrink-0 px-3 py-2.5",
                          severityColor[change.severity] ?? "text-muted-foreground",
                        )}
                      >
                        {change.severity}
                      </TableCell>
                      <TableCell className="min-w-0 px-3 py-2.5">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-muted-foreground">{change.field}:</span>
                          <span className="text-muted-foreground line-through">
                            {change.oldValue || "(none)"}
                          </span>
                          <span className="text-muted-foreground">{"→"}</span>
                          <span
                            className={
                              change.newValue ? "text-foreground" : "text-muted-foreground"
                            }
                          >
                            {change.newValue || "(removed)"}
                          </span>
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>

      {/* Load more */}
      {hasMore && !loading && filteredChanges.length > 0 && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={loadingMore}
            onClick={() => fetchChanges(true)}
          >
            {loadingMore ? "> loading..." : "$ load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
