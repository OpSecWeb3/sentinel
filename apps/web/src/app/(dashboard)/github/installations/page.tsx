"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { cn } from "@/lib/utils";
import { apiGet, apiPost, apiDelete } from "@/lib/api";

/* -- types --------------------------------------------------------- */

interface Installation {
  id: string;
  installationId: string;
  targetLogin: string;
  targetType: string;
  status: string;
  permissions: Record<string, string>;
  events: string[];
  createdAt: string;
}

/* -- helpers ------------------------------------------------------- */

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays < 1) return "today";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

/* -- page ---------------------------------------------------------- */

export default function GitHubInstallationsPage() {
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const { toasts, toast, dismiss } = useToast();
  const { confirmState, confirm, handleClose } = useConfirm();

  // Manual setup form state
  const [showSetup, setShowSetup] = useState(false);
  const [setupForm, setSetupForm] = useState({
    installationId: "",
    appSlug: "",
    targetType: "Organization" as "Organization" | "User",
    targetLogin: "",
    targetId: "",
    webhookSecret: "",
  });
  const [setupLoading, setSetupLoading] = useState(false);

  const fetchInstallations = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiGet<{ data: Installation[] }>("/modules/github/installations");
      setInstallations(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load installations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInstallations();
  }, [fetchInstallations]);

  /* -- actions ----------------------------------------------------- */

  async function handleSync(installation: Installation) {
    setActionLoading((prev) => ({ ...prev, [`sync-${installation.id}`]: true }));
    try {
      await apiPost(`/modules/github/installations/${installation.id}/sync`);
      toast("Repo sync queued successfully", "success");
    } catch {
      toast("Failed to trigger repo sync");
    } finally {
      setActionLoading((prev) => ({ ...prev, [`sync-${installation.id}`]: false }));
    }
  }

  async function handleRemove(installation: Installation) {
    const confirmed = await confirm(
      "Remove Installation",
      `Are you sure you want to remove the installation for "${installation.targetLogin}"? This will stop all webhook processing for this installation.`,
    );
    if (!confirmed) return;

    setActionLoading((prev) => ({ ...prev, [`rm-${installation.id}`]: true }));
    try {
      await apiDelete(`/modules/github/installations/${installation.id}`);
      setInstallations((prev) => prev.filter((i) => i.id !== installation.id));
      toast("Installation removed", "success");
    } catch {
      toast("Failed to remove installation");
    } finally {
      setActionLoading((prev) => ({ ...prev, [`rm-${installation.id}`]: false }));
    }
  }

  async function handleManualSetup(e: React.FormEvent) {
    e.preventDefault();
    setSetupLoading(true);
    try {
      await apiPost("/modules/github/installations", {
        installationId: Number(setupForm.installationId),
        appSlug: setupForm.appSlug,
        targetType: setupForm.targetType,
        targetLogin: setupForm.targetLogin,
        targetId: Number(setupForm.targetId),
        webhookSecret: setupForm.webhookSecret,
        permissions: {},
        events: [],
      });
      toast("Installation registered successfully", "success");
      setShowSetup(false);
      setSetupForm({
        installationId: "",
        appSlug: "",
        targetType: "Organization",
        targetLogin: "",
        targetId: "",
        webhookSecret: "",
      });
      fetchInstallations();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to register installation");
    } finally {
      setSetupLoading(false);
    }
  }

  /* -- render ------------------------------------------------------ */

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        description={confirmState.description}
        onClose={handleClose}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ github installations ls
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} manage github app installations for your organization
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSetup(!showSetup)}
            className="text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            {showSetup ? "[cancel]" : "[manual setup]"}
          </button>
          <Link href="/github" className="text-xs text-muted-foreground hover:text-primary transition-colors">
            [back]
          </Link>
        </div>
      </div>

      {/* Manual Setup Form */}
      {showSetup && (
        <Card>
          <CardHeader>
            <CardTitle>
              <span className="text-muted-foreground">{">"}</span>{" "}
              manual installation (GitHub Enterprise)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleManualSetup} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --installation-id
                  </label>
                  <input
                    type="number"
                    required
                    value={setupForm.installationId}
                    onChange={(e) => setSetupForm((f) => ({ ...f, installationId: e.target.value }))}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono outline-none focus:border-primary transition-colors"
                    placeholder="12345678"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --app-slug
                  </label>
                  <input
                    type="text"
                    required
                    value={setupForm.appSlug}
                    onChange={(e) => setSetupForm((f) => ({ ...f, appSlug: e.target.value }))}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono outline-none focus:border-primary transition-colors"
                    placeholder="sentinel"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --target-login
                  </label>
                  <input
                    type="text"
                    required
                    value={setupForm.targetLogin}
                    onChange={(e) => setSetupForm((f) => ({ ...f, targetLogin: e.target.value }))}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono outline-none focus:border-primary transition-colors"
                    placeholder="my-org"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --target-type
                  </label>
                  <div className="flex items-center gap-3 py-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setSetupForm((f) => ({ ...f, targetType: "Organization" }))}
                      className={cn(
                        "transition-colors",
                        setupForm.targetType === "Organization"
                          ? "text-foreground"
                          : "text-muted-foreground/60 hover:text-foreground",
                      )}
                    >
                      {setupForm.targetType === "Organization" ? "[Organization]" : "Organization"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSetupForm((f) => ({ ...f, targetType: "User" }))}
                      className={cn(
                        "transition-colors",
                        setupForm.targetType === "User"
                          ? "text-foreground"
                          : "text-muted-foreground/60 hover:text-foreground",
                      )}
                    >
                      {setupForm.targetType === "User" ? "[User]" : "User"}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --target-id
                  </label>
                  <input
                    type="number"
                    required
                    value={setupForm.targetId}
                    onChange={(e) => setSetupForm((f) => ({ ...f, targetId: e.target.value }))}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono outline-none focus:border-primary transition-colors"
                    placeholder="9876543"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --webhook-secret
                  </label>
                  <input
                    type="password"
                    required
                    minLength={20}
                    value={setupForm.webhookSecret}
                    onChange={(e) => setSetupForm((f) => ({ ...f, webhookSecret: e.target.value }))}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono outline-none focus:border-primary transition-colors"
                    placeholder="min 20 characters"
                  />
                </div>
              </div>
              <div className="flex justify-end pt-2">
                <Button type="submit" disabled={setupLoading}>
                  {setupLoading ? "..." : "$ register"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Content */}
      <div className="min-h-[300px]">
        {showLoading || loading ? (
          <div className={showLoading ? "space-y-1" : "space-y-1 invisible"}>
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex items-center gap-x-3 px-3 py-2">
                <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : error ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-sm text-destructive">[ERR] {error}</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={fetchInstallations}>
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : installations.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} no installations found
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                install the GitHub App or use manual setup for GitHub Enterprise
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto animate-content-ready">
            <div className="min-w-[700px]">
              {/* Header */}
              <div className="grid grid-cols-[minmax(140px,1.5fr)_100px_80px_100px_1fr] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Target</span>
                <span>Type</span>
                <span>Status</span>
                <span>Created</span>
                <span className="text-right">Actions</span>
              </div>

              <p className="px-3 pt-2 text-xs text-muted-foreground">
                {installations.length} installation
                {installations.length !== 1 ? "s" : ""}
              </p>

              {/* Rows */}
              {installations.map((installation) => {
                const syncBusy = actionLoading[`sync-${installation.id}`] ?? false;
                const rmBusy = actionLoading[`rm-${installation.id}`] ?? false;

                return (
                  <div
                    key={installation.id}
                    className="group grid grid-cols-[minmax(140px,1.5fr)_100px_80px_100px_1fr] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30"
                  >
                    <span className="truncate text-foreground group-hover:text-primary font-medium font-mono transition-colors">
                      {installation.targetLogin}
                    </span>

                    <span className="text-xs text-muted-foreground font-mono">
                      [{installation.targetType === "Organization" ? "org" : "user"}]
                    </span>

                    <span
                      className={cn(
                        "font-mono text-xs",
                        installation.status === "active"
                          ? "text-primary"
                          : installation.status === "removed"
                            ? "text-destructive"
                            : "text-muted-foreground",
                      )}
                    >
                      [{installation.status}]
                    </span>

                    <span className="text-xs text-muted-foreground">
                      {formatDate(installation.createdAt)}
                    </span>

                    <span className="flex items-center justify-end gap-2 text-xs">
                      {installation.status === "active" && (
                        <>
                          <button
                            disabled={syncBusy}
                            onClick={() => handleSync(installation)}
                            className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                          >
                            {syncBusy ? "..." : "[sync repos]"}
                          </button>
                          <button
                            disabled={rmBusy}
                            onClick={() => handleRemove(installation)}
                            className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                          >
                            {rmBusy ? "..." : "[remove]"}
                          </button>
                        </>
                      )}
                      {installation.status === "removed" && (
                        <span className="text-muted-foreground/60">removed</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
