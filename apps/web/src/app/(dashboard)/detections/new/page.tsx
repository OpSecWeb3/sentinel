"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SearchInput } from "@/components/ui/search-input";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { ToastContainer } from "@/components/ui/toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { SlackChannelPicker } from "@/components/slack-channel-picker";

/* ── types ──────────────────────────────────────────────────────── */

type ModuleId = "github" | "infra" | "chain" | "registry" | "aws";
type TemplateInputType =
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "string-array"
  | "address"
  | "contract"
  | "network";

interface TemplateInput {
  key: string;
  label: string;
  type: TemplateInputType;
  required: boolean;
  default?: string | number | boolean | string[];
  placeholder?: string;
  help?: string;
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  showIf?: string;
}

interface Template {
  id?: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  severity: string;
  ruleCount?: number;
  rules?: unknown[];
  inputs?: TemplateInput[];
}

interface Network {
  id: number;
  name: string;
  chainId: number;
}

interface ChainContract {
  id: number;
  label: string;
  address: string;
  networkId: number;
  networkName: string;
}

interface MonitoredArtifact {
  id?: string;
  name: string;
  registry: string;
}


/* ── module config ──────────────────────────────────────────────── */

interface ModuleConfig {
  id: ModuleId;
  label: string;
  api: string;
  staticCategories: string[];
  hasSearch: boolean;
  description: string;
}

const MODULES: ModuleConfig[] = [
  {
    id: "github",
    label: "github",
    api: "/modules/github/templates",
    staticCategories: [
      "access-control",
      "code-protection",
      "secrets",
      "organization",
      "comprehensive",
    ],
    hasSearch: false,
    description: "github security detection templates",
  },
  {
    id: "infra",
    label: "infra",
    api: "/modules/infra/templates",
    staticCategories: [],
    hasSearch: false,
    description: "infrastructure monitoring templates",
  },
  {
    id: "chain",
    label: "chain",
    api: "/modules/chain/templates",
    staticCategories: [],
    hasSearch: true,
    description: "on-chain detection templates",
  },
  {
    id: "registry",
    label: "registry",
    api: "/modules/registry/templates",
    staticCategories: [],
    hasSearch: false,
    description: "supply chain security templates",
  },
  {
    id: "aws",
    label: "aws",
    api: "/modules/aws/templates",
    staticCategories: [
      "identity",
      "defense-evasion",
      "network",
      "data",
      "compute",
      "reconnaissance",
      "comprehensive",
    ],
    hasSearch: false,
    description: "aws cloudtrail detection templates",
  },
];

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

/* ── helpers ────────────────────────────────────────────────────── */

function defaultStringValue(inp: TemplateInput): string {
  if (inp.default === undefined) return "";
  if (Array.isArray(inp.default)) return (inp.default as string[]).join("\n");
  return String(inp.default);
}

function parseInputValue(raw: string, type: TemplateInputType): unknown {
  if (raw === "") return undefined;
  switch (type) {
    case "number":
      return Number(raw);
    case "boolean":
      return raw === "true";
    case "string-array":
      return raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
    default:
      return raw;
  }
}

/* ── step 1: template picker ─────────────────────────────────────── */

interface TemplatePickerProps {
  initialModule: ModuleId;
  onSelect: (moduleId: ModuleId, template: Template) => void;
}

