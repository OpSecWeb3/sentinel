"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { NavTabs, type NavTab } from "@/components/ui/nav-tabs";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { useToast } from "@/hooks/use-toast";
import { ToastContainer } from "@/components/ui/toast";

/* ── types ─────────────────────────────────────────────────────── */

interface Network {
  id: number;
  name: string;
  chainId: number;
}

interface RpcConfig {
  id: number;
  networkId: number;
  networkName: string;
  customUrl: string;
  status: "active" | "inactive" | "error";
  callCount: number;
  errorCount: number;
  avgLatencyMs: number | null;
  lastCheckedAt: string | null;
  createdAt: string;
}

interface RpcConfigsResponse {
  data: RpcConfig[];
  meta: { total: number };
}

interface NetworksResponse {
  data: Network[];
  meta: { total: number };
}

/* ── helpers ───────────────────────────────────────────────────── */

const statusColor: Record<string, string> = {
  active: "text-primary",
  inactive: "text-muted-foreground",
  error: "text-destructive",
};

const CHAIN_TABS: NavTab[] = [
  { href: "/chain", label: "overview" },
  { href: "/chain/networks", label: "networks" },
  { href: "/chain/contracts", label: "contracts" },
  { href: "/chain/rpc", label: "rpc" },
  { href: "/chain/templates", label: "templates" },
  { href: "/chain/events", label: "events" },
  { href: "/chain/state-changes", label: "state-changes" },
];

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
  return d.toLocaleDateString();
}

/* ── page ──────────────────────────────────────────────────────── */

