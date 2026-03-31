"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/* ── types ─────────────────────────────────────────────────────── */

interface Detection {
  id: string;
  name: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "active" | "disabled";
  cooldownMinutes: number;
  ruleCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
}

interface Network {
  id: number;
  name: string;
  chainId: number;
  slug: string;
}

interface Template {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  severity: string;
  ruleCount: number;
  inputs: unknown[];
}

interface DetectionsResponse {
  data: Detection[];
  meta: { total: number };
}

interface NetworksResponse {
  data: Network[];
  meta: { total: number };
}

interface TemplatesResponse {
  data: Template[];
}

interface Rule {
  ruleType: string;
  config: Record<string, unknown>;
  action: string;
  priority: number;
}

/* ── helpers ───────────────────────────────────────────────────── */

const CHAIN_TABS: NavTab[] = [
  { href: "/chain", label: "overview" },
  { href: "/chain/networks", label: "networks" },
  { href: "/chain/contracts", label: "contracts" },
  { href: "/chain/detections", label: "detections" },
  { href: "/chain/rpc", label: "rpc" },
  { href: "/chain/templates", label: "templates" },
  { href: "/chain/events", label: "events" },
  { href: "/chain/state-changes", label: "state-changes" },
];

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

const severityTag: Record<string, string> = {
  critical: "[!!]",
  high: "[!]",
  medium: "[~]",
  low: "[--]",
};

