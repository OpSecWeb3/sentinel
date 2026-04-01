"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ToastContainer } from "@/components/ui/toast";
import {
  ConfirmDialog,
  useConfirm,
} from "@/components/ui/confirm-dialog";
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
import { ContractCallPanel } from "@/components/contract-call-panel";

/* -- types --------------------------------------------------------- */

interface LinkedDetection {
  id: string;
  name: string;
  severity: string;
  status: string;
}

interface ContractDetail {
  id: number;
  contractId: number;
  label: string;
  tags: string[];
  notes: string | null;
  createdAt: string;
  address: string;
  name: string | null;
  abi: unknown[];
  isProxy: boolean;
  implementation: string | null;
  traits: unknown[];
  fetchedAt: string | null;
  storageLayout: unknown;
  layoutStatus: string | null;
  networkId: number;
  networkName: string;
  networkSlug: string;
  chainId: number;
  explorerUrl: string | null;
  abiEvents: { name: string; signature: string }[];
  abiFunctions: { name: string; signature: string; stateMutability: string | null; inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] }[];
  linkedDetections: LinkedDetection[];
}

/* -- helpers ------------------------------------------------------- */

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-destructive",
  medium: "text-warning",
  low: "text-primary",
  info: "text-muted-foreground",
};

function truncateAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function SectionToggle({
  title,
  count,
  open,
  onToggle,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
    >
      <span className="font-mono">{open ? "[-]" : "[+]"}</span>
      <span>{title}</span>
      {count !== undefined && (
        <span className="text-muted-foreground/60">({count})</span>
      )}
    </button>
  );
}

/* -- page ---------------------------------------------------------- */

