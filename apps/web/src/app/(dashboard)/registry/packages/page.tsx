"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* -- types ----------------------------------------------------------- */

interface MonitoredPackage {
  id?: string;
  name: string;
  registry: string;
  tagPatterns: string[];
  ignorePatterns?: string[];
  pollIntervalSeconds: number;
  lastPolledAt: string | null;
  lastEvent?: string | null;
  latestVersion?: string | null;
  provenanceStatus?: string;
  jobId?: string;
  githubRepo?: string | null;
  enabled?: boolean;
}

interface PackagesResponse {
  data: MonitoredPackage[];
  message?: string;
}

interface NpmImportResult {
  data: {
    imported: number;
    skipped: number;
    total: number;
    packages: string[];
  };
}

/* -- helpers --------------------------------------------------------- */

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "never";
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

function provenanceBadge(status: string | undefined) {
  switch (status) {
    case "verified":
      return <span className="text-primary">[provenance:ok]</span>;
    case "missing":
      return <span className="text-warning">[no-provenance]</span>;
    case "invalid":
      return <span className="text-destructive">[provenance:fail]</span>;
    default:
      return <span className="text-muted-foreground">[pending]</span>;
  }
}

/* -- edit panel ------------------------------------------------------ */

interface EditPanelProps {
  pkg: MonitoredPackage;
  onClose: () => void;
  onSaved: (updated: MonitoredPackage) => void;
}

