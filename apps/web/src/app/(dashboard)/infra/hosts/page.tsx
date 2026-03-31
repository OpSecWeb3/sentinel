"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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

interface Host {
  id: string;
  hostname: string;
  isRoot: boolean;
  parentId: string | null;
  score: number | null;
  grade: string | null;
  lastScanAt: string | null;
  certExpiry: string | null;
  status: "active" | "scanning" | "error" | "pending";
  createdAt: string;
}

interface HostsResponse {
  data: Host[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/* -- helpers -------------------------------------------------------- */

const gradeColor: Record<string, string> = {
  A: "text-primary",
  B: "text-primary/80",
  C: "text-warning",
  D: "text-warning/80",
  F: "text-destructive",
};

const gradeBg: Record<string, string> = {
  A: "bg-primary/10 border-primary/30",
  B: "bg-primary/5 border-primary/20",
  C: "bg-warning/10 border-warning/30",
  D: "bg-warning/5 border-warning/20",
  F: "bg-destructive/10 border-destructive/30",
};

const statusColor: Record<string, string> = {
  active: "text-primary",
  scanning: "text-warning",
  error: "text-destructive",
  pending: "text-muted-foreground",
};

type SortField = "score" | "hostname" | "lastScanAt" | "certExpiry";
type SortDir = "asc" | "desc";

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

function formatCertExpiry(iso: string | null): { text: string; color: string } {
  if (!iso) return { text: "no cert", color: "text-muted-foreground" };
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((d.getTime() - now.getTime()) / 86_400_000);
  if (diffDays < 0) return { text: `expired ${Math.abs(diffDays)}d ago`, color: "text-destructive" };
  if (diffDays === 0) return { text: "expires today", color: "text-destructive" };
  if (diffDays <= 7) return { text: `${diffDays}d left`, color: "text-destructive" };
  if (diffDays <= 30) return { text: `${diffDays}d left`, color: "text-warning" };
  return { text: `${diffDays}d left`, color: "text-primary" };
}

function isValidHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  const pattern = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  return pattern.test(hostname);
}

/* -- page ----------------------------------------------------------- */

export default function InfraHostsPage() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [meta, setMeta] = useState<HostsResponse["meta"] | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("score");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showAll, setShowAll] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const { toast, toasts, dismiss } = useToast();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Add host form
  const [showAdd, setShowAdd] = useState(false);
  const [addHostname, setAddHostname] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Confirm dialog
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

  const searchActive = debouncedSearch.trim().length > 0;
  /** Search must match subdomains too; API only omits `isRoot` when `all=true`. */
  const effectiveShowAll = showAll || searchActive;

  const fetchHosts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      params.set("sort", sortField);
      params.set("dir", sortDir);
      if (debouncedSearch) params.set("q", encodeURIComponent(debouncedSearch));
      if (effectiveShowAll) params.set("all", "true");
      if (showRemoved) params.set("showRemoved", "true");

      const res = await apiFetch<HostsResponse>(
        `/modules/infra/hosts?${params.toString()}`,
        { credentials: "include" },
      );
      setHosts(res.data);
      setMeta(res.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load hosts");
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, sortField, sortDir, effectiveShowAll, showRemoved]);

  useEffect(() => {
    fetchHosts();
  }, [fetchHosts]);

  /* -- actions ------------------------------------------------------ */

  async function handleAddHost(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);

    const hostname = addHostname.trim().toLowerCase();
    if (!isValidHostname(hostname)) {
      setAddError("Invalid hostname. Enter a valid FQDN (e.g. example.com).");
      return;
    }

    setAddLoading(true);
    try {
      const res = await apiFetch<{ data: Host }>("/modules/infra/hosts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname }),
      });
      setHosts((prev) => [res.data, ...prev]);
      setShowAdd(false);
      setAddHostname("");
      toast(`Host "${hostname}" added. Initial scan queued.`);
    } catch (err) {
      setAddError(
        err instanceof Error ? err.message : "Failed to add host",
      );
    } finally {
      setAddLoading(false);
    }
  }

  async function scanHost(host: Host) {
    setActionLoading((prev) => ({ ...prev, [`scan-${host.id}`]: true }));
    try {
      await apiFetch(`/modules/infra/hosts/${host.id}/scan`, {
        method: "POST",
        credentials: "include",
      });
      setHosts((prev) =>
        prev.map((h) =>
          h.id === host.id ? { ...h, status: "scanning" as const } : h,
        ),
      );
      toast(`Scan queued for "${host.hostname}".`);
    } catch (err) {
      toast(
        err instanceof Error
          ? `Scan failed: ${err.message}`
          : "Failed to trigger scan",
      );
    } finally {
      setActionLoading((prev) => ({ ...prev, [`scan-${host.id}`]: false }));
    }
  }

  async function removeHost(host: Host) {
    const confirmed = await confirm(
      "Remove Host",
      `Are you sure you want to remove "${host.hostname}"? All scan history and data will be permanently deleted.`,
    );
    if (!confirmed) return;
    setActionLoading((prev) => ({ ...prev, [host.id]: true }));
    try {
      await apiFetch(`/modules/infra/hosts/${host.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      setHosts((prev) => prev.filter((h) => h.id !== host.id));
      toast(`Host "${host.hostname}" removed.`);
    } catch {
      toast("Failed to remove host.");
    } finally {
      setActionLoading((prev) => ({ ...prev, [host.id]: false }));
    }
  }

  async function discoverHost(host: Host) {
    setActionLoading((prev) => ({ ...prev, [`discover-${host.id}`]: true }));
    try {
      const res = await apiFetch<{ data: { discovered: number; newHosts: number; truncated?: boolean; totalFound?: number } }>(
        `/modules/infra/hosts/${host.id}/discover`,
        { method: "POST", credentials: "include" },
      );
      const truncMsg = res.data.truncated ? ` (capped — ${res.data.totalFound} total found)` : '';
      toast(
        `Discovered ${res.data.discovered} subdomains (${res.data.newHosts} new)${truncMsg}`,
      );
      if (res.data.newHosts > 0) fetchHosts();
    } catch (err) {
      toast(
        err instanceof Error
          ? `Discovery failed: ${err.message}`
          : "Failed to discover subdomains",
      );
    } finally {
      setActionLoading((prev) => ({ ...prev, [`discover-${host.id}`]: false }));
    }
  }

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "hostname" ? "asc" : "desc");
    }
    setPage(1);
  }

  function sortIndicator(field: SortField) {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " ^" : " v";
  }


  function toggleShowAll() {
    setShowAll((v) => !v);
    setPage(1);
  }

  /* -- render ------------------------------------------------------- */

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
            $ infra hosts ls
            {effectiveShowAll && (
              <span className="text-muted-foreground"> --all</span>
            )}
            {debouncedSearch && (
              <span className="text-muted-foreground"> --filter</span>
            )}
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"}{" "}
            {showAll
              ? "all hosts including subdomains"
              : searchActive
                ? "search includes subdomains; list is roots only when search is empty"
                : "root hosts only"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/infra">{"<"} overview</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/infra/worldview">[worldview]</Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={toggleShowAll}
            className={cn(showAll ? "border-primary text-primary" : "")}
          >
            {showAll ? "[root only]" : "[show all]"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setShowRemoved((v) => !v); setPage(1); }}
            className={cn(showRemoved ? "border-primary text-primary" : "")}
          >
            {showRemoved ? "[hide removed]" : "[show removed]"}
          </Button>
          <Button onClick={() => setShowAdd(!showAdd)}>
            {showAdd ? "[cancel]" : "+ Add Host"}
          </Button>
        </div>
      </div>

      {/* Add host form */}
      {showAdd && (
        <Card>
          <CardContent className="p-4">
            <p className="mb-3 text-xs text-muted-foreground">
              $ infra hosts add
            </p>
            <form onSubmit={handleAddHost} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  --hostname
                </label>
                <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm transition-colors focus-within:border-primary">
                  <span className="text-muted-foreground shrink-0">{">"}</span>
                  <Input
                    type="text"
                    placeholder="example.com"
                    value={addHostname}
                    onChange={(e) => {
                      setAddHostname(e.target.value);
                      setAddError(null);
                    }}
                    required
                  />
                </div>
                {addError && (
                  <p className="mt-1 text-xs text-destructive">
                    [ERR] {addError}
                  </p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  enter a fully qualified domain name
                </p>
              </div>
              <Button type="submit" disabled={addLoading}>
                {addLoading ? "> adding..." : "$ add --scan"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="search hosts by name..."
        inputRef={searchInputRef}
      />

      {/* Content */}
      <div className="min-h-[300px]">
        {showLoading ? (
          <div className="space-y-1">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center gap-x-3 px-3 py-2">
                <div className="h-3 w-40 animate-pulse rounded bg-muted" />
                <div className="h-3 w-12 animate-pulse rounded bg-muted" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
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
                onClick={fetchHosts}
              >
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : hosts.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} no hosts found
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {debouncedSearch
                  ? "try adjusting your search"
                  : "add your first host to start monitoring"}
              </p>
              {!debouncedSearch && (
                <Button className="mt-4" onClick={() => setShowAdd(true)}>
                  + Add Host
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto animate-content-ready">
            <div className="min-w-[800px]">
              <Table>
                <colgroup>
                  <col className="w-[180px]" />
                  <col className="w-[60px]" />
                  <col className="w-[70px]" />
                  <col className="w-[100px]" />
                  <col className="w-[100px]" />
                  <col className="w-[60px]" />
                  <col />
                </colgroup>
                <TableHeader>
                  <TableRow className="border-b border-border hover:bg-transparent">
                    <TableHead scope="col" className="p-0 align-bottom">
                      <button
                        type="button"
                        onClick={() => toggleSort("hostname")}
                        className="w-full px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Hostname{sortIndicator("hostname")}
                      </button>
                    </TableHead>
                    <TableHead scope="col" className="p-0 align-bottom">
                      <button
                        type="button"
                        onClick={() => toggleSort("score")}
                        className="w-full px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Grade{sortIndicator("score")}
                      </button>
                    </TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col" className="p-0 align-bottom">
                      <button
                        type="button"
                        onClick={() => toggleSort("lastScanAt")}
                        className="w-full px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Last Scan{sortIndicator("lastScanAt")}
                      </button>
                    </TableHead>
                    <TableHead scope="col" className="p-0 align-bottom">
                      <button
                        type="button"
                        onClick={() => toggleSort("certExpiry")}
                        className="w-full px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Cert Expiry{sortIndicator("certExpiry")}
                      </button>
                    </TableHead>
                    <TableHead scope="col">Score</TableHead>
                    <TableHead scope="col" className="text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="animate-stagger">
                  <TableRow className="border-0 hover:bg-transparent">
                    <TableCell colSpan={7} className="border-0 py-2 text-xs text-muted-foreground">
                      {meta ? meta.total : hosts.length}{" "}
                      {effectiveShowAll ? "host" : "root host"}
                      {(meta ? meta.total : hosts.length) !== 1 ? "s" : ""}
                      {meta && meta.totalPages > 1
                        ? ` -- page ${meta.page} of ${meta.totalPages}`
                        : ""}
                    </TableCell>
                  </TableRow>
                  {hosts.map((host) => {
                    const busy = actionLoading[host.id] ?? false;
                    const scanBusy = actionLoading[`scan-${host.id}`] ?? false;
                    const discoverBusy = actionLoading[`discover-${host.id}`] ?? false;
                    const cert = formatCertExpiry(host.certExpiry);

                    return (
                      <TableRow
                        key={host.id}
                        className="group border border-transparent text-sm transition-colors hover:border-border hover:bg-muted/30"
                      >
                        <TableCell className="max-w-0 font-medium">
                          <Link
                            href={`/infra/hosts/${host.id}`}
                            className={cn(
                              "block truncate transition-colors group-hover:text-primary",
                              host.isRoot ? "text-foreground" : "text-muted-foreground pl-3",
                            )}
                          >
                            {!host.isRoot && <span className="mr-1 select-none">└</span>}
                            {host.hostname}
                          </Link>
                        </TableCell>
                        <TableCell>
                          {host.grade ? (
                            <span
                              className={cn(
                                "inline-flex h-7 w-7 items-center justify-center border text-sm font-bold",
                                gradeBg[host.grade] ?? "border-border bg-muted/30",
                                gradeColor[host.grade] ?? "text-muted-foreground",
                              )}
                            >
                              {host.grade}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">--</span>
                          )}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "font-mono text-xs",
                            statusColor[host.status] ?? "text-muted-foreground",
                          )}
                        >
                          [{host.status}]
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(host.lastScanAt)}
                        </TableCell>
                        <TableCell className={cn("text-xs", cert.color)}>
                          {cert.text}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "font-mono text-xs",
                            gradeColor[host.grade ?? ""] ?? "text-muted-foreground",
                          )}
                        >
                          {host.score !== null ? host.score : "--"}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="flex items-center justify-end gap-2 text-xs">
                            <button
                              type="button"
                              disabled={scanBusy || host.status === "scanning"}
                              onClick={() => scanHost(host)}
                              className="text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
                            >
                              {scanBusy ? "..." : "[scan]"}
                            </button>
                            {host.isRoot && (
                              <button
                                type="button"
                                disabled={discoverBusy}
                                onClick={() => discoverHost(host)}
                                className="text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
                              >
                                {discoverBusy ? "..." : "[discover]"}
                              </button>
                            )}
                            <Link
                              href={`/infra/hosts/${host.id}`}
                              className="text-muted-foreground transition-colors hover:text-primary"
                            >
                              [view]
                            </Link>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => removeHost(host)}
                              className="text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                            >
                              [remove]
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
