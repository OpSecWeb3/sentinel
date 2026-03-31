"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SearchInput } from "@/components/ui/search-input";
import { FilterBar } from "@/components/ui/filter-bar";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* ── types ───────────────────────────────────────────────────── */

type RuleStatus = "active" | "paused";
type RuleType = "sequence" | "aggregation" | "absence";

interface CorrelationRule {
  id: string;
  name: string;
  description: string | null;
  severity: string;
  status: RuleStatus;
  config: { type: RuleType; steps?: unknown[]; windowMinutes: number };
  channelIds: string[];
  cooldownMinutes: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface ListResponse {
  data: CorrelationRule[];
  meta: ListMeta;
}

/* ── helpers ─────────────────────────────────────────────────── */

const statusColor: Record<RuleStatus, string> = {
  active: "text-primary",
  paused: "text-warning",
};

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

const typeLabel: Record<RuleType, string> = {
  sequence: "sequence",
  aggregation: "aggregation",
  absence: "absence",
};

const PAGE_SIZE = 20;

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
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

function stepsLabel(rule: CorrelationRule): string {
  if (rule.config.type === "sequence" && Array.isArray(rule.config.steps)) {
    return `${rule.config.steps.length} steps`;
  }
  return typeLabel[rule.config.type];
}

/* ── page ────────────────────────────────────────────────────── */

export default function CorrelationsPage() {
  const [rules, setRules] = useState<CorrelationRule[]>([]);
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const { toast, toasts, dismiss } = useToast();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Confirm dialog state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [confirmDesc, setConfirmDesc] = useState("");
  const [confirmResolve, setConfirmResolve] = useState<
    ((value: boolean) => void) | null
  >(null);

  function confirm(title: string, description: string): Promise<boolean> {
    return new Promise((resolve) => {
      setConfirmTitle(title);
      setConfirmDesc(description);
      setConfirmResolve(() => resolve);
      setConfirmOpen(true);
    });
  }

  function handleConfirmClose(result: boolean) {
    setConfirmOpen(false);
    confirmResolve?.(result);
  }

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Reset page on filter change
  useEffect(() => {
    setPage(1);
  }, [statusFilter, typeFilter, severityFilter]);

  const hasActiveFilters =
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    severityFilter !== "all" ||
    debouncedSearch !== "";

  const fetchRules = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (debouncedSearch) params.set("search", debouncedSearch);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));

      const query = params.toString() ? `?${params.toString()}` : "";
      const res = await apiFetch<ListResponse>(
        `/api/correlation-rules${query}`,
        { credentials: "include" },
      );

      // Client-side severity filter (API doesn't support it)
      const filtered =
        severityFilter === "all"
          ? res.data
          : res.data.filter((r) => r.severity === severityFilter);

      setRules(filtered);
      setMeta(res.meta);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load correlation rules",
      );
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter, severityFilter, debouncedSearch, page]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  /* ── actions ───────────────────────────────────────────────── */

  async function toggleStatus(rule: CorrelationRule) {
    const newStatus = rule.status === "active" ? "paused" : "active";
    setActionLoading((prev) => ({ ...prev, [rule.id]: true }));
    try {
      await apiFetch(`/api/correlation-rules/${rule.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      setRules((prev) =>
        prev.map((r) =>
          r.id === rule.id ? { ...r, status: newStatus } : r,
        ),
      );
    } catch {
      toast("Failed to update rule status.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [rule.id]: false }));
    }
  }

  async function deleteRule(rule: CorrelationRule) {
    const confirmed = await confirm(
      "Delete Correlation Rule",
      `Are you sure you want to delete "${rule.name}"? This action cannot be undone.`,
    );
    if (!confirmed) return;
    setActionLoading((prev) => ({ ...prev, [rule.id]: true }));
    try {
      await apiFetch(`/api/correlation-rules/${rule.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
      toast("Correlation rule deleted.");
    } catch {
      toast("Failed to delete correlation rule.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [rule.id]: false }));
    }
  }

  /* ── render ────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />
      <ConfirmDialog
        open={confirmOpen}
        title={confirmTitle}
        description={confirmDesc}
        onClose={handleConfirmClose}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ correlations ls
            {hasActiveFilters && (
              <span className="text-muted-foreground"> --filter</span>
            )}
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} multi-event correlation rules for complex threat detection
          </p>
        </div>
        <Button asChild>
          <Link href="/correlations/new">+ New Rule</Link>
        </Button>
      </div>

      {/* Search */}
      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="search correlation rules by name..."
        inputRef={searchInputRef}
      />

      {/* Filters */}
      <FilterBar
        filters={[
          {
            key: "status",
            label: "status",
            value: statusFilter === "all" ? null : statusFilter,
            options: [
              { value: "active", label: "active" },
              { value: "paused", label: "paused" },
            ],
            onChange: (v) => setStatusFilter(v ?? "all"),
          },
          {
            key: "type",
            label: "type",
            value: typeFilter === "all" ? null : typeFilter,
            options: [
              { value: "sequence", label: "sequence" },
              { value: "aggregation", label: "aggregation" },
              { value: "absence", label: "absence" },
            ],
            onChange: (v) => setTypeFilter(v ?? "all"),
          },
          {
            key: "severity",
            label: "severity",
            value: severityFilter === "all" ? null : severityFilter,
            options: [
              { value: "critical", label: "critical" },
              { value: "high", label: "high" },
              { value: "medium", label: "medium" },
              { value: "low", label: "low" },
            ],
            onChange: (v) => setSeverityFilter(v ?? "all"),
          },
        ]}
        onClearAll={() => {
          setStatusFilter("all");
          setTypeFilter("all");
          setSeverityFilter("all");
          setSearchQuery("");
        }}
        hasActiveFilters={hasActiveFilters}
      />

      {/* Content */}
      <div className="min-h-[300px]">
        {showLoading || loading ? (
          <div className={showLoading ? "space-y-1" : "space-y-1 invisible"}>
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-center gap-x-3 px-3 py-2">
                <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : error ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-destructive">[ERR] {error}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={fetchRules}
              >
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : rules.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} no correlation rules found
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {hasActiveFilters
                  ? "try adjusting or clearing your filters"
                  : "get started by creating your first correlation rule"}
              </p>
              {!hasActiveFilters && (
                <Button asChild className="mt-4">
                  <Link href="/correlations/new">+ New Rule</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto animate-content-ready">
            <div className="min-w-[700px]">
              <Table>
                <colgroup>
                  <col className="w-[180px]" />
                  <col className="w-[90px]" />
                  <col className="w-[70px]" />
                  <col className="w-[70px]" />
                  <col className="w-20" />
                  <col className="w-20" />
                  <col />
                </colgroup>
                <TableHeader>
                  <TableRow className="border-b border-border hover:bg-transparent">
                    <TableHead scope="col">Name</TableHead>
                    <TableHead scope="col">Type</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col">Severity</TableHead>
                    <TableHead scope="col">Window</TableHead>
                    <TableHead scope="col">Last Alert</TableHead>
                    <TableHead scope="col" className="text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="animate-stagger">
                  <TableRow className="border-0 hover:bg-transparent">
                    <TableCell
                      colSpan={7}
                      className="border-0 py-2 text-xs text-muted-foreground"
                    >
                      {meta ? meta.total : rules.length} rule
                      {(meta ? meta.total : rules.length) !== 1 ? "s" : ""}
                      {meta && meta.totalPages > 1
                        ? ` — page ${meta.page} of ${meta.totalPages}`
                        : ""}
                    </TableCell>
                  </TableRow>
                  {rules.map((rule) => {
                    const busy = actionLoading[rule.id] ?? false;

                    return (
                      <TableRow
                        key={rule.id}
                        className="group border border-transparent text-sm transition-colors hover:border-border hover:bg-muted/30"
                      >
                        <TableCell className="max-w-0 font-medium">
                          <Link
                            href={`/correlations/${rule.id}`}
                            className="block truncate text-foreground transition-colors group-hover:text-primary"
                          >
                            {rule.name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {stepsLabel(rule)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "font-mono text-xs",
                            statusColor[rule.status],
                          )}
                        >
                          [{rule.status}]
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-xs capitalize",
                            severityColor[rule.severity] ??
                              "text-muted-foreground",
                          )}
                        >
                          {rule.severity}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {rule.config.windowMinutes}m
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(rule.lastTriggeredAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="flex items-center justify-end gap-2 text-xs">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => toggleStatus(rule)}
                              className="text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
                            >
                              {busy
                                ? "..."
                                : rule.status === "active"
                                  ? "[pause]"
                                  : "[resume]"}
                            </button>

                            <Link
                              href={`/correlations/${rule.id}/edit`}
                              className="text-muted-foreground transition-colors hover:text-primary"
                            >
                              [edit]
                            </Link>

                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => deleteRule(rule)}
                              className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                            >
                              [delete]
                            </button>
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            showing {(meta.page - 1) * PAGE_SIZE + 1}
            {"\u2013"}
            {Math.min(meta.page * PAGE_SIZE, meta.total)} of {meta.total}
          </span>
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="transition-colors hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              [{"<"} prev]
            </button>
            <span className="text-primary font-mono">
              [{meta.page}/{meta.totalPages}]
            </span>
            <button
              disabled={page >= meta.totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="transition-colors hover:text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              [next {">"}]
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