function EditPanel({ pkg, onClose, onSaved }: EditPanelProps) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const [tagWatch, setTagWatch] = useState(
    (pkg.tagPatterns ?? []).join(", "),
  );
  const [tagIgnore, setTagIgnore] = useState(
    (pkg.ignorePatterns ?? []).join(", "),
  );
  const [pollInterval, setPollInterval] = useState(
    String(pkg.pollIntervalSeconds ?? 300),
  );
  const [githubRepo, setGithubRepo] = useState(pkg.githubRepo ?? "");
  const [enabled, setEnabled] = useState(pkg.enabled !== false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pkg.id) return;
    setSaving(true);
    try {
      const res = await apiFetch<{ data: MonitoredPackage }>(
        `/modules/registry/packages/${pkg.id}`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tagWatchPatterns: tagWatch
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            tagIgnorePatterns: tagIgnore
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            pollIntervalSeconds: Number(pollInterval),
            githubRepo: githubRepo.trim() || null,
            enabled,
          }),
        },
      );
      onSaved(res.data);
      toast(`Saved changes for ${pkg.name}.`);
      onClose();
    } catch (err) {
      toast(
        err instanceof Error ? `Failed: ${err.message}` : "Failed to save",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="col-span-full border-t border-border bg-muted/20 px-3 py-3">
      <p className="mb-3 text-xs text-muted-foreground">
        $ registry packages edit --id {pkg.id ?? pkg.name}
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              tag watch (comma-separated)
            </label>
            <Input
              value={tagWatch}
              onChange={(e) => setTagWatch(e.target.value)}
              placeholder="*, latest"
              className="h-8 text-xs"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              tag ignore (comma-separated)
            </label>
            <Input
              value={tagIgnore}
              onChange={(e) => setTagIgnore(e.target.value)}
              placeholder="*-rc, *-beta"
              className="h-8 text-xs"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              poll interval (seconds, min 60)
            </label>
            <Input
              type="number"
              min={60}
              value={pollInterval}
              onChange={(e) => setPollInterval(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              github repo (e.g. org/repo)
            </label>
            <Input
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder="org/repo"
              className="h-8 text-xs"
            />
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">enabled</label>
          <div className="flex gap-3 text-xs">
            {(["true", "false"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setEnabled(opt === "true")}
                className={cn(
                  "transition-colors",
                  (enabled && opt === "true") || (!enabled && opt === "false")
                    ? "text-foreground"
                    : "text-muted-foreground/60 hover:text-foreground",
                )}
              >
                {(enabled && opt === "true") || (!enabled && opt === "false")
                  ? `[${opt}]`
                  : opt}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "> saving..." : "$ save changes"}
          </Button>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            [cancel]
          </button>
        </div>
      </form>
    </div>
  );
}

/* -- npm import modal ------------------------------------------------ */

interface NpmImportModalProps {
  onClose: () => void;
  onImported: () => void;
}

function NpmImportModal({ onClose, onImported }: NpmImportModalProps) {
  const { toast } = useToast();
  const [scope, setScope] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<NpmImportResult["data"] | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setImporting(true);
    try {
      const normalized = scope.trim().startsWith("@")
        ? scope.trim()
        : `@${scope.trim()}`;
      const res = await apiFetch<NpmImportResult>(
        "/modules/registry/npm-orgs/import",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: normalized }),
        },
      );
      setResult(res.data);
      toast(
        `Import complete: ${res.data.imported} created, ${res.data.skipped} skipped.`,
      );
      onImported();
    } catch (err) {
      toast(
        err instanceof Error ? `Failed: ${err.message}` : "Import failed",
      );
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <Card className="w-full max-w-md">
        <CardContent className="p-5">
          <p className="mb-1 text-xs text-muted-foreground">
            $ registry npm-orgs import
          </p>
          <h2 className="mb-4 text-sm font-medium text-foreground">
            Import npm scope
          </h2>

          {result ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {">"} import complete
              </p>
              <div className="rounded border border-border bg-muted/30 px-3 py-2 text-xs font-mono">
                <p className="text-primary">
                  created: {result.imported}
                </p>
                <p className="text-muted-foreground">
                  skipped: {result.skipped}
                </p>
                <p className="text-muted-foreground">
                  total found: {result.total}
                </p>
              </div>
              {result.packages.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded border border-border bg-muted/20 px-3 py-2">
                  {result.packages.map((name) => (
                    <p key={name} className="text-xs text-muted-foreground font-mono">
                      + {name}
                    </p>
                  ))}
                </div>
              )}
              <Button onClick={onClose} size="sm">
                [close]
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  scope (e.g. @myorg or myorg)
                </label>
                <Input
                  placeholder="@myorg"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  required
                  autoFocus
                  className="h-8 text-xs"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Imports all public packages under this scope from the npm
                  registry
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={importing}>
                  {importing ? "> importing..." : "$ import scope"}
                </Button>
                <button
                  type="button"
                  onClick={onClose}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  [cancel]
                </button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* -- page ------------------------------------------------------------ */

export default function PackagesPage() {
  const [packages, setPackages] = useState<MonitoredPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const { toast, toasts, dismiss } = useToast();

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createScope, setCreateScope] = useState("npmjs");
  const [createPollInterval, setCreatePollInterval] = useState("300");
  const [createLoading, setCreateLoading] = useState(false);

  // Edit panel
  const [editingId, setEditingId] = useState<string | null>(null);

  // npm import modal
  const [showImport, setShowImport] = useState(false);

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

  const fetchPackages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<PackagesResponse>(
        "/modules/registry/packages",
        { credentials: "include" },
      );
      setPackages(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load packages");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPackages();
  }, [fetchPackages]);

  /* -- create package ------------------------------------------------ */

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateLoading(true);
    try {
      const res = await apiFetch<{ data: MonitoredPackage }>(
        "/modules/registry/packages",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: createName,
            tagPatterns: ["*"],
            pollIntervalSeconds: Number(createPollInterval),
          }),
        },
      );

      setPackages((prev) => [res.data, ...prev]);
      setShowCreate(false);
      setCreateName("");
      setCreatePollInterval("300");
      toast("Package added. Initial poll queued.");
    } catch (err) {
      toast(
        err instanceof Error
          ? `Failed: ${err.message}`
          : "Failed to add package",
      );
    } finally {
      setCreateLoading(false);
    }
  }

  /* -- poll now ------------------------------------------------------ */

  async function pollNow(pkg: MonitoredPackage) {
    const key = `poll-${pkg.name}`;
    setActionLoading((prev) => ({ ...prev, [key]: true }));
    try {
      await apiFetch("/modules/registry/packages", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: pkg.name,
          tagPatterns: pkg.tagPatterns,
          pollIntervalSeconds: pkg.pollIntervalSeconds,
        }),
      });
      toast(`Poll queued for ${pkg.name}.`);
    } catch (err) {
      toast(
        err instanceof Error ? `Failed: ${err.message}` : "Poll failed",
      );
    } finally {
      setActionLoading((prev) => ({ ...prev, [key]: false }));
    }
  }

  /* -- remove package ------------------------------------------------ */

  async function removePackage(pkg: MonitoredPackage) {
    const confirmed = await confirm(
      "Remove Package",
      `Stop monitoring "${pkg.name}"? Existing events will be preserved.`,
    );
    if (!confirmed) return;
    const key = `remove-${pkg.name}`;
    setActionLoading((prev) => ({ ...prev, [key]: true }));
    try {
      if (pkg.id) {
        await apiFetch(`/modules/registry/packages/${pkg.id}`, {
          method: "DELETE",
          credentials: "include",
        });
      }
      setPackages((prev) => prev.filter((p) => p.name !== pkg.name));
      toast(`Stopped monitoring ${pkg.name}.`);
    } catch (err) {
      toast(
        err instanceof Error ? `Failed: ${err.message}` : "Failed to remove",
      );
    } finally {
      setActionLoading((prev) => ({ ...prev, [key]: false }));
    }
  }

  /* -- edit saved ---------------------------------------------------- */

  function handleEditSaved(updated: MonitoredPackage) {
    setPackages((prev) =>
      prev.map((p) =>
        p.id && p.id === updated.id ? { ...p, ...updated } : p,
      ),
    );
  }

  /* -- render -------------------------------------------------------- */

  return (
    <div className="space-y-6 font-mono">
      <ToastContainer toasts={toasts} dismiss={dismiss} />
      {showImport && (
        <NpmImportModal
          onClose={() => setShowImport(false)}
          onImported={fetchPackages}
        />
      )}

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
            $ registry packages ls
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} monitored npm packages
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowImport(true)}
          >
            Import npm scope
          </Button>
          <Button onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? "[cancel]" : "+ Add Package"}
          </Button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <Card>
          <CardContent className="p-4">
            <p className="mb-3 text-xs text-muted-foreground">
              $ registry packages add
            </p>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  name (e.g. express, @acme/sdk)
                </label>
                <Input
                  placeholder="@acme/sdk"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  required
                  className="h-8 text-xs"
                />
              </div>

              <div className="flex items-center gap-3 text-xs">
                <span className="text-muted-foreground">registry</span>
                {["npmjs"].map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setCreateScope(r)}
                    className={cn(
                      "transition-colors",
                      createScope === r
                        ? "text-foreground"
                        : "text-muted-foreground/60 hover:text-foreground",
                    )}
                  >
                    {createScope === r ? `[${r}]` : r}
                  </button>
                ))}
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  poll interval (seconds, min 60)
                </label>
                <Input
                  type="number"
                  min={60}
                  placeholder="300"
                  value={createPollInterval}
                  onChange={(e) => setCreatePollInterval(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>

              <Button type="submit" disabled={createLoading}>
                {createLoading ? "> adding..." : "$ add package"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Content */}
      <div className="min-h-[200px]">
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
              {">"} loading packages...
              <span className="ml-1 animate-pulse">_</span>
            </p>
          </div>
        )}

        {/* Error */}
        {!showLoading && !loading && error && (
          <div className="py-16 text-center">
            <p className="text-sm text-destructive">[ERR] {error}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4 text-xs"
              onClick={fetchPackages}
            >
              $ retry
            </Button>
          </div>
        )}

        {/* Empty */}
        {!showLoading && !loading && !error && packages.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} no monitored packages
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                add an npm package to start monitoring version and maintainer changes
              </p>
              <Button className="mt-4" onClick={() => setShowCreate(true)}>
                + Add Package
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Package list */}
        {!showLoading && !loading && !error && packages.length > 0 && (
          <div className="animate-content-ready">
            {/* Header row */}
            <div className="grid grid-cols-[2fr_100px_80px_100px_120px_1fr] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <span>Package</span>
              <span>Latest</span>
              <span>Registry</span>
              <span>Last Event</span>
              <span>Provenance</span>
              <span className="text-right">Actions</span>
            </div>

            <p className="px-3 pt-2 text-xs text-muted-foreground">
              {packages.length} package{packages.length !== 1 ? "s" : ""} monitored
            </p>

            {/* Rows */}
            {packages.map((pkg) => {
              const pollBusy = actionLoading[`poll-${pkg.name}`] ?? false;
              const removeBusy = actionLoading[`remove-${pkg.name}`] ?? false;
              const isEditing = editingId === (pkg.id ?? pkg.name);

              return (
                <div key={pkg.name}>
                  <div className="group grid grid-cols-[2fr_100px_80px_100px_120px_1fr] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30">
                    <Link
                      href={`/registry/packages/${pkg.id ?? pkg.name}`}
                      className="truncate font-medium text-foreground group-hover:text-primary transition-colors"
                    >
                      {pkg.name}
                    </Link>

                    <span className="text-xs text-muted-foreground font-mono">
                      {pkg.latestVersion ?? "--"}
                    </span>

                    <span className="text-xs text-muted-foreground">
                      {pkg.registry}
                    </span>

                    <span className="text-xs text-muted-foreground">
                      {formatDate(pkg.lastEvent ?? pkg.lastPolledAt)}
                    </span>

                    <span className="text-xs">
                      {provenanceBadge(pkg.provenanceStatus)}
                    </span>

                    <span className="flex items-center justify-end gap-2 text-xs">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingId(
                            isEditing ? null : (pkg.id ?? pkg.name),
                          );
                        }}
                        className={cn(
                          "transition-colors",
                          isEditing
                            ? "text-primary"
                            : "text-muted-foreground hover:text-primary",
                        )}
                      >
                        [edit]
                      </button>
                      <button
                        disabled={pollBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          pollNow(pkg);
                        }}
                        className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                      >
                        {pollBusy ? "..." : "[poll]"}
                      </button>
                      <button
                        disabled={removeBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          removePackage(pkg);
                        }}
                        className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                      >
                        {removeBusy ? "..." : "[remove]"}
                      </button>
                    </span>
                  </div>

                  {isEditing && (
                    <EditPanel
                      pkg={pkg}
                      onClose={() => setEditingId(null)}
                      onSaved={handleEditSaved}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