function TemplatePicker({ initialModule, onSelect }: TemplatePickerProps) {
  const router = useRouter();
  const [activeModule, setActiveModule] = useState<ModuleId>(initialModule);
  const moduleConfig = MODULES.find((m) => m.id === activeModule)!;

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = debouncedSearch
        ? `?search=${encodeURIComponent(debouncedSearch)}`
        : "";
      const res = await apiFetch<{ data: Template[] }>(
        `${moduleConfig.api}${qs}`,
        { credentials: "include" },
      );
      setTemplates(res.data);
    } catch (err) {
      if (activeModule === "registry") {
        setTemplates(getBuiltinRegistryTemplates());
      } else {
        setError(
          err instanceof Error ? err.message : "Failed to load templates",
        );
      }
    } finally {
      setLoading(false);
    }
  }, [moduleConfig.api, debouncedSearch, activeModule]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  function switchModule(id: ModuleId) {
    if (id === activeModule) return;
    setActiveModule(id);
    setTemplates([]);
    setError(null);
    setCategoryFilter("all");
    setSearchQuery("");
    setDebouncedSearch("");
    router.replace(`/detections/new?module=${id}`, { scroll: false });
  }

  const dynamicCategories = Array.from(
    new Set(templates.map((t) => t.category)),
  );
  const categories =
    moduleConfig.staticCategories.length > 0
      ? moduleConfig.staticCategories
      : dynamicCategories;

  const filteredTemplates =
    categoryFilter === "all"
      ? templates
      : templates.filter((t) => t.category === categoryFilter);

  return (
    <div className="space-y-6">
      {/* Module tabs */}
      <div className="flex items-center gap-5 border-b border-border pb-3 text-xs">
        {MODULES.map((mod) => (
          <button
            key={mod.id}
            onClick={() => switchModule(mod.id)}
            className={cn(
              "font-mono transition-colors",
              activeModule === mod.id
                ? "text-foreground"
                : "text-muted-foreground/60 hover:text-foreground",
            )}
          >
            {activeModule === mod.id ? `[${mod.label}]` : mod.label}
          </button>
        ))}
      </div>

      {/* Search (chain only) */}
      {moduleConfig.hasSearch && (
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="search templates..."
          className="max-w-sm"
        />
      )}

      {/* Category filter */}
      {!moduleConfig.hasSearch && categories.length > 0 && (
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <span className="text-muted-foreground">category</span>
          {["all", ...categories].map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={cn(
                "transition-colors",
                categoryFilter === cat
                  ? "text-foreground"
                  : "text-muted-foreground/60 hover:text-foreground",
              )}
            >
              {categoryFilter === cat ? `[${cat}]` : cat}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="min-h-[300px]">
        {(showLoading || loading) && (
          <div
            className={cn(
              "grid gap-4 sm:grid-cols-2 lg:grid-cols-3",
              !showLoading && "invisible",
            )}
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-40 animate-pulse rounded border border-border bg-muted/20"
              />
            ))}
          </div>
        )}

        {!loading && error && (
          <div className="space-y-3">
            <p className="text-sm text-destructive">[ERR] {error}</p>
            <Button variant="outline" size="sm" onClick={fetchTemplates}>
              $ retry
            </Button>
          </div>
        )}

        {!loading && !error && filteredTemplates.length === 0 && (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {">"} no templates found
            </p>
            {categoryFilter !== "all" && (
              <p className="mt-1 text-xs text-muted-foreground">
                try selecting a different category
              </p>
            )}
          </div>
        )}

        {!loading && !error && filteredTemplates.length > 0 && (
          <div className="animate-content-ready space-y-4">
            <p className="text-xs text-muted-foreground">
              {filteredTemplates.length} template
              {filteredTemplates.length !== 1 ? "s" : ""}
              {filteredTemplates.length !== templates.length
                ? ` of ${templates.length} total`
                : ""}
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredTemplates.map((template) => (
                <Card
                  key={template.slug}
                  className="flex flex-col cursor-pointer hover:border-primary transition-colors"
                  onClick={() => onSelect(activeModule, template)}
                >
                  <CardContent className="p-4 flex flex-col h-full space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">
                        {template.name}
                      </p>
                      <span
                        className={cn(
                          "shrink-0 text-xs font-mono",
                          severityColor[template.severity] ??
                            "text-muted-foreground",
                        )}
                      >
                        [{template.severity}]
                      </span>
                    </div>

                    <p className="text-xs text-muted-foreground leading-relaxed flex-1">
                      {template.description}
                    </p>

                    <div className="flex items-center gap-3 text-xs text-muted-foreground font-mono">
                      <span>cat:{template.category}</span>
                      {(template.ruleCount != null ||
                        Array.isArray(template.rules)) && (
                        <span>
                          rules:
                          {template.ruleCount ?? template.rules!.length}
                        </span>
                      )}
                    </div>

                    {template.inputs && template.inputs.filter((i) => i.required).length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        <span className="text-primary/70">requires:</span>{" "}
                        {template.inputs
                          .filter((i) => i.required)
                          .map((i) => i.label)
                          .join(", ")}
                      </p>
                    )}

                    <p className="text-xs text-primary">{">"} select →</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── step 2: configure detection ─────────────────────────────────── */

interface ConfigureDetectionProps {
  moduleId: ModuleId;
  template: Template;
  onBack: () => void;
}

function ConfigureDetection({
  moduleId,
  template,
  onBack,
}: ConfigureDetectionProps) {
  const router = useRouter();
  const { toasts, toast, dismiss } = useToast();

  const [name, setName] = useState(template.name);
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>(
    (SEVERITIES.includes(template.severity as (typeof SEVERITIES)[number])
      ? template.severity
      : "high") as (typeof SEVERITIES)[number],
  );
  const [cooldownMinutes, setCooldownMinutes] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Slack
  const [slackChannelId, setSlackChannelId] = useState("");
  const [slackChannelName, setSlackChannelName] = useState("");
  const [slackConnected, setSlackConnected] = useState(false);
  const [slackTeamName, setSlackTeamName] = useState("");

  useEffect(() => {
    apiFetch<{ connected: boolean; teamName?: string }>("/integrations/slack", { credentials: "include" })
      .then((res) => { setSlackConnected(res.connected); setSlackTeamName(res.teamName ?? ""); })
      .catch(() => {});
  }, []);

  async function fetchSlackChannels(q: string, refresh = false) {
    const params = new URLSearchParams({ q });
    if (refresh) params.set("refresh", "true");
    const res = await apiFetch<{ channels: Array<{ id: string; name: string; isPrivate: boolean }> }>(
      `/integrations/slack/channels?${params}`,
      { credentials: "include" },
    );
    return res.channels;
  }

  // Template inputs — raw string state for form fields
  const [inputValues, setInputValues] = useState<Record<string, string>>(() => {
    const defaults: Record<string, string> = {};
    for (const inp of template.inputs ?? []) {
      defaults[inp.key] = defaultStringValue(inp);
    }
    return defaults;
  });

  // Chain-specific data (fetched lazily based on template inputs)
  const [networks, setNetworks] = useState<Network[]>([]);
  const [contracts, setContracts] = useState<ChainContract[]>([]);
  const chainDataLoaded = useRef(false);

  // Release-chain artifact scope
  const [artifacts, setArtifacts] = useState<MonitoredArtifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState("");
  const userEditedName = useRef(false);

  // Infra host scope
  const [hostScope, setHostScope] = useState("");

  const hasNetworkInput = (template.inputs ?? []).some(
    (i) => i.type === "network",
  );
  const hasContractInput = (template.inputs ?? []).some(
    (i) => i.type === "contract",
  );

  // Fetch chain networks/contracts if the template has those input types
  useEffect(() => {
    if (!(hasNetworkInput || hasContractInput) || chainDataLoaded.current)
      return;
    chainDataLoaded.current = true;
    const toFetch: Promise<void>[] = [];
    if (hasNetworkInput) {
      toFetch.push(
        apiFetch<{ data: Network[] }>("/modules/chain/networks", {
          credentials: "include",
        })
          .then((res) => setNetworks(res.data))
          .catch(() => {}),
      );
    }
    if (hasContractInput) {
      toFetch.push(
        apiFetch<{ data: ChainContract[] }>(
          "/modules/chain/contracts?limit=100",
          { credentials: "include" },
        )
          .then((res) => setContracts(res.data))
          .catch(() => {}),
      );
    }
    Promise.all(toFetch);
  }, [hasNetworkInput, hasContractInput]);

  // Fetch artifacts for registry
  useEffect(() => {
    if (moduleId !== "registry") return;
    setArtifactsLoading(true);
    Promise.allSettled([
      apiFetch<{ data: MonitoredArtifact[] }>("/modules/registry/images", {
        credentials: "include",
      }),
      apiFetch<{ data: MonitoredArtifact[] }>(
        "/modules/registry/packages",
        { credentials: "include" },
      ),
    ])
      .then(([imagesRes, packagesRes]) => {
        const combined: MonitoredArtifact[] = [];
        if (imagesRes.status === "fulfilled")
          combined.push(...imagesRes.value.data);
        if (packagesRes.status === "fulfilled")
          combined.push(...packagesRes.value.data);
        setArtifacts(combined);
      })
      .finally(() => setArtifactsLoading(false));
  }, [moduleId]);

  // Sync name with artifact selection
  useEffect(() => {
    if (userEditedName.current) return;
    if (selectedArtifactId === "") {
      setName(template.name);
    } else {
      const artifact = artifacts.find(
        (a) => (a.id ?? a.name) === selectedArtifactId,
      );
      if (artifact) setName(`${template.name} — ${artifact.name}`);
    }
  }, [selectedArtifactId, artifacts, template.name]);

  function setInput(key: string, value: string) {
    setInputValues((prev) => ({ ...prev, [key]: value }));
  }

  // When a contract is selected, auto-fill the network input
  function handleContractSelect(contractId: string, inputKey: string) {
    setInput(inputKey, contractId);
    const contract = contracts.find((c) => c.address === contractId);
    if (contract) {
      const networkInput = (template.inputs ?? []).find(
        (i) => i.type === "network",
      );
      if (networkInput && !inputValues[networkInput.key]) {
        setInput(networkInput.key, String(contract.networkId));
      }
    }
  }

  // Filter contracts by selected network
  const selectedNetworkId = inputValues[
    (template.inputs ?? []).find((i) => i.type === "network")?.key ?? ""
  ];
  const filteredContracts = selectedNetworkId
    ? contracts.filter((c) => String(c.networkId) === selectedNetworkId)
    : contracts;

  function renderInput(input: TemplateInput) {
    // Conditional visibility
    if (input.showIf && !inputValues[input.showIf]) return null;

    const value = inputValues[input.key] ?? "";
    const labelEl = (
      <label className="text-xs text-muted-foreground">
        {input.label}
        {input.required && <span className="text-destructive"> *</span>}
        {input.help && (
          <span className="ml-2 text-muted-foreground/50 font-normal">
            {input.help}
          </span>
        )}
      </label>
    );

    switch (input.type) {
      case "network":
        return (
          <div key={input.key} className="space-y-1">
            {labelEl}
            <Select
              value={value}
              onValueChange={(v) => setInput(input.key, v)}
              options={[
                { value: "", label: "select network..." },
                ...networks.map((n) => ({
                  value: String(n.id),
                  label: `${n.name} (chainId: ${n.chainId})`,
                })),
              ]}
              className="w-full"
            />
          </div>
        );

      case "contract": {
        return (
          <div key={input.key} className="space-y-1">
            {labelEl}
            <Select
              value={value}
              onValueChange={(v) => handleContractSelect(v, input.key)}
              options={[
                {
                  value: "",
                  label: input.required
                    ? "select contract..."
                    : "all contracts on network",
                },
                ...filteredContracts.map((c) => ({
                  value: c.address,
                  label: `${c.label || c.address.slice(0, 10) + "..."} · ${c.networkName}`,
                })),
              ]}
              className="w-full"
            />
            {!input.required && (
              <p className="text-[10px] text-muted-foreground/60">
                leave empty to monitor all contracts on the selected network
              </p>
            )}
          </div>
        );
      }

      case "select":
        return (
          <div key={input.key} className="space-y-1">
            {labelEl}
            <Select
              value={value}
              onValueChange={(v) => setInput(input.key, v)}
              options={
                input.options?.map((o) => ({
                  value: o.value,
                  label: o.label,
                })) ?? []
              }
              className="w-full"
            />
          </div>
        );

      case "boolean":
        return (
          <div key={input.key} className="space-y-1">
            {labelEl}
            <div className="flex gap-3 text-xs">
              {(["true", "false"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setInput(input.key, opt)}
                  className={cn(
                    "transition-colors",
                    value === opt || (value === "" && opt === "true" && input.default === true)
                      ? "text-foreground"
                      : "text-muted-foreground/60 hover:text-foreground",
                  )}
                >
                  {value === opt ? `[${opt}]` : opt}
                </button>
              ))}
            </div>
          </div>
        );

      case "string-array":
        return (
          <div key={input.key} className="space-y-1">
            {labelEl}
            <textarea
              value={value}
              onChange={(e) => setInput(input.key, e.target.value)}
              placeholder={input.placeholder ?? "one value per line"}
              rows={3}
              className="w-full border-b border-input bg-transparent px-1 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary font-mono resize-none"
            />
            <p className="text-[10px] text-muted-foreground/60">
              one value per line (or comma-separated)
            </p>
          </div>
        );

      case "address":
        return (
          <div key={input.key} className="space-y-1">
            {labelEl}
            <Input
              value={value}
              onChange={(e) => setInput(input.key, e.target.value)}
              placeholder={input.placeholder ?? "0x..."}
              className="h-8 text-xs font-mono"
            />
          </div>
        );

      case "number":
        return (
          <div key={input.key} className="space-y-1">
            {labelEl}
            <Input
              type="number"
              value={value}
              onChange={(e) => setInput(input.key, e.target.value)}
              placeholder={input.placeholder ?? ""}
              min={input.min}
              max={input.max}
              className="h-8 text-xs"
            />
          </div>
        );

      default:
        return (
          <div key={input.key} className="space-y-1">
            {labelEl}
            <Input
              value={value}
              onChange={(e) => setInput(input.key, e.target.value)}
              placeholder={input.placeholder ?? ""}
              className="h-8 text-xs"
            />
          </div>
        );
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Validate required inputs
    for (const inp of template.inputs ?? []) {
      if (!inp.required) continue;
      if (inp.showIf && !inputValues[inp.showIf]) continue; // hidden
      const raw = inputValues[inp.key] ?? "";
      if (!raw.trim()) {
        toast(`"${inp.label}" is required`);
        return;
      }
    }

    setSubmitting(true);
    try {
      // Build typed inputs from raw string values
      const parsedInputs: Record<string, unknown> = {};
      for (const inp of template.inputs ?? []) {
        if (inp.showIf && !inputValues[inp.showIf]) continue; // skip hidden
        const raw = inputValues[inp.key];
        if (raw !== undefined && raw.trim() !== "") {
          parsedInputs[inp.key] = parseInputValue(raw, inp.type);
        }
      }

      // Build detection-level overrides (resource scoping)
      const overrides: Record<string, unknown> = {};
      if (moduleId === "infra") {
        const patterns = hostScope.split(",").map((s) => s.trim()).filter(Boolean);
        if (patterns.length > 0) overrides.hostScope = patterns;
      }
      if (moduleId === "registry" && selectedArtifactId) {
        const artifact = artifacts.find(
          (a) => (a.id ?? a.name) === selectedArtifactId,
        );
        if (artifact) overrides.artifactName = artifact.name;
      }

      const body: Record<string, unknown> = {
        moduleId,
        templateSlug: template.slug,
        name: name.trim() || template.name,
        severity,
        cooldownMinutes,
        inputs: parsedInputs,
        overrides,
        slackChannelId: slackChannelId || undefined,
        slackChannelName: slackChannelId ? slackChannelName || undefined : undefined,
      };

      const res = await apiFetch<{
        data: { id?: string; detection?: { id: string } };
      }>("/api/detections/from-template", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const id = res.data.id ?? res.data.detection?.id;
      router.push(id ? `/detections/${id}` : "/detections");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to create detection");
    } finally {
      setSubmitting(false);
    }
  }

  const templateInputs = template.inputs ?? [];

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      {/* Selected template summary */}
      <div className="border border-border p-4 space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">selected template</p>
          <span
            className={cn(
              "text-xs font-mono",
              severityColor[template.severity] ?? "text-muted-foreground",
            )}
          >
            [{template.severity}]
          </span>
        </div>
        <p className="text-sm text-foreground">{template.name}</p>
        <p className="text-xs text-muted-foreground">{template.description}</p>
        <p className="text-xs text-muted-foreground/60">
          module:{moduleId} · cat:{template.category}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Detection name */}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">name</label>
          <Input
            value={name}
            onChange={(e) => {
              userEditedName.current = true;
              setName(e.target.value);
            }}
            placeholder="Detection name"
            required
            autoFocus
          />
        </div>

        {/* Severity + Cooldown */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">severity</label>
            <Select
              value={severity}
              onValueChange={(v) => setSeverity(v as (typeof SEVERITIES)[number])}
              options={SEVERITIES.map((s) => ({ value: s, label: s }))}
              className="w-full"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              cooldown (min)
            </label>
            <Input
              type="number"
              min={0}
              max={1440}
              value={cooldownMinutes}
              onChange={(e) => setCooldownMinutes(Number(e.target.value))}
            />
          </div>
        </div>

        {/* Dynamic template inputs */}
        {templateInputs.length > 0 && (
          <div className="space-y-4 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">configuration</p>
            {templateInputs.map((inp) => renderInput(inp))}
          </div>
        )}

        {/* Infra: host scope */}
        {moduleId === "infra" && (
          <div className="space-y-2 border-t border-border pt-4">
            <label className="text-xs text-muted-foreground">
              host scope{" "}
              <span className="text-muted-foreground/50">
                (optional — leave empty for org-wide)
              </span>
            </label>
            <input
              type="text"
              value={hostScope}
              onChange={(e) => setHostScope(e.target.value)}
              placeholder="api.example.com, *.prod.example.com"
              className="w-full rounded border border-border bg-background px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <p className="text-[10px] text-muted-foreground">
              comma-separated hostnames or glob patterns — e.g.{" "}
              <span className="text-primary/70">*.prod.com, api.example.com</span>
            </p>
          </div>
        )}

        {/* Release-chain: artifact scope */}
        {moduleId === "registry" && (
          <div className="space-y-1 border-t border-border pt-4">
            <label className="text-xs text-muted-foreground">
              scope to artifact{" "}
              <span className="text-muted-foreground/50">(optional)</span>
            </label>
            {artifactsLoading ? (
              <p className="text-xs text-muted-foreground">
                {">"} loading artifacts...
                <span className="ml-1 animate-pulse">_</span>
              </p>
            ) : (
              <select
                value={selectedArtifactId}
                onChange={(e) => {
                  userEditedName.current = false;
                  setSelectedArtifactId(e.target.value);
                }}
                className="h-9 w-full border-b border-border bg-transparent px-1 text-xs text-foreground focus:outline-none focus:border-primary font-mono"
              >
                <option value="">No specific artifact — apply globally</option>
                {artifacts.map((a) => (
                  <option key={a.id ?? a.name} value={a.id ?? a.name}>
                    {a.name} [{a.registry}]
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* Slack channel */}
        <div className="space-y-1 border-t border-border pt-4">
          <label className="text-xs text-muted-foreground">slack channel</label>
          {slackConnected ? (
            <SlackChannelPicker
              value={slackChannelId}
              valueName={slackChannelName}
              onValueChange={(id, name) => { setSlackChannelId(id); setSlackChannelName(name); }}
              fetchChannels={fetchSlackChannels}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              <a href="/settings" className="text-primary underline underline-offset-4 hover:text-primary/80">
                Connect Slack in Settings
              </a>{" "}
              to post alerts to a channel.
            </p>
          )}
          {slackConnected && slackTeamName && (
            <p className="text-[10px] text-muted-foreground/60">{slackTeamName}</p>
          )}
        </div>

        <div className="flex gap-3 pt-2">
          <Button type="submit" disabled={submitting} className="flex-1">
            {submitting ? "> creating..." : "$ create detection"}
          </Button>
          <Button type="button" variant="outline" onClick={onBack}>
            [back]
          </Button>
        </div>
      </form>
    </div>
  );
}

/* ── page wrapper ────────────────────────────────────────────────── */

function NewDetectionPageInner() {
  const searchParams = useSearchParams();
  const paramModule = searchParams.get("module") as ModuleId | null;
  const initialModule: ModuleId = MODULES.some((m) => m.id === paramModule)
    ? paramModule!
    : "github";

  const [step, setStep] = useState<1 | 2>(1);
  const [selectedModule, setSelectedModule] = useState<ModuleId>(initialModule);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(
    null,
  );

  function handleSelect(moduleId: ModuleId, template: Template) {
    setSelectedModule(moduleId);
    setSelectedTemplate(template);
    setStep(2);
  }

  function handleBack() {
    setStep(1);
    setSelectedTemplate(null);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8 font-mono">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ detections new
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"}{" "}
            {step === 1
              ? "choose a detection template"
              : "configure detection"}
          </p>
        </div>
        <Link
          href="/detections"
          className="text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          [cancel]
        </Link>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-xs">
        <span className={step === 1 ? "text-primary" : "text-muted-foreground/50"}>
          [1] pick template
        </span>
        <span className="text-muted-foreground">→</span>
        <span className={step === 2 ? "text-primary" : "text-muted-foreground/50"}>
          [2] configure
        </span>
      </div>

      {step === 1 ? (
        <TemplatePicker initialModule={initialModule} onSelect={handleSelect} />
      ) : (
        <ConfigureDetection
          moduleId={selectedModule}
          template={selectedTemplate!}
          onBack={handleBack}
        />
      )}
    </div>
  );
}

export default function NewDetectionPage() {
  return (
    <Suspense>
      <NewDetectionPageInner />
    </Suspense>
  );
}

/* ── registry fallback templates ───────────────────────────── */

function getBuiltinRegistryTemplates(): Template[] {
  return [
    {
      slug: "registry-docker-monitor",
      name: "Docker Image Monitor",
      description:
        "Alert when a Docker image tag changes digest, a new tag appears, or a tag is removed.",
      category: "container-security",
      severity: "medium",
      rules: [{ ruleType: "registry.digest_change", action: "alert" }],
    },
    {
      slug: "registry-require-ci-attribution",
      name: "Require CI Attribution",
      description:
        "Alert when a release artifact changes without verified CI attribution.",
      category: "supply-chain",
      severity: "high",
      inputs: [
        { key: "workflows", label: "Allowed CI workflows", type: "string-array", required: false, placeholder: "build.yml\ndeploy.yml" },
        { key: "actors", label: "Allowed actors", type: "string-array", required: false, placeholder: "github-actions[bot]" },
        { key: "branches", label: "Allowed source branches", type: "string-array", required: false, placeholder: "main\nrelease/*" },
      ],
      rules: [{ ruleType: "registry.attribution", action: "alert" }],
    },
    {
      slug: "registry-enforce-signatures",
      name: "Enforce Signatures",
      description: "Alert when a Docker image lacks a cosign signature.",
      category: "supply-chain",
      severity: "critical",
      rules: [{ ruleType: "registry.security_policy", action: "alert" }],
    },
    {
      slug: "registry-enforce-provenance",
      name: "Enforce Provenance",
      description:
        "Alert when a release artifact lacks a SLSA provenance attestation.",
      category: "supply-chain",
      severity: "critical",
      inputs: [
        { key: "sourceRepo", label: "Expected source repository", type: "text", required: false, placeholder: "github.com/org/repo" },
      ],
      rules: [{ ruleType: "registry.security_policy", action: "alert" }],
    },
    {
      slug: "registry-npm-monitor",
      name: "npm Package Monitor",
      description:
        "Alert on npm version changes, install script additions, major version jumps, and maintainer changes.",
      category: "package-security",
      severity: "high",
      rules: [{ ruleType: "registry.npm_checks", action: "alert" }],
    },
    {
      slug: "registry-full-security",
      name: "Full Registry Security",
      description:
        "Enable all registry security monitors: Docker, npm, signatures, provenance, CI attribution, and anomaly detection.",
      category: "comprehensive",
      severity: "critical",
      rules: [{ ruleType: "registry.digest_change", action: "alert" }],
    },
  ];
}
