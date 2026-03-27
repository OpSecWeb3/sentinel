"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SearchInput } from "@/components/ui/search-input";
import { NavTabs, type NavTab } from "@/components/ui/nav-tabs";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { useToast } from "@/hooks/use-toast";
import { ToastContainer } from "@/components/ui/toast";

/* ── types ─────────────────────────────────────────────────────── */

interface Network {
  id: number;
  name: string;
  chainId: number;
  explorerUrl: string | null;
}

interface ChainContract {
  id: number;
  label: string;
  address: string;
  networkId: number;
  networkName: string;
  explorerUrl: string | null;
  abiStatus: "loaded" | "pending" | "missing" | "error";
  tags: string[];
  notes: string | null;
  eventCount: number;
  functionCount: number;
  detectionCount: number;
  createdAt: string;
}

interface ContractsResponse {
  data: ChainContract[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

interface NetworksResponse {
  data: Network[];
  meta: { total: number };
}

/* ── helpers ───────────────────────────────────────────────────── */

function truncateAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

const abiStatusColor: Record<string, string> = {
  loaded: "text-primary",
  pending: "text-warning",
  missing: "text-muted-foreground",
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

/* ── page ──────────────────────────────────────────────────────── */

export default function ChainContractsPage() {
  const [contracts, setContracts] = useState<ChainContract[]>([]);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [total, setTotal] = useState(0);
  const { toasts, toast, dismiss } = useToast();

  // Add contract form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addNetworkId, setAddNetworkId] = useState("");
  const [addAddress, setAddAddress] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addTags, setAddTags] = useState("");
  const [adding, setAdding] = useState(false);
  const [fetchingAbi, setFetchingAbi] = useState(false);

  // Contract detail
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detailData, setDetailData] = useState<{
    abi: unknown[];
    events: { name: string; signature: string }[];
    functions: { name: string; signature: string; stateMutability: string }[];
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Edit tags/notes
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTags, setEditTags] = useState("");
  const [editNotes, setEditNotes] = useState("");

  // Load networks for selector
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

  const fetchContracts = useCallback(
    async (query: string) => {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams();
        if (query) params.set("search", query);
        const qs = params.toString();
        const res = await apiFetch<ContractsResponse>(
          `/modules/chain/contracts${qs ? `?${qs}` : ""}`,
          { credentials: "include" },
        );
        setContracts(res.data);
        setTotal(res.meta.total);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load contracts",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const timer = setTimeout(() => fetchContracts(search), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [search, fetchContracts]);

  async function handleAddContract(e: React.FormEvent) {
    e.preventDefault();
    if (!addNetworkId || !addAddress) return;
    setAdding(true);
    try {
      await apiFetch("/modules/chain/contracts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          networkId: Number(addNetworkId),
          address: addAddress,
          label: addLabel || undefined,
          tags: addTags
            ? addTags.split(",").map((t) => t.trim())
            : undefined,
          fetchAbi: true,
        }),
      });
      toast("Contract added successfully", "success");
      setAddNetworkId("");
      setAddAddress("");
      setAddLabel("");
      setAddTags("");
      setShowAddForm(false);
      fetchContracts(search);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to add contract");
    } finally {
      setAdding(false);
    }
  }

  async function fetchAbiForContract(contractId: number) {
    setFetchingAbi(true);
    try {
      await apiFetch(`/modules/chain/contracts/${contractId}/fetch-abi`, {
        method: "POST",
        credentials: "include",
      });
      toast("ABI fetch initiated", "success");
      fetchContracts(search);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to fetch ABI");
    } finally {
      setFetchingAbi(false);
    }
  }

