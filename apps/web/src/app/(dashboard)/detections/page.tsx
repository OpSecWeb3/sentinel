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

type DetectionStatus = "active" | "paused" | "error" | "disabled";

interface Detection {
  id: string;
  moduleId: string;
  templateId: string | null;
  name: string;
  description: string | null;
  severity: string;
  status: DetectionStatus;
  cooldownMinutes: number;
  lastTriggeredAt: string | null;
  ruleCount: number;
  createdAt: string;
  updatedAt: string;
}

interface DetectionsMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface DetectionsResponse {
  data: Detection[];
  meta: DetectionsMeta;
}

/* ── helpers ─────────────────────────────────────────────────── */

const statusColor: Record<DetectionStatus, string> = {
  active: "text-primary",
  paused: "text-warning",
  error: "text-destructive",
  disabled: "text-muted-foreground",
};

const statusLabel: Record<DetectionStatus, string> = {
  active: "active",
  paused: "paused",
  error: "error",
  disabled: "archived",
};

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

const PAGE_SIZE = 20;
const MODULES = ["chain", "github", "infra", "registry"];

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

/* ── page ────────────────────────────────────────────────────── */

export default function DetectionsPage() {
  const [detections, setDetections] = useState<Detection[]>([]);
  const [meta, setMeta] = useState<DetectionsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [moduleFilter, setModuleFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>(
    {},
  );
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
  }, [statusFilter, severityFilter, moduleFilter]);

  const hasActiveFilters =
    statusFilter !== "all" ||
    severityFilter !== "all" ||
    moduleFilter !== "all" ||
    debouncedSearch !== "";

  const fetchDetections = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (statusFilter === "archived") params.set("status", "disabled");
      else if (statusFilter !== "all") params.set("status", statusFilter);
      if (severityFilter !== "all") params.set("severity", severityFilter);
      if (moduleFilter !== "all") params.set("moduleId", moduleFilter);
      if (debouncedSearch) params.set("search", debouncedSearch);
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));

      const query = params.toString() ? `?${params.toString()}` : "";
      const res = await apiFetch<DetectionsResponse>(`/api/detections${query}`, {
        credentials: "include",
      });
      setDetections(res.data);
      setMeta(res.meta);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load detections",
      );
    } finally {
      setLoading(false);
    }
  }, [statusFilter, severityFilter, moduleFilter, debouncedSearch, page]);

  useEffect(() => {
    fetchDetections();
  }, [fetchDetections]);

  /* ── actions ───────────────────────────────────────────────── */

  async function toggleStatus(detection: Detection) {
    const newStatus = detection.status === "active" ? "paused" : "active";
    setActionLoading((prev) => ({ ...prev, [detection.id]: true }));
    try {
      await apiFetch(`/api/detections/${detection.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      setDetections((prev) =>
        prev.map((d) =>
          d.id === detection.id ? { ...d, status: newStatus } : d,
        ),
      );
    } catch {
      toast("Failed to update detection status.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [detection.id]: false }));
    }
  }

  async function archiveDetection(detection: Detection) {
    const confirmed = await confirm(
      "Archive Detection",
      `Are you sure you want to archive "${detection.name}"? The detection will be paused and hidden from the default list.`,
    );
    if (!confirmed) return;
    setActionLoading((prev) => ({ ...prev, [detection.id]: true }));
    try {
      await apiFetch(`/api/detections/${detection.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      setDetections((prev) => prev.filter((d) => d.id !== detection.id));
    } catch {
      toast("Failed to archive detection.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [detection.id]: false }));
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
            $ detections ls
            {hasActiveFilters && (
              <span className="text-muted-foreground"> --filter</span>
            )}
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} manage your active threat detections
          </p>
        </div>
        <Button asChild>
          <Link href="/detections/new">+ New Detection</Link>
        </Button>
      </div>

      {/* Search */}
      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="search detections by name..."
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
              { value: "archived", label: "archived" },
            ],
            onChange: (v) => setStatusFilter(v ?? "all"),
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
          {
            key: "module",
            label: "module",
            value: moduleFilter === "all" ? null : moduleFilter,
            options: MODULES.map((m) => ({ value: m, label: m })),
            onChange: (v) => setModuleFilter(v ?? "all"),
          },
        ]}
        onClearAll={() => {
          setStatusFilter("all");
          setSeverityFilter("all");
          setModuleFilter("all");
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
                onClick={fetchDetections}
              >
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : detections.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} no detections found
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {hasActiveFilters
                  ? "try adjusting or clearing your filters"
                  : "get started by creating your first detection"}
              </p>
              {!hasActiveFilters && (
                <Button asChild className="mt-4">
                  <Link href="/detections/new">+ New Detection</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto animate-content-ready">
            <div className="min-w-[700px]">
              <Table>
                <colgroup>
                  <col />
                  <col className="w-24" />
                  <col className="w-24" />
                  <col className="w-24" />
                  <col className="w-16" />
                  <col className="w-28" />
                  <col className="w-[220px]" />
                </colgroup>
                <TableHeader>
                  <TableRow className="border-b border-border hover:bg-transparent">
                    <TableHead scope="col">Name</TableHead>
                    <TableHead scope="col">Module</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col">Severity</TableHead>
                    <TableHead scope="col">Rules</TableHead>
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
                      {meta ? meta.total : detections.length} detection
                      {(meta ? meta.total : detections.length) !== 1 ? "s" : ""}
                      {meta && meta.totalPages > 1
                        ? ` — page ${meta.page} of ${meta.totalPages}`
                        : ""}
                    </TableCell>
                  </TableRow>
                  {detections.map((detection) => {
                    const busy = actionLoading[detection.id] ?? false;

                    return (
                      <TableRow
                        key={detection.id}
                        className="group border border-transparent text-sm transition-colors hover:border-border hover:bg-muted/30"
                      >
                        <TableCell className="max-w-0 font-medium">
                          <Link
                            href={`/detections/${detection.id}`}
                            className="block truncate text-foreground transition-colors group-hover:text-primary"
                          >
                            {detection.name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {detection.moduleId}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "font-mono text-xs",
                            statusColor[detection.status],
                          )}
                        >
                          [{statusLabel[detection.status]}]
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-xs capitalize",
                            severityColor[detection.severity] ??
                              "text-muted-foreground",
                          )}
                        >
                          {detection.severity}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {detection.ruleCount}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(detection.lastTriggeredAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="flex items-center justify-end gap-2 text-xs">
                            {detection.status === "disabled" ? (
                              <Link
                                href={`/detections/${detection.id}`}
                                className="text-muted-foreground transition-colors hover:text-primary"
                              >
                                [view]
                              </Link>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  disabled={busy || detection.status === "error"}
                                  onClick={() => toggleStatus(detection)}
                                  className="text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
                                >
                                  {busy
                                    ? "..."
                                    : detection.status === "active"
                                      ? "[pause]"
                                      : "[resume]"}
                                </button>

                                <Link
                                  href={`/detections/${detection.id}/edit`}
                                  className="text-muted-foreground transition-colors hover:text-primary"
                                >
                                  [edit]
                                </Link>

                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => archiveDetection(detection)}
                                  className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                                >
                                  [archive]
                                </button>
                              </>
                            )}
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