function formatDate(iso: string): string {
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

function buildRulesFromTemplate(
  templateSlug: string,
  networkSlug: string,
  contractAddress: string,
  inputs: Record<string, string>,
  networkChainId?: number,
): Rule[] {
  switch (templateSlug) {
    case "chain-large-transfer":
      return [
        {
          ruleType: "chain.event_match",
          config: {
            networkSlug,
            networkId: networkChainId,
            contractAddress,
            eventSignature: "Transfer(address,address,uint256)",
            eventName: "Transfer",
            conditions: inputs.threshold
              ? [{ field: "value", operator: ">", value: inputs.threshold }]
              : [],
          },
          action: "alert",
          priority: 50,
        },
      ];
    case "chain-ownership-monitor":
      return [
        {
          ruleType: "chain.event_match",
          config: {
            networkSlug,
            networkId: networkChainId,
            contractAddress,
            eventSignature: "OwnershipTransferred(address,address)",
            eventName: "OwnershipTransferred",
            conditions: [],
          },
          action: "alert",
          priority: 50,
        },
      ];
    case "chain-fund-drainage":
      return [
        {
          ruleType: "chain.windowed_count",
          config: {
            networkSlug,
            networkId: networkChainId,
            contractAddress,
            eventSignature: "Transfer(address,address,uint256)",
            eventName: "Transfer",
            windowMinutes: Number(inputs.windowMinutes ?? 60),
            condition: {
              op: ">=",
              value: Number(inputs.countThreshold ?? 10),
            },
          },
          action: "alert",
          priority: 10,
        },
        {
          ruleType: "chain.balance_track",
          config: {
            networkSlug,
            networkId: networkChainId,
            contractAddress,
            asset: inputs.tokenAddress || "",
            windowMinutes: Number(inputs.windowMinutes ?? 60),
            condition: {
              type: "percent_change",
              value: Number(inputs.dropPercent ?? 20),
            },
          },
          action: "alert",
          priority: 20,
        },
      ];
    case "chain-proxy-upgrade":
      return [
        {
          ruleType: "chain.event_match",
          config: {
            networkSlug,
            networkId: networkChainId,
            contractAddress,
            eventSignature: "Upgraded(address)",
            eventName: "Upgraded",
            conditions: [],
          },
          action: "alert",
          priority: 50,
        },
      ];
    default:
      return [
        {
          ruleType: inputs.ruleType || "chain.event_match",
          config: {
            networkSlug,
            networkId: networkChainId,
            contractAddress,
            eventSignature: inputs.eventSignature || undefined,
          },
          action: "alert",
          priority: 50,
        },
      ];
  }
}

/* ── template card ─────────────────────────────────────────────── */

interface TemplateCard {
  slug: string;
  name: string;
  description: string;
  category: string;
  severity: string;
}

const FEATURED_TEMPLATES: TemplateCard[] = [
  {
    slug: "chain-large-transfer",
    name: "Large Transfer Monitor",
    description: "Alert when a Transfer event moves more than a threshold.",
    category: "token-activity",
    severity: "high",
  },
  {
    slug: "chain-fund-drainage",
    name: "Fund Drainage Detection",
    description: "Alert when a contract balance drains rapidly.",
    category: "balance",
    severity: "critical",
  },
  {
    slug: "chain-ownership-monitor",
    name: "Contract Ownership Monitor",
    description: "Alert on OwnershipTransferred events.",
    category: "governance",
    severity: "critical",
  },
  {
    slug: "chain-proxy-upgrade",
    name: "Proxy Upgrade Monitor",
    description: "Alert when an ERC-1967 Upgraded event is emitted.",
    category: "governance",
    severity: "critical",
  },
];

/* ── page ──────────────────────────────────────────────────────── */

export default function ChainDetectionsPage() {
  const [detections, setDetections] = useState<Detection[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const { toasts, toast, dismiss } = useToast();

  // Form visibility
  const [showForm, setShowForm] = useState(false);

  // Resources for form
  const [networks, setNetworks] = useState<Network[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);

  // Form state
  const [name, setName] = useState("");
  const [severity, setSeverity] = useState<string>("high");
  const [selectedNetwork, setSelectedNetwork] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [templateInputs, setTemplateInputs] = useState<
    Record<string, string>
  >({});
  const [cooldownMinutes, setCooldownMinutes] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /* ── data fetching ──────────────────────────────────────────── */

  const fetchDetections = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<DetectionsResponse>(
        "/modules/chain/detections",
        { credentials: "include" },
      );
      setDetections(res.data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "failed to fetch detections",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDetections();
  }, [fetchDetections]);

  useEffect(() => {
    if (!showForm) return;
    async function loadFormResources() {
      try {
        const [netsRes, tplRes] = await Promise.all([
          apiFetch<NetworksResponse>("/modules/chain/networks", {
            credentials: "include",
          }),
          apiFetch<TemplatesResponse>("/modules/chain/templates", {
            credentials: "include",
          }),
        ]);
        setNetworks(netsRes.data);
        setTemplates(tplRes.data);
      } catch {
        // silent — featured templates will still show
      }
    }
    loadFormResources();
  }, [showForm]);

  /* ── form actions ───────────────────────────────────────────── */

  function openForm() {
    setName("");
    setSeverity("high");
    setSelectedNetwork("");
    setContractAddress("");
    setSelectedTemplate("");
    setTemplateInputs({});
    setCooldownMinutes(0);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
  }

  function setInput(key: string, value: string) {
    setTemplateInputs((prev) => ({ ...prev, [key]: value }));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast("Detection name is required");
      return;
    }
    if (!selectedNetwork) {
      toast("Network is required");
      return;
    }
    if (!contractAddress.trim()) {
      toast("Contract address is required");
      return;
    }

    const networkObj = networks.find((n) => String(n.id) === selectedNetwork);
    const networkSlug = networkObj?.slug ?? selectedNetwork;
    const networkChainId = networkObj?.chainId;

    const rules = buildRulesFromTemplate(
      selectedTemplate,
      networkSlug,
      contractAddress,
      templateInputs,
      networkChainId,
    );

    setSubmitting(true);
    try {
      await apiFetch("/modules/chain/detections", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          severity,
          cooldownMinutes,
          channelIds: [],
          rules,
        }),
      });
      toast("Detection created", "success");
      closeForm();
      fetchDetections();
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "failed to create detection",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleStatus(detection: Detection) {
    const next = detection.status === "active" ? "disabled" : "active";
    try {
      await apiFetch(`/modules/chain/detections/${detection.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      toast(`Detection ${next === "active" ? "enabled" : "paused"}`, "success");
      fetchDetections();
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "failed to update detection",
      );
    }
  }

  async function handleDelete(id: string) {
    try {
      await apiFetch(`/modules/chain/detections/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      toast("Detection deleted", "success");
      setDeletingId(null);
      fetchDetections();
    } catch (err) {
      toast(
        err instanceof Error ? err.message : "failed to delete detection",
      );
    }
  }

  /* ── derived ─────────────────────────────────────────────────── */

  // Merge fetched templates with featured fallback; prefer fetched
  const displayTemplates: TemplateCard[] =
    templates.length > 0
      ? templates.filter((t) =>
          FEATURED_TEMPLATES.some((f) => f.slug === t.slug),
        )
      : FEATURED_TEMPLATES;

  const networkOptions = [
    { value: "", label: "select network..." },
    ...networks.map((n) => ({
      value: String(n.id),
      label: `${n.name} (${n.chainId})`,
    })),
  ];

  const severityOptions = [
    { value: "critical", label: "critical" },
    { value: "high", label: "high" },
    { value: "medium", label: "medium" },
    { value: "low", label: "low" },
  ];

  /* ── render ──────────────────────────────────────────────────── */

  return (
    <div className="space-y-8 font-mono">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ chain detections ls
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} manage on-chain detection rules
          </p>
        </div>
        <Button onClick={showForm ? closeForm : openForm}>
          {showForm ? "cancel" : "+ Create Detection"}
        </Button>
      </div>

      {/* Navigation */}
      <NavTabs tabs={CHAIN_TABS} />

      {/* Create Form */}
      {showForm && (
        <Card>
          <CardContent className="p-4">
            <form onSubmit={handleCreate} className="space-y-6">
              {/* Basic info */}
              <div>
                <p className="text-xs text-muted-foreground mb-3">
                  $ chain detections add --name --severity
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">
                      --name
                    </label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="My Detection"
                      className="h-8 text-xs"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">
                      --severity
                    </label>
                    <Select
                      value={severity}
                      onValueChange={setSeverity}
                      options={severityOptions}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>

              {/* Template picker */}
              <div>
                <p className="text-xs text-muted-foreground mb-3">
                  $ chain detections add --template
                </p>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {displayTemplates.map((tpl) => {
                    const isSelected = selectedTemplate === tpl.slug;
                    return (
                      <button
                        key={tpl.slug}
                        type="button"
                        onClick={() =>
                          setSelectedTemplate(isSelected ? "" : tpl.slug)
                        }
                        className={cn(
                          "text-left p-3 border-2 rounded-md transition-colors",
                          isSelected
                            ? "border-primary bg-primary/5"
                            : "border-transparent bg-muted/30 hover:border-border",
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs font-medium text-foreground">
                            {tpl.name}
                          </p>
                          <span
                            className={cn(
                              "text-xs font-mono shrink-0",
                              severityColor[tpl.severity] ??
                                "text-muted-foreground",
                            )}
                          >
                            {severityTag[tpl.severity] ??
                              `[${tpl.severity}]`}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                          {tpl.description}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground font-mono">
                          [{tpl.category}]
                        </p>
                      </button>
                    );
                  })}
                  {/* Custom option */}
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedTemplate(
                        selectedTemplate === "custom" ? "" : "custom",
                      )
                    }
                    className={cn(
                      "text-left p-3 border-2 rounded-md transition-colors",
                      selectedTemplate === "custom"
                        ? "border-primary bg-primary/5"
                        : "border-transparent bg-muted/30 hover:border-border",
                    )}
                  >
                    <p className="text-xs font-medium text-foreground">
                      Custom (manual)
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Manually configure rule type and event signature.
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground font-mono">
                      [custom]
                    </p>
                  </button>
                </div>
              </div>

              {/* Network + contract */}
              <div>
                <p className="text-xs text-muted-foreground mb-3">
                  $ chain detections add --network --contract
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">
                      --network
                      <span className="text-destructive"> *</span>
                    </label>
                    <Select
                      value={selectedNetwork}
                      onValueChange={setSelectedNetwork}
                      options={networkOptions}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">
                      --contract (optional)
                    </label>
                    <Input
                      value={contractAddress}
                      onChange={(e) => setContractAddress(e.target.value)}
                      placeholder="0x... or leave blank to monitor all"
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
              </div>

              {/* Template-specific config */}
              {selectedTemplate && (
                <div>
                  <p className="text-xs text-muted-foreground mb-3">
                    $ chain detections add --config
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {selectedTemplate === "chain-large-transfer" && (
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">
                          --threshold (wei)
                        </label>
                        <Input
                          value={templateInputs.threshold ?? ""}
                          onChange={(e) => setInput("threshold", e.target.value)}
                          placeholder="e.g. 1000000000000000000"
                          className="h-8 text-xs"
                        />
                      </div>
                    )}
                    {selectedTemplate === "chain-fund-drainage" && (
                      <>
                        <div>
                          <label className="text-xs text-muted-foreground block mb-1">
                            --window-minutes
                          </label>
                          <Input
                            type="number"
                            value={templateInputs.windowMinutes ?? ""}
                            onChange={(e) =>
                              setInput("windowMinutes", e.target.value)
                            }
                            placeholder="60"
                            className="h-8 text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground block mb-1">
                            --min-transfer-count
                          </label>
                          <Input
                            type="number"
                            value={templateInputs.countThreshold ?? ""}
                            onChange={(e) =>
                              setInput("countThreshold", e.target.value)
                            }
                            placeholder="10"
                            className="h-8 text-xs"
                          />
                        </div>
                      </>
                    )}
                    {(selectedTemplate === "chain-ownership-monitor" ||
                      selectedTemplate === "chain-proxy-upgrade") && (
                      <p className="text-xs text-muted-foreground col-span-2">
                        {">"} no additional config required for this template
                      </p>
                    )}
                    {selectedTemplate === "custom" && (
                      <>
                        <div>
                          <label className="text-xs text-muted-foreground block mb-1">
                            --rule-type
                          </label>
                          <Input
                            value={templateInputs.ruleType ?? ""}
                            onChange={(e) =>
                              setInput("ruleType", e.target.value)
                            }
                            placeholder="chain.event_match"
                            className="h-8 text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground block mb-1">
                            --event-signature
                          </label>
                          <Input
                            value={templateInputs.eventSignature ?? ""}
                            onChange={(e) =>
                              setInput("eventSignature", e.target.value)
                            }
                            placeholder="Transfer(address,address,uint256)"
                            className="h-8 text-xs"
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Cooldown */}
              <div>
                <p className="text-xs text-muted-foreground mb-3">
                  $ chain detections add --cooldown
                </p>
                <div className="max-w-[200px]">
                  <label className="text-xs text-muted-foreground block mb-1">
                    --cooldown-minutes
                  </label>
                  <Input
                    type="number"
                    value={cooldownMinutes}
                    onChange={(e) =>
                      setCooldownMinutes(Number(e.target.value))
                    }
                    placeholder="0"
                    className="h-8 text-xs"
                    min={0}
                  />
                </div>
              </div>

              <Button type="submit" size="sm" disabled={submitting}>
                {submitting ? "creating..." : "$ submit"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Detection list */}
      <div className="min-h-[300px]">
        {showLoading || loading ? (
          <div className={showLoading ? "space-y-1" : "space-y-1 invisible"}>
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-center gap-x-3 px-3 py-2">
                <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                <div className="h-3 w-12 animate-pulse rounded bg-muted" />
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
                {">"} no detections configured
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                create your first detection to start monitoring on-chain events
              </p>
              <Button className="mt-4" onClick={openForm}>
                + Create Detection
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto animate-content-ready">
            <div className="min-w-[700px]">
              <Table>
                <colgroup>
                  <col />
                  <col className="w-20" />
                  <col className="w-20" />
                  <col className="w-[60px]" />
                  <col className="w-[120px]" />
                  <col className="w-[100px]" />
                  <col className="w-[120px]" />
                </colgroup>
                <TableHeader>
                  <TableRow className="border-b border-border hover:bg-transparent">
                    <TableHead scope="col">Name</TableHead>
                    <TableHead scope="col">Severity</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col">Rules</TableHead>
                    <TableHead scope="col">Last Triggered</TableHead>
                    <TableHead scope="col">Created</TableHead>
                    <TableHead scope="col" className="text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow className="border-0 hover:bg-transparent">
                    <TableCell colSpan={7} className="border-0 py-2 text-xs text-muted-foreground">
                      {detections.length} detection
                      {detections.length !== 1 ? "s" : ""}
                    </TableCell>
                  </TableRow>
                  {detections.map((detection) => (
                    <TableRow
                      key={detection.id}
                      className="border border-transparent text-sm transition-colors hover:border-border hover:bg-muted/30"
                    >
                      <TableCell className="max-w-0 font-medium">
                        <Link
                          href={`/chain/detections/${detection.id}`}
                          className="block truncate text-foreground hover:text-primary"
                        >
                          {detection.name}
                        </Link>
                      </TableCell>
                      <TableCell
                        className={cn(
                          "font-mono text-xs",
                          severityColor[detection.severity] ??
                            "text-muted-foreground",
                        )}
                      >
                        {severityTag[detection.severity] ??
                          `[${detection.severity}]`}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "font-mono text-xs",
                          detection.status === "active"
                            ? "text-primary"
                            : "text-muted-foreground",
                        )}
                      >
                        {detection.status === "active"
                          ? "[active]"
                          : "[paused]"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {detection.ruleCount}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {detection.lastTriggeredAt
                          ? formatDate(detection.lastTriggeredAt)
                          : "--"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDate(detection.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => handleToggleStatus(detection)}
                            className="text-xs text-muted-foreground transition-colors hover:text-primary"
                          >
                            {detection.status === "active"
                              ? "[pause]"
                              : "[enable]"}
                          </button>

                          {deletingId === detection.id ? (
                            <span className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleDelete(detection.id)}
                                className="text-xs text-destructive hover:underline"
                              >
                                [confirm]
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeletingId(null)}
                                className="text-xs text-muted-foreground hover:text-foreground"
                              >
                                [cancel]
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setDeletingId(detection.id)}
                              className="text-xs text-muted-foreground transition-colors hover:text-destructive"
                            >
                              [delete]
                            </button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