export default function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [contract, setContract] = useState<ContractDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const { toasts, toast, dismiss } = useToast();
  const { confirmState, confirm, handleClose } = useConfirm();
  const [deleting, setDeleting] = useState(false);

  // Section open/close state
  const [openSections, setOpenSections] = useState({
    traits: true,
    proxy: true,
    detections: true,
    events: false,
    functions: false,
    storage: false,
    notes: true,
  });

  const [fetchingAbi, setFetchingAbi] = useState(false);
  const [analyzingStorage, setAnalyzingStorage] = useState(false);

  function toggle(section: keyof typeof openSections) {
    setOpenSections((s) => ({ ...s, [section]: !s[section] }));
  }

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await apiFetch<{ data: ContractDetail }>(
          `/modules/chain/contracts/${id}`,
          { credentials: "include" },
        );
        setContract(res.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load contract");
      } finally {
        setLoading(false);
      }
    }
    if (id) load();
  }, [id]);

  async function handleFetchAbi() {
    if (!contract) return;
    setFetchingAbi(true);
    try {
      await apiFetch(`/modules/chain/contracts/${contract.contractId}/fetch-abi`, {
        method: "POST",
        credentials: "include",
      });
      toast("ABI fetch queued", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to fetch ABI");
    } finally {
      setFetchingAbi(false);
    }
  }

  async function handleAnalyzeStorage() {
    if (!contract) return;
    setAnalyzingStorage(true);
    try {
      await apiFetch(`/modules/chain/contracts/${contract.contractId}/analyze-storage`, {
        method: "POST",
        credentials: "include",
      });
      toast("Storage analysis queued", "success");
      setContract((c) => c ? { ...c, layoutStatus: "pending" } : c);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to trigger analysis");
    } finally {
      setAnalyzingStorage(false);
    }
  }

  async function handleDelete() {
    if (!contract) return;
    const detCount = contract.linkedDetections.length;
    const desc = detCount > 0
      ? `This will remove "${contract.label || truncateAddress(contract.address)}" and disable ${detCount} linked detection${detCount !== 1 ? "s" : ""}. This cannot be undone.`
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
      router.push("/chain/contracts");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete contract");
    } finally {
      setDeleting(false);
    }
  }

  if (showLoading || loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-4 w-48 bg-muted rounded" />
        <div className="h-3 w-64 bg-muted rounded" />
        <div className="h-32 bg-muted rounded" />
      </div>
    );
  }

  if (error || !contract) {
    return (
      <div className="space-y-4">
        <Link
          href="/chain/contracts"
          className="text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          ← back to contracts
        </Link>
        <p className="text-sm text-destructive">[ERR] {error ?? "Contract not found"}</p>
      </div>
    );
  }

  const traits = Array.isArray(contract.traits)
    ? (contract.traits as Array<{ id?: string; name?: string; confidence?: number } | string>)
    : [];
  const storageLayout = contract.storageLayout as { storage?: { label: string; slot: string; type: string }[] } | null;
  const storageSlots = Array.isArray(storageLayout?.storage) ? storageLayout.storage as { label: string; slot: string; type: string }[] : [];

  const explorerBase = contract.explorerUrl;

  return (
    <div className="space-y-6">
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

      {/* Breadcrumb */}
      <Link
        href="/chain/contracts"
        className="text-xs text-muted-foreground hover:text-primary transition-colors"
      >
        ← chain contracts
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg text-primary text-glow font-mono">
            {contract.label || truncateAddress(contract.address)}
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {explorerBase ? (
                <a
                  href={`${explorerBase}/address/${contract.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline font-mono"
                >
                  {contract.address}
                </a>
              ) : (
                <span className="font-mono">{contract.address}</span>
              )}
            </span>
            <span>[{contract.networkName}]</span>
            <span className="text-muted-foreground/60">chain {contract.chainId}</span>
            {contract.isProxy && (
              <span className="text-warning font-mono">[proxy]</span>
            )}
            {contract.name && (
              <span className="text-foreground">{contract.name}</span>
            )}
          </div>
          {/* Tags */}
          {contract.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {contract.tags.map((tag) => (
                <span key={tag} className="text-xs text-muted-foreground font-mono">
                  [{tag}]
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {contract.abiEvents.length === 0 && contract.abiFunctions.length === 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleFetchAbi}
              disabled={fetchingAbi}
            >
              {fetchingAbi ? "[fetching...]" : "[fetch ABI]"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={handleDelete}
            disabled={deleting}
            className="text-destructive hover:text-destructive hover:border-destructive/50"
          >
            {deleting ? "[deleting...]" : "[delete]"}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {/* Traits */}
        {traits.length > 0 && (
          <Card>
            <CardContent className="p-4 space-y-2">
              <SectionToggle
                title="traits / standards"
                count={traits.length}
                open={openSections.traits}
                onToggle={() => toggle("traits")}
              />
              {openSections.traits && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {traits.map((trait) => {
                    const label = typeof trait === 'string' ? trait : trait.name ?? trait.id ?? 'unknown';
                    return (
                      <span
                        key={label}
                        className="text-xs font-mono px-2 py-0.5 border border-primary/40 text-primary rounded"
                      >
                        {label}
                      </span>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Proxy info */}
        {contract.isProxy && (
          <Card>
            <CardContent className="p-4 space-y-2">
              <SectionToggle
                title="proxy implementation"
                open={openSections.proxy}
                onToggle={() => toggle("proxy")}
              />
              {openSections.proxy && (
                <div className="pt-1">
                  {contract.implementation ? (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">impl:</span>
                      {explorerBase ? (
                        <a
                          href={`${explorerBase}/address/${contract.implementation}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline font-mono"
                        >
                          {contract.implementation}
                        </a>
                      ) : (
                        <span className="font-mono text-foreground">
                          {contract.implementation}
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      implementation address not resolved
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Linked detections */}
        <Card>
          <CardContent className="p-4 space-y-2">
            <SectionToggle
              title="linked detections"
              count={contract.linkedDetections.length}
              open={openSections.detections}
              onToggle={() => toggle("detections")}
            />
            {openSections.detections && (
              <div className="pt-1">
                {contract.linkedDetections.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    no detections reference this contract
                  </p>
                ) : (
                  <div className="space-y-1">
                    {contract.linkedDetections.map((d) => (
                      <div key={d.id} className="flex items-center gap-3 text-xs">
                        <span
                          className={cn(
                            "font-mono w-16 shrink-0",
                            severityColor[d.severity] ?? "text-muted-foreground",
                          )}
                        >
                          [{d.severity}]
                        </span>
                        <Link
                          href={`/detections/${d.id}/edit`}
                          className="text-foreground hover:text-primary transition-colors truncate"
                        >
                          {d.name}
                        </Link>
                        <span
                          className={cn(
                            "font-mono shrink-0",
                            d.status === "active"
                              ? "text-primary"
                              : "text-muted-foreground",
                          )}
                        >
                          [{d.status}]
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Notes */}
        {contract.notes && (
          <Card>
            <CardContent className="p-4 space-y-2">
              <SectionToggle
                title="notes"
                open={openSections.notes}
                onToggle={() => toggle("notes")}
              />
              {openSections.notes && (
                <p className="pt-1 text-xs text-foreground whitespace-pre-wrap leading-relaxed">
                  {contract.notes}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* ABI — Events */}
        <Card>
          <CardContent className="p-4 space-y-2">
            <SectionToggle
              title="ABI — events"
              count={contract.abiEvents.length}
              open={openSections.events}
              onToggle={() => toggle("events")}
            />
            {openSections.events && (
              <div className="pt-1">
                {contract.abiEvents.length === 0 ? (
                  <p className="text-xs text-muted-foreground">no events in ABI</p>
                ) : (
                  <Table>
                    <colgroup>
                      <col />
                      <col />
                    </colgroup>
                    <TableBody>
                      {contract.abiEvents.map((ev) => (
                        <TableRow
                          key={ev.signature}
                          className="border-0 hover:bg-transparent"
                        >
                          <TableCell className="max-w-0 py-1 text-xs font-medium text-primary">
                            <span className="block truncate">{ev.name}</span>
                          </TableCell>
                          <TableCell className="max-w-0 py-1 font-mono text-xs text-muted-foreground">
                            <span className="block truncate">{ev.signature}</span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ABI — Functions */}
        <Card>
          <CardContent className="p-4 space-y-2">
            <SectionToggle
              title="ABI — functions"
              count={contract.abiFunctions.length}
              open={openSections.functions}
              onToggle={() => toggle("functions")}
            />
            {openSections.functions && (
              <div className="pt-1">
                <ContractCallPanel
                  contractId={contract.contractId}
                  functions={contract.abiFunctions}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Storage layout */}
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between">
              <SectionToggle
                title="storage layout"
                count={storageSlots.length || undefined}
                open={openSections.storage}
                onToggle={() => toggle("storage")}
              />
              {openSections.storage && contract.layoutStatus !== "pending" && (
                <button
                  onClick={handleAnalyzeStorage}
                  disabled={analyzingStorage}
                  className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                >
                  {analyzingStorage
                    ? "[analyzing...]"
                    : storageSlots.length > 0 || contract.layoutStatus === "resolved"
                      ? "[refresh]"
                      : "[resolve]"}
                </button>
              )}
            </div>
            {openSections.storage && (
              <div className="pt-1">
                {contract.layoutStatus && (
                  <p className="text-xs text-muted-foreground mb-2">
                    status: {contract.layoutStatus}
                  </p>
                )}
                {storageSlots.length > 0 ? (
                  <Table>
                    <colgroup>
                      <col />
                      <col />
                      <col />
                    </colgroup>
                    <TableHeader>
                      <TableRow className="border-b border-border hover:bg-transparent">
                        <TableHead scope="col">Slot</TableHead>
                        <TableHead scope="col">Name</TableHead>
                        <TableHead scope="col">Type</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {storageSlots.map((s, i) => (
                        <TableRow key={i} className="border-0 hover:bg-transparent">
                          <TableCell className="max-w-0 py-1 font-mono text-xs text-muted-foreground">
                            <span className="block truncate">{s.slot}</span>
                          </TableCell>
                          <TableCell className="max-w-0 py-1 text-xs text-foreground">
                            <span className="block truncate">{s.label}</span>
                          </TableCell>
                          <TableCell className="max-w-0 py-1 font-mono text-xs text-muted-foreground">
                            <span className="block truncate">{s.type}</span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    no storage slots
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
