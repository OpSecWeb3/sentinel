"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

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
  abiFunctions: { name: string; signature: string; stateMutability: string | null }[];
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

const mutabilityColor = (m: string | null) =>
  m === "view" || m === "pure" ? "text-muted-foreground" : "text-warning";

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
  const [contract, setContract] = useState<ContractDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const { toasts, toast, dismiss } = useToast();

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

  const traits = Array.isArray(contract.traits) ? contract.traits as string[] : [];
  const storageLayout = contract.storageLayout as { storage?: { label: string; slot: string; type: string }[] } | null;
  const storageSlots = Array.isArray(storageLayout?.storage) ? storageLayout.storage as { label: string; slot: string; type: string }[] : [];

  const explorerBase = contract.explorerUrl;

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

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
                  {traits.map((trait) => (
                    <span
                      key={String(trait)}
                      className="text-xs font-mono px-2 py-0.5 border border-primary/40 text-primary rounded"
                    >
                      {String(trait)}
                    </span>
                  ))}
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
                  <div className="space-y-0.5">
                    {contract.abiEvents.map((ev) => (
                      <div key={ev.signature} className="flex gap-3 text-xs">
                        <span className="text-primary font-medium w-40 shrink-0 truncate">
                          {ev.name}
                        </span>
                        <span className="text-muted-foreground font-mono truncate">
                          {ev.signature}
                        </span>
                      </div>
                    ))}
                  </div>
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
                {contract.abiFunctions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    no functions in ABI
                  </p>
                ) : (
                  <div className="space-y-0.5">
                    {contract.abiFunctions.map((fn) => (
                      <div key={fn.signature} className="flex gap-3 text-xs">
                        <span className="text-foreground font-medium w-40 shrink-0 truncate">
                          {fn.name}
                        </span>
                        <span
                          className={cn(
                            "font-mono w-16 shrink-0",
                            mutabilityColor(fn.stateMutability),
                          )}
                        >
                          [{fn.stateMutability ?? "?"}]
                        </span>
                        <span className="text-muted-foreground font-mono truncate">
                          {fn.signature}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Storage layout */}
        {(contract.layoutStatus || storageSlots.length > 0) && (
          <Card>
            <CardContent className="p-4 space-y-2">
              <SectionToggle
                title="storage layout"
                count={storageSlots.length || undefined}
                open={openSections.storage}
                onToggle={() => toggle("storage")}
              />
              {openSections.storage && (
                <div className="pt-1">
                  {contract.layoutStatus && (
                    <p className="text-xs text-muted-foreground mb-2">
                      status: {contract.layoutStatus}
                    </p>
                  )}
                  {storageSlots.length > 0 ? (
                    <div className="space-y-0.5">
                      <div className="grid grid-cols-[60px_1fr_80px] gap-x-3 text-xs font-medium uppercase tracking-wider text-muted-foreground border-b border-border pb-1 mb-1">
                        <span>Slot</span>
                        <span>Name</span>
                        <span>Type</span>
                      </div>
                      {storageSlots.map((s, i) => (
                        <div
                          key={i}
                          className="grid grid-cols-[60px_1fr_80px] gap-x-3 text-xs"
                        >
                          <span className="font-mono text-muted-foreground">
                            {s.slot}
                          </span>
                          <span className="text-foreground truncate">{s.label}</span>
                          <span className="text-muted-foreground font-mono truncate">
                            {s.type}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      no storage slots
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