export default function RpcConfigPage() {
  const [configs, setConfigs] = useState<RpcConfig[]>([]);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const { toasts, toast, dismiss } = useToast();

  // Add form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addNetworkId, setAddNetworkId] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [adding, setAdding] = useState(false);

  // Load networks
  useEffect(() => {
    async function loadNetworks() {
      try {
        const res = await apiFetch<NetworksResponse>(
          "/modules/chain/networks",
          { credentials: "include" },
        );
        setNetworks(res.data);
      } catch {
        // silent
      }
    }
    loadNetworks();
  }, []);

  const fetchConfigs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<RpcConfigsResponse>(
        "/modules/chain/rpc-configs",
        { credentials: "include" },
      );
      setConfigs(res.data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "failed to load RPC configs",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  async function handleAddConfig(e: React.FormEvent) {
    e.preventDefault();
    if (!addNetworkId || !addUrl) return;
    setAdding(true);
    try {
      await apiFetch("/modules/chain/rpc-configs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          networkId: Number(addNetworkId),
          customUrl: addUrl,
        }),
      });
      toast("RPC config saved", "success");
      setAddNetworkId("");
      setAddUrl("");
      setShowAddForm(false);
      fetchConfigs();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save RPC config");
    } finally {
      setAdding(false);
    }
  }

  async function toggleConfig(config: RpcConfig) {
    const newStatus = config.status === "active" ? "inactive" : "active";
    try {
      await apiFetch(`/modules/chain/rpc-configs/${config.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      setConfigs((prev) =>
        prev.map((c) =>
          c.id === config.id ? { ...c, status: newStatus } : c,
        ),
      );
    } catch {
      toast("Failed to update RPC config");
    }
  }

  async function deleteConfig(configId: number) {
    try {
      await apiFetch(`/modules/chain/rpc-configs/${configId}`, {
        method: "DELETE",
        credentials: "include",
      });
      setConfigs((prev) => prev.filter((c) => c.id !== configId));
      toast("RPC config removed", "success");
    } catch {
      toast("Failed to remove RPC config");
    }
  }

  const networkOptions = [
    { value: "", label: "select network..." },
    ...networks.map((n) => ({
      value: String(n.id),
      label: `${n.name} (${n.chainId})`,
    })),
  ];

  /* ── derived stats ───────────────────────────────────────────── */

  const totalCalls = configs.reduce((sum, c) => sum + c.callCount, 0);
  const totalErrors = configs.reduce((sum, c) => sum + c.errorCount, 0);
  const errorRate =
    totalCalls + totalErrors > 0
      ? ((totalErrors / (totalCalls + totalErrors)) * 100).toFixed(1)
      : "0.0";
  const activeCount = configs.filter((c) => c.status === "active").length;

  const statEntries = [
    { key: "TOTAL_CONFIGS", value: String(configs.length) },
    { key: "ACTIVE", value: String(activeCount) },
    { key: "TOTAL_CALLS", value: totalCalls.toLocaleString() },
    { key: "ERROR_RATE", value: `${errorRate}%` },
  ];

  return (
    <div className="font-mono space-y-8">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ chain rpc-configs ls
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} manage custom RPC endpoints per network
          </p>
        </div>
        <Button onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? "Cancel" : "+ Add RPC Config"}
        </Button>
      </div>

      {/* Navigation */}
      <NavTabs tabs={CHAIN_TABS} />

      {/* Add RPC Form */}
      {showAddForm && (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-3">
              $ chain rpc-configs add
            </p>
            <form onSubmit={handleAddConfig} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --network
                  </label>
                  <Select
                    value={addNetworkId}
                    onValueChange={setAddNetworkId}
                    options={networkOptions}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --url
                  </label>
                  <Input
                    value={addUrl}
                    onChange={(e) => setAddUrl(e.target.value)}
                    placeholder="https://mainnet.infura.io/v3/..."
                    className="h-8 text-xs"
                    required
                  />
                </div>
              </div>
              <Button type="submit" size="sm" disabled={adding}>
                {adding ? "saving..." : "$ submit"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {!loading && (error || configs.length === 0 && !showAddForm) ? (
        error ? (
          <>
            <p className="text-sm text-destructive">[ERR] {error}</p>
            <Button variant="outline" size="sm" onClick={fetchConfigs}>
              $ retry
            </Button>
          </>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} no custom RPC configs found
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                add a custom RPC endpoint to override the default for a network
              </p>
              <Button className="mt-4" onClick={() => setShowAddForm(true)}>
                + Add RPC Config
              </Button>
            </CardContent>
          </Card>
        )
      ) : (
        <>
          {/* Stats row */}
          <section>
            <p className="mb-3 text-xs text-muted-foreground">
              rpc usage summary
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 min-h-[104px]">
              {showLoading
                ? [0, 1, 2, 3].map((i) => (
                    <Card key={i}>
                      <CardContent className="p-4 space-y-3 animate-pulse">
                        <div className="h-3 bg-muted-foreground/20 rounded w-1/3" />
                        <div className="h-8 bg-muted-foreground/20 rounded w-1/2" />
                      </CardContent>
                    </Card>
                  ))
                : statEntries.map((s) => (
                    <Card key={s.key} className="animate-content-ready">
                      <CardContent className="p-4">
                        <p className="text-xs text-muted-foreground">
                          {s.key}
                        </p>
                        <p className="mt-1 text-2xl font-bold text-primary text-glow">
                          {s.value}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {s.key === "ERROR_RATE" && totalErrors > 0
                            ? "[!]"
                            : "[OK]"}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
            </div>
          </section>

          {/* Config list */}
          <div className="min-h-[200px]">
            {showLoading || loading ? (
              <div
                className={showLoading ? "space-y-1" : "space-y-1 invisible"}
              >
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="flex items-center gap-x-3 px-3 py-2">
                    <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-48 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : configs.length > 0 ? (
              <div className="overflow-x-auto animate-content-ready">
                <div className="min-w-[700px]">
                  <div className="grid grid-cols-[minmax(100px,1fr)_minmax(200px,2fr)_80px_80px_80px_80px_1fr] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <span>Network</span>
                    <span>Custom URL</span>
                    <span>Status</span>
                    <span>Calls</span>
                    <span>Errors</span>
                    <span>Latency</span>
                    <span className="text-right">Actions</span>
                  </div>

                  <p className="px-3 pt-2 text-xs text-muted-foreground">
                    {configs.length} config{configs.length !== 1 ? "s" : ""}
                  </p>

                  {configs.map((config) => (
                    <div
                      key={config.id}
                      className="group grid grid-cols-[minmax(100px,1fr)_minmax(200px,2fr)_80px_80px_80px_80px_1fr] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30"
                    >
                      <span className="text-foreground font-medium text-xs">
                        {config.networkName}
                      </span>

                      <span className="text-muted-foreground text-xs truncate">
                        {config.customUrl}
                      </span>

                      <span
                        className={cn(
                          "font-mono text-xs",
                          statusColor[config.status] ??
                            "text-muted-foreground",
                        )}
                      >
                        [{config.status}]
                      </span>

                      <span className="text-primary text-xs">
                        {config.callCount.toLocaleString()}
                      </span>

                      <span
                        className={cn(
                          "text-xs",
                          config.errorCount > 0
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                      >
                        {config.errorCount.toLocaleString()}
                      </span>

                      <span className="text-muted-foreground text-xs">
                        {config.avgLatencyMs !== null
                          ? `${config.avgLatencyMs}ms`
                          : "--"}
                      </span>

                      <span className="flex items-center justify-end gap-2 text-xs">
                        <button
                          onClick={() => toggleConfig(config)}
                          className="text-muted-foreground hover:text-primary transition-colors"
                        >
                          {config.status === "active"
                            ? "[disable]"
                            : "[enable]"}
                        </button>
                        <button
                          onClick={() => deleteConfig(config.id)}
                          className="text-muted-foreground hover:text-destructive transition-colors"
                        >
                          [remove]
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