  async function loadContractDetail(contractId: number) {
    if (expandedId === contractId) {
      setExpandedId(null);
      setDetailData(null);
      return;
    }
    setExpandedId(contractId);
    setDetailLoading(true);
    try {
      const res = await apiFetch<{
        abi: unknown[];
        events: { name: string; signature: string }[];
        functions: {
          name: string;
          signature: string;
          stateMutability: string;
        }[];
      }>(`/modules/chain/contracts/${contractId}/detail`, {
        credentials: "include",
      });
      setDetailData(res);
    } catch {
      setDetailData(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function saveTagsNotes(contractId: number) {
    try {
      await apiFetch(`/modules/chain/contracts/${contractId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tags: editTags.split(",").map((t) => t.trim()).filter(Boolean),
          notes: editNotes || null,
        }),
      });
      toast("Updated successfully", "success");
      setEditingId(null);
      fetchContracts(search);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update");
    }
  }

  const networkOptions = [
    { value: "", label: "select network..." },
    ...networks.map((n) => ({
      value: String(n.id),
      label: `${n.name} (${n.chainId})`,
    })),
  ];

  return (
    <div className="space-y-8">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ chain contracts ls
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} manage monitored smart contracts
          </p>
        </div>
        <Button onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? "Cancel" : "+ Add Contract"}
        </Button>
      </div>

      {/* Navigation */}
      <NavTabs tabs={CHAIN_TABS} />

      {/* Add Contract Form */}
      {showAddForm && (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-3">
              $ chain contracts add
            </p>
            <form onSubmit={handleAddContract} className="space-y-3">
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
                    --address
                  </label>
                  <Input
                    value={addAddress}
                    onChange={(e) => setAddAddress(e.target.value)}
                    placeholder="0x..."
                    className="h-8 text-xs"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --label
                  </label>
                  <Input
                    value={addLabel}
                    onChange={(e) => setAddLabel(e.target.value)}
                    placeholder="My Contract"
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    --tags (comma-separated)
                  </label>
                  <Input
                    value={addTags}
                    onChange={(e) => setAddTags(e.target.value)}
                    placeholder="defi, vault, v2"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {">"} ABI will be auto-fetched from the block explorer on add
              </p>
              <Button type="submit" size="sm" disabled={adding}>
                {adding ? "adding..." : "$ submit"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="search contracts..."
        className="max-w-sm"
      />

      {/* Content */}
      <div className="min-h-[300px]">
        {showLoading || loading ? (
          <div className={showLoading ? "space-y-1" : "space-y-1 invisible"}>
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-center gap-x-3 px-3 py-2">
                <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
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
                onClick={() => fetchContracts(search)}
              >
                $ retry
              </Button>
            </CardContent>
          </Card>
        ) : contracts.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground">
                {">"} no contracts found
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {search
                  ? "no contracts match your search"
                  : "add your first smart contract to start monitoring"}
              </p>
              {!search && (
                <Button className="mt-4" onClick={() => setShowAddForm(true)}>
                  + Add Contract
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto animate-content-ready">
            <div className="min-w-[800px]">
              {/* Header */}
              <div className="grid grid-cols-[minmax(100px,1.2fr)_minmax(100px,0.8fr)_minmax(80px,0.6fr)_80px_minmax(80px,0.5fr)_60px_70px] gap-x-3 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <span>Label</span>
                <span>Address</span>
                <span>Network</span>
                <span>ABI</span>
                <span>Tags</span>
                <span>Detect.</span>
                <span className="text-right">Added</span>
              </div>

              <p className="px-3 pt-2 text-xs text-muted-foreground">
                {total} contract{total !== 1 ? "s" : ""}
              </p>

              {/* Rows */}
              {contracts.map((contract) => (
                <div key={contract.id}>
                  <button
                    onClick={() => loadContractDetail(contract.id)}
                    className="group grid w-full grid-cols-[minmax(100px,1.2fr)_minmax(100px,0.8fr)_minmax(80px,0.6fr)_80px_minmax(80px,0.5fr)_60px_70px] items-center gap-x-3 border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/30 text-left"
                  >
                    <span className="truncate text-foreground group-hover:text-primary font-medium">
                      {contract.label || truncateAddress(contract.address)}
                    </span>

                    <span className="truncate text-xs">
                      {contract.explorerUrl ? (
                        <a
                          href={`${contract.explorerUrl}/address/${contract.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {truncateAddress(contract.address)}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">
                          {truncateAddress(contract.address)}
                        </span>
                      )}
                    </span>

                    <span className="text-xs text-primary">
                      [{contract.networkName}]
                    </span>

                    <span
                      className={cn(
                        "text-xs font-mono",
                        abiStatusColor[contract.abiStatus] ??
                          "text-muted-foreground",
                      )}
                    >
                      [{contract.abiStatus}]
                    </span>

                    <span className="flex flex-wrap gap-1 truncate text-xs">
                      {contract.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="text-muted-foreground font-mono"
                        >
                          [{tag}]
                        </span>
                      ))}
                      {contract.tags.length > 3 && (
                        <span className="text-muted-foreground">
                          +{contract.tags.length - 3}
                        </span>
                      )}
                    </span>

                    <span className="text-xs text-muted-foreground">
                      {contract.detectionCount}
                    </span>

                    <span className="text-right text-xs text-muted-foreground">
                      {formatDate(contract.createdAt)}
                    </span>
                  </button>

                  {/* Expanded detail */}
                  {expandedId === contract.id && (
                    <div className="border-l-2 border-primary/30 bg-muted/10 ml-3 mb-2 pl-4 py-4 space-y-4">
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">
                          $ cat contract/{truncateAddress(contract.address)}/detail
                        </p>
                        <div className="flex items-center gap-2">
                          {contract.abiStatus !== "loaded" && (
                            <button
                              onClick={() =>
                                fetchAbiForContract(contract.id)
                              }
                              disabled={fetchingAbi}
                              className="text-xs text-primary hover:underline disabled:opacity-50"
                            >
                              {fetchingAbi
                                ? "[fetching...]"
                                : "[fetch ABI]"}
                            </button>
                          )}
                          <button
                            onClick={() => {
                              if (editingId === contract.id) {
                                setEditingId(null);
                              } else {
                                setEditingId(contract.id);
                                setEditTags(contract.tags.join(", "));
                                setEditNotes(contract.notes ?? "");
                              }
                            }}
                            className="text-xs text-muted-foreground hover:text-primary transition-colors"
                          >
                            {editingId === contract.id
                              ? "[cancel edit]"
                              : "[edit]"}
                          </button>
                        </div>
                      </div>

                      {/* Edit form */}
                      {editingId === contract.id && (
                        <div className="space-y-2 border-b border-border pb-3">
                          <div>
                            <label className="text-xs text-muted-foreground block mb-1">
                              tags (comma-separated)
                            </label>
                            <Input
                              value={editTags}
                              onChange={(e) => setEditTags(e.target.value)}
                              className="h-7 text-xs"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-muted-foreground block mb-1">
                              notes
                            </label>
                            <Input
                              value={editNotes}
                              onChange={(e) => setEditNotes(e.target.value)}
                              className="h-7 text-xs"
                            />
                          </div>
                          <Button
                            size="sm"
                            onClick={() => saveTagsNotes(contract.id)}
                          >
                            $ save
                          </Button>
                        </div>
                      )}

                      {detailLoading ? (
                        <div className="animate-pulse space-y-2">
                          <div className="h-3 w-48 bg-muted-foreground/20 rounded" />
                          <div className="h-3 w-36 bg-muted-foreground/20 rounded" />
                        </div>
                      ) : detailData ? (
                        <div className="space-y-3">
                          {/* Events */}
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">
                              events ({detailData.events.length})
                            </p>
                            {detailData.events.length > 0 ? (
                              <div className="space-y-0.5">
                                {detailData.events.map((ev) => (
                                  <div
                                    key={ev.signature}
                                    className="text-xs flex gap-2"
                                  >
                                    <span className="text-primary font-medium">
                                      {ev.name}
                                    </span>
                                    <span className="text-muted-foreground truncate">
                                      {ev.signature}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                no events
                              </p>
                            )}
                          </div>

                          {/* Functions */}
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">
                              functions ({detailData.functions.length})
                            </p>
                            {detailData.functions.length > 0 ? (
                              <div className="space-y-0.5">
                                {detailData.functions.map((fn) => (
                                  <div
                                    key={fn.signature}
                                    className="text-xs flex gap-2"
                                  >
                                    <span className="text-foreground font-medium">
                                      {fn.name}
                                    </span>
                                    <span
                                      className={cn(
                                        "font-mono",
                                        fn.stateMutability === "view" ||
                                          fn.stateMutability === "pure"
                                          ? "text-muted-foreground"
                                          : "text-warning",
                                      )}
                                    >
                                      [{fn.stateMutability}]
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                no functions
                              </p>
                            )}
                          </div>

                          {/* Raw ABI */}
                          <details>
                            <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                              raw ABI ({detailData.abi.length} entries)
                            </summary>
                            <pre className="mt-2 text-xs text-foreground overflow-x-auto max-h-64 overflow-y-auto bg-background p-2 border border-border">
                              {JSON.stringify(detailData.abi, null, 2)}
                            </pre>
                          </details>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          no detail data available
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
