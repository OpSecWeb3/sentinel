"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NavTabs, type NavTab } from "@/components/ui/nav-tabs";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { useToast } from "@/hooks/use-toast";
import { ToastContainer } from "@/components/ui/toast";

/* ── types ─────────────────────────────────────────────────────── */

interface Network {
  id: number;
  name: string;
  slug: string;
  chainId: number;
  blockTime: number;
  explorerUrl: string | null;
  pollingActive: boolean;
  currentBlock: number;
  cursorPosition: number;
  rpcHealthy: boolean;
  lastPolledAt: string | null;
  createdAt: string;
}

interface NetworksResponse {
  data: Network[];
  meta: { total: number };
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

/* ── page ──────────────────────────────────────────────────────── */

export default function NetworksPage() {
  const [networks, setNetworks] = useState<Network[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const { toasts, toast, dismiss } = useToast();

  // Add network form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState("");
  const [addChainId, setAddChainId] = useState("");
  const [addExplorerUrl, setAddExplorerUrl] = useState("");
  const [addRpcUrl, setAddRpcUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const fetchNetworks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<NetworksResponse>(
        "/modules/chain/networks",
        { credentials: "include" },
      );
      setNetworks(res.data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "failed to load networks",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNetworks();
  }, [fetchNetworks]);

  async function handleAddNetwork(e: React.FormEvent) {
    e.preventDefault();
    if (!addName || !addChainId) return;
    setAdding(true);
    try {
      await apiFetch("/modules/chain/networks", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: addName,
          chainId: Number(addChainId),
          explorerUrl: addExplorerUrl || undefined,
          rpcUrl: addRpcUrl || undefined,
        }),
      });
      toast("Network added successfully", "success");
      setAddName("");
      setAddChainId("");
      setAddExplorerUrl("");
      setAddRpcUrl("");
      setShowAddForm(false);
      fetchNetworks();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to add network");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="font-mono space-y-8">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ chain networks ls
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} manage supported blockchain networks
          </p>
        </div>
        <Button onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? "Cancel" : "+ Add Network"}
        </Button>
      </div>

      {/* Navigation */}
      <NavTabs tabs={CHAIN_TABS} />

      {/* Add Network Form */}
      {showAddForm && (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-3">
              $ chain networks add
            </p>
            <form onSubmit={handleAddNetwork} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --name
                  </label>
                  <Input
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                    placeholder="Ethereum Mainnet"
                    className="h-8 text-xs"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --chain-id
                  </label>
                  <Input
                    type="number"
                    value={addChainId}
                    onChange={(e) => setAddChainId(e.target.value)}
                    placeholder="1"
                    className="h-8 text-xs"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --explorer-url
                  </label>
                  <Input
                    value={addExplorerUrl}
                    onChange={(e) => setAddExplorerUrl(e.target.value)}
                    placeholder="https://etherscan.io"
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --rpc-url
                  </label>
                  <Input
                    value={addRpcUrl}
                    onChange={(e) => setAddRpcUrl(e.target.value)}
                    placeholder="https://mainnet.infura.io/v3/..."
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              <Button type="submit" size="sm" disabled={adding}>
                {adding ? "adding..." : "$ submit"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Content */}
      <div className="min-h-[300px]">
        {showLoading || loading ? (
          <div className={showLoading ? "space-y-1" : "space-y-1 invisible"}>
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-center gap-x-3 px-3 py-2">
                <div className="h-3 w-28 animate-pulse rounded bg-muted" />
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
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
                onClick={fetchNetworks}
              >
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : networks.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} no networks configured
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                add your first network to start monitoring on-chain activity
              </p>
              <Button
                className="mt-4"
                onClick={() => setShowAddForm(true)}
              >
                + Add Network
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto animate-content-ready">
            <div className="min-w-[900px]">
              {/* Header */}
              <div className="grid grid-cols-[minmax(120px,1.5fr)_70px_80px_100px_120px_100px_80px_100px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Name</span>
                <span>Chain ID</span>
                <span>Block Time</span>
                <span>Explorer</span>
                <span>Current Block</span>
                <span>Cursor</span>
                <span>Polling</span>
                <span>RPC Health</span>
              </div>

              <p className="px-3 pt-2 text-xs text-muted-foreground">
                {networks.length} network{networks.length !== 1 ? "s" : ""}
              </p>

              {/* Rows */}
              {networks.map((net) => (
                <div
                  key={net.id}
                  className="group grid grid-cols-[minmax(120px,1.5fr)_70px_80px_100px_120px_100px_80px_100px] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30"
                >
                  <span className="text-foreground font-medium group-hover:text-primary transition-colors">
                    {net.name}
                  </span>

                  <span className="text-muted-foreground text-xs">
                    {net.chainId}
                  </span>

                  <span className="text-muted-foreground text-xs">
                    {net.blockTime}s
                  </span>

                  <span className="text-xs truncate">
                    {net.explorerUrl ? (
                      <a
                        href={net.explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        [explorer]
                      </a>
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </span>

                  <span className="text-primary text-xs">
                    {net.currentBlock != null ? `#${net.currentBlock.toLocaleString()}` : "--"}
                  </span>

                  <span className="text-muted-foreground text-xs">
                    {net.cursorPosition != null ? `#${net.cursorPosition.toLocaleString()}` : "--"}
                  </span>

                  <span
                    className={cn(
                      "font-mono text-xs",
                      net.pollingActive
                        ? "text-primary"
                        : "text-muted-foreground",
                    )}
                  >
                    {net.pollingActive ? "[active]" : "[paused]"}
                  </span>

                  <span
                    className={cn(
                      "font-mono text-xs",
                      net.rpcHealthy
                        ? "text-primary"
                        : "text-destructive",
                    )}
                  >
                    {net.rpcHealthy ? "[healthy]" : "[down]"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
