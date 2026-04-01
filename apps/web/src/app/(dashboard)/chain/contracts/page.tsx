"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SearchInput } from "@/components/ui/search-input";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { useToast } from "@/hooks/use-toast";
import { ToastContainer } from "@/components/ui/toast";
import {
  ConfirmDialog,
  useConfirm,
} from "@/components/ui/confirm-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { tableRowToggleKeyDown } from "@/lib/table-row-a11y";

/* ── types ─────────────────────────────────────────────────────── */

interface Network {
  id: number;
  slug: string;
  name: string;
  chainId: number;
  explorerUrl: string | null;
}

interface ChainContract {
  id: number;
  contractId: number;
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
  const [addNetworkSlug, setAddNetworkSlug] = useState("");
  const [addAddress, setAddAddress] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addTags, setAddTags] = useState("");
  const [adding, setAdding] = useState(false);
  const [fetchingAbi, setFetchingAbi] = useState(false);

  // Contract detail
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Edit tags/notes
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTags, setEditTags] = useState("");
  const [editNotes, setEditNotes] = useState("");

  // Delete
  const { confirmState, confirm, handleClose } = useConfirm();
  const [deleting, setDeleting] = useState(false);

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
    if (!addNetworkSlug || !addAddress) return;
    setAdding(true);
    try {
      await apiFetch("/modules/chain/contracts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          networkSlug: addNetworkSlug,
          address: addAddress,
          label: addLabel || undefined,
          tags: addTags
            ? addTags.split(",").map((t) => t.trim())
            : undefined,
          fetchAbi: true,
        }),
      });
      toast("Contract added successfully", "success");
      setAddNetworkSlug("");
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

  function loadContractDetail(contractId: number) {
    setExpandedId((prev) => (prev === contractId ? null : contractId));
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

  async function handleDeleteContract(contract: ChainContract) {
    const detCount = contract.detectionCount;
    const desc = detCount > 0
      ? `This will remove "${contract.label || truncateAddress(contract.address)}" and disable ${detCount} linked detection rule${detCount !== 1 ? "s" : ""}. This cannot be undone.`
      : `This will remove "${contract.label || truncateAddress(contract.address)}" from your monitored contracts. This cannot be undone.`;

    const confirmed = await confirm("Delete contract", desc, {
      variant: "destructive",
      confirmLabel: "Delete",
    });
    if (!confirmed) return;

    setDeleting(true);
    try {
      await apiFetch(`/modules/chain/contracts/${contract.contractId}`, {
        method: "DELETE",
        credentials: "include",
      });
      toast("Contract deleted", "success");
      setExpandedId(null);
      fetchContracts(search);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete contract");
    } finally {
      setDeleting(false);
    }
  }

  const networkOptions = [
    { value: "", label: "select network..." },
    ...networks.map((n) => ({
      value: n.slug,
      label: `${n.name} (${n.chainId})`,
    })),
  ];

  return (
    <div className="space-y-8">
      <ToastContainer toasts={toasts} dismiss={dismiss} />
      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        description={confirmState.description}
        variant={confirmState.variant}
        confirmLabel={confirmState.confirmLabel}
        cancelLabel={confirmState.cancelLabel}
        onClose={handleClose}
      />

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
                    value={addNetworkSlug}
                    onValueChange={setAddNetworkSlug}
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
              <Table>
                <colgroup>
                  <col />
                  <col />
                  <col className="w-[100px]" />
                  <col className="w-20" />
                  <col />
                  <col className="w-[60px]" />
                  <col className="w-[70px]" />
                </colgroup>
                <TableHeader>
                  <TableRow className="border-b border-border hover:bg-transparent">
                    <TableHead scope="col">Label</TableHead>
                    <TableHead scope="col">Address</TableHead>
                    <TableHead scope="col">Network</TableHead>
                    <TableHead scope="col">ABI</TableHead>
                    <TableHead scope="col">Tags</TableHead>
                    <TableHead scope="col">Detect.</TableHead>
                    <TableHead scope="col" className="text-right">
                      Added
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow className="border-0 hover:bg-transparent">
                    <TableCell colSpan={7} className="border-0 py-2 text-xs text-muted-foreground">
                      {total} contract{total !== 1 ? "s" : ""}
                    </TableCell>
                  </TableRow>
                  {contracts.map((contract) => {
                    const expanded = expandedId === contract.id;
                    const toggle = () => loadContractDetail(contract.id);
                    return (
                      <Fragment key={contract.id}>
                        <TableRow
                          role="button"
                          tabIndex={0}
                          aria-expanded={expanded}
                          onClick={toggle}
                          onKeyDown={(e) => tableRowToggleKeyDown(e, toggle)}
                          className="group cursor-pointer border border-transparent text-left text-sm transition-colors hover:border-border hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <TableCell className="max-w-0 font-medium text-foreground">
                            <span className="block truncate transition-colors group-hover:text-primary">
                              {contract.label || truncateAddress(contract.address)}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-0 text-xs">
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
                          </TableCell>
                          <TableCell className="text-xs text-primary">
                            [{contract.networkName}]
                          </TableCell>
                          <TableCell
                            className={cn(
                              "font-mono text-xs",
                              abiStatusColor[contract.abiStatus] ??
                                "text-muted-foreground",
                            )}
                          >
                            [{contract.abiStatus}]
                          </TableCell>
                          <TableCell className="max-w-0 text-xs">
                            <span className="flex flex-wrap gap-1 truncate">
                              {contract.tags.slice(0, 3).map((tag) => (
                                <span
                                  key={tag}
                                  className="font-mono text-muted-foreground"
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
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {contract.detectionCount}
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">
                            {formatDate(contract.createdAt)}
                          </TableCell>
                        </TableRow>
                        {expanded && (
                          <TableRow className="border-0 hover:bg-transparent">
                            <TableCell colSpan={7} className="border-l-2 border-primary/30 bg-muted/10 py-3 pl-4">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="font-mono">{contract.address}</span>
                          <span>[{contract.networkName}]</span>
                          <span>{contract.detectionCount} detection{contract.detectionCount !== 1 ? "s" : ""}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {contract.abiStatus !== "loaded" && (
                            <button
                              onClick={() => fetchAbiForContract(contract.id)}
                              disabled={fetchingAbi}
                              className="text-xs text-primary hover:underline disabled:opacity-50"
                            >
                              {fetchingAbi ? "[fetching...]" : "[fetch ABI]"}
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
                            {editingId === contract.id ? "[cancel]" : "[edit]"}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteContract(contract);
                            }}
                            disabled={deleting}
                            className="text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                          >
                            [delete]
                          </button>
                          <Link
                            href={`/chain/contracts/${contract.contractId}`}
                            className="text-xs text-primary hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            [view]
                          </Link>
                        </div>
                      </div>

                      {/* Edit form */}
                      {editingId === contract.id && (
                        <div className="space-y-2 border-t border-border pt-3">
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
                          <Button size="sm" onClick={() => saveTagsNotes(contract.id)}>
                            $ save
                          </Button>
                        </div>
                      )}
                    </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
