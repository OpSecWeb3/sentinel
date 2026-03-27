"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SearchInput } from "@/components/ui/search-input";
import { useToast } from "@/hooks/use-toast";
import { ToastContainer } from "@/components/ui/toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

/* ── types ──────────────────────────────────────────────────────── */

type ModuleId = "github" | "infra" | "chain" | "release-chain";

interface TemplateInput {
  name: string;
  type: "contract" | "network" | "address" | "number" | "string";
  label: string;
  required: boolean;
  placeholder?: string;
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

/* ── module config ──────────────────────────────────────────────── */

interface ModuleConfig {
  id: ModuleId;
  label: string;
  api: string;
  staticCategories: string[];
  hasSearch: boolean;
  hasInputs: boolean;
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
    hasInputs: false,
    description: "github security detection templates",
  },
  {
    id: "infra",
    label: "infra",
    api: "/modules/infra/templates",
    staticCategories: [],
    hasSearch: false,
    hasInputs: false,
    description: "pre-built templates for infrastructure monitoring",
  },
  {
    id: "chain",
    label: "chain",
    api: "/modules/chain/templates",
    staticCategories: [],
    hasSearch: true,
    hasInputs: true,
    description: "pre-built on-chain detection templates",
  },
  {
    id: "release-chain",
    label: "release-chain",
    api: "/modules/release-chain/templates",
    staticCategories: [],
    hasSearch: false,
    hasInputs: false,
    description: "pre-built templates for supply chain security",
  },
];

/* ── severity helpers ───────────────────────────────────────────── */

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

/* ── inner page (needs useSearchParams) ─────────────────────────── */

function TemplatesPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const paramModule = searchParams.get("module") as ModuleId | null;
  const initialModule: ModuleId =
    MODULES.some((m) => m.id === paramModule) ? paramModule! : "github";

  const [activeModule, setActiveModule] = useState<ModuleId>(initialModule);
  const moduleConfig = MODULES.find((m) => m.id === activeModule)!;

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [enableLoading, setEnableLoading] = useState<Record<string, boolean>>({});
  const [enabledSlugs, setEnabledSlugs] = useState<Set<string>>(new Set());
  const { toasts, toast, dismiss } = useToast();

  // Chain-specific state
  const [networks, setNetworks] = useState<Network[]>([]);
  const [contracts, setContracts] = useState<ChainContract[]>([]);
  const [creatingFromTemplate, setCreatingFromTemplate] = useState<string | null>(null);
  const [createInputs, setCreateInputs] = useState<Record<string, string>>({});
  const [createName, setCreateName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Load chain resources when chain tab is active
  useEffect(() => {
    if (activeModule !== "chain") return;
    apiFetch<{ data: Network[] }>("/modules/chain/networks", { credentials: "include" })
      .then((r) => setNetworks(r.data))
      .catch(() => {});
    apiFetch<{ data: ChainContract[] }>("/modules/chain/contracts?limit=100", {
      credentials: "include",
    })
      .then((r) => setContracts(r.data))
      .catch(() => {});
  }, [activeModule]);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = debouncedSearch
        ? `?${new URLSearchParams({ search: debouncedSearch })}`
        : "";
      const res = await apiFetch<{ data: Template[] }>(
        `${moduleConfig.api}${qs}`,
        { credentials: "include" },
      );
      setTemplates(res.data);
    } catch (err) {
      if (activeModule === "release-chain") {
        setTemplates(getBuiltinReleaseChainTemplates());
      } else {
        setError(err instanceof Error ? err.message : "Failed to load templates");
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
    setEnabledSlugs(new Set());
    setCreatingFromTemplate(null);
    router.replace(`/templates?module=${id}`, { scroll: false });
  }

  // Categories: static list (github) or derived from loaded templates (release-chain)
  const dynamicCategories = Array.from(new Set(templates.map((t) => t.category)));
  const categories =
    moduleConfig.staticCategories.length > 0
      ? moduleConfig.staticCategories
      : dynamicCategories;

  const filteredTemplates =
    categoryFilter === "all"
      ? templates
      : templates.filter((t) => t.category === categoryFilter);

  /* -- enable (simple modules) --------------------------------------- */

  async function enableTemplate(template: Template) {
    const key = template.slug;
    setEnableLoading((prev) => ({ ...prev, [key]: true }));
    try {
      await apiFetch("/api/detections/from-template", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateSlug: template.slug, moduleId: activeModule }),
      });
      setEnabledSlugs((prev) => new Set([...prev, key]));
      toast(`Detection created from "${template.name}"`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to enable template");
    } finally {
      setEnableLoading((prev) => ({ ...prev, [key]: false }));
    }
  }

  /* -- chain: create detection --------------------------------------- */

  function startCreateDetection(template: Template) {
    setCreatingFromTemplate(template.id ?? template.slug);
    setCreateName(`${template.name} Detection`);
    const defaults: Record<string, string> = {};
    for (const input of template.inputs ?? []) defaults[input.name] = "";
    setCreateInputs(defaults);
  }

  async function handleCreateDetection(template: Template) {
    if (!createName) {
      toast("Detection name is required");
      return;
    }
    setSubmitting(true);
    try {
      const inputs: Record<string, unknown> = {};
      for (const input of template.inputs ?? []) {
        const val = createInputs[input.name];
        if (input.required && !val) {
          toast(`${input.label} is required`);
          setSubmitting(false);
          return;
        }
        if (val) inputs[input.name] = input.type === "number" ? Number(val) : val;
      }
      const res = await apiFetch<{ data: { id: string } }>(
        "/api/detections/from-template",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateSlug: template.slug,
            moduleId: "chain",
            name: createName,
            inputs,
          }),
        },
      );
      toast("Detection created successfully", "success");
      router.push(`/detections/${res.data.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to create detection");
    } finally {
      setSubmitting(false);
    }
  }

  function renderTemplateInput(input: TemplateInput) {
    const value = createInputs[input.name] ?? "";
    const onChange = (v: string) =>
      setCreateInputs((prev) => ({ ...prev, [input.name]: v }));
    const networkOptions = networks.map((n) => ({
      value: String(n.id),
      label: `${n.name} (${n.chainId})`,
    }));
    const contractOptions = contracts.map((c) => ({
      value: String(c.id),
      label: `${c.label || c.address.slice(0, 10)} (${c.networkName})`,
    }));

    if (input.type === "network") {
      return (
        <Select
          value={value}
          onValueChange={onChange}
          options={[{ value: "", label: "select network..." }, ...networkOptions]}
          className="w-full"
        />
      );
    }
    if (input.type === "contract") {
      return (
        <Select
          value={value}
          onValueChange={onChange}
          options={[{ value: "", label: "select contract..." }, ...contractOptions]}
          className="w-full"
        />
      );
    }
    return (
      <Input
        type={input.type === "number" ? "number" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={input.placeholder ?? ""}
        className="h-8 text-xs"
      />
    );
  }

  /* ── render ─────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ templates ls --module {activeModule}
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} {moduleConfig.description}
        </p>
      </div>

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
          <span className="text-muted-foreground">--category</span>
          <button
            onClick={() => setCategoryFilter("all")}
            className={cn(
              "transition-colors",
              categoryFilter === "all"
                ? "text-foreground"
                : "text-muted-foreground/60 hover:text-foreground",
            )}
          >
            {categoryFilter === "all" ? "[all]" : "all"}
          </button>
          {categories.map((cat) => (
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
        {/* Loading skeletons */}
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

        {/* Error */}
        {!loading && error && (
          <div className="space-y-3">
            <p className="text-sm text-destructive">[ERR] {error}</p>
            <Button variant="outline" size="sm" onClick={fetchTemplates}>
              $ retry
            </Button>
          </div>
        )}

        {/* Empty */}
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

        {/* Template grid */}
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
              {filteredTemplates.map((template) => {
                const key = template.slug;
                const busy = enableLoading[key] ?? false;
                const enabled = enabledSlugs.has(key);
                const isCreating =
                  creatingFromTemplate === (template.id ?? template.slug);

                return (
                  <Card
                    key={key}
                    className={cn(
                      "flex flex-col transition-colors",
                      isCreating && "border-primary",
                    )}
                  >
                    <CardContent className="p-4 flex flex-col h-full space-y-3">
                      {/* Title + severity */}
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

                      {/* Description */}
                      <p className="text-xs text-muted-foreground leading-relaxed flex-1">
                        {template.description}
                      </p>

                      {/* Meta */}
                      <div className="flex items-center gap-3 text-xs text-muted-foreground font-mono">
                        <span>cat:{template.category}</span>
                        {template.ruleCount != null ? (
                          <span>rules:{template.ruleCount}</span>
                        ) : Array.isArray(template.rules) ? (
                          <span>rules:{template.rules.length}</span>
                        ) : null}
                      </div>

                      {/* Chain: required inputs summary */}
                      {moduleConfig.hasInputs && template.inputs && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium">requires:</span>{" "}
                          {template.inputs
                            .filter((i) => i.required)
                            .map((i) => i.label)
                            .join(", ") || "none"}
                        </p>
                      )}

                      {/* Chain: inline create form */}
                      {moduleConfig.hasInputs && isCreating ? (
                        <div className="space-y-3 border-t border-border pt-3">
                          <div>
                            <label className="text-xs text-muted-foreground block mb-1">
                              --name
                            </label>
                            <Input
                              value={createName}
                              onChange={(e) => setCreateName(e.target.value)}
                              className="h-8 text-xs"
                              required
                            />
                          </div>
                          {(template.inputs ?? []).map((input) => (
                            <div key={input.name}>
                              <label className="text-xs text-muted-foreground block mb-1">
                                --{input.name}
                                {input.required && (
                                  <span className="text-destructive"> *</span>
                                )}
                              </label>
                              {renderTemplateInput(input)}
                            </div>
                          ))}
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={submitting}
                              onClick={() => handleCreateDetection(template)}
                            >
                              {submitting ? "creating..." : "$ create detection"}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setCreatingFromTemplate(null)}
                            >
                              cancel
                            </Button>
                          </div>
                        </div>
                      ) : moduleConfig.hasInputs ? (
                        <Button
                          size="sm"
                          className="w-full"
                          onClick={() => startCreateDetection(template)}
                        >
                          Create Detection
                        </Button>
                      ) : (
                        <button
                          disabled={busy || enabled}
                          onClick={() => enableTemplate(template)}
                          className={cn(
                            "text-xs font-mono transition-colors disabled:opacity-50 text-left",
                            enabled
                              ? "text-primary"
                              : "text-muted-foreground hover:text-primary",
                          )}
                        >
                          {busy ? "..." : enabled ? "[enabled]" : "[enable]"}
                        </button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── page wrapper (Suspense for useSearchParams) ────────────────── */

export default function TemplatesPage() {
  return (
    <Suspense>
      <TemplatesPageInner />
    </Suspense>
  );
}

/* ── release-chain fallback templates ───────────────────────────── */

function getBuiltinReleaseChainTemplates(): Template[] {
  return [
    {
      slug: "release-chain-docker-monitor",
      name: "Docker Image Monitor",
      description:
        "Alert when a Docker image tag changes digest, a new tag appears, or a tag is removed.",
      category: "container-security",
      severity: "medium",
      rules: [{ ruleType: "release-chain.digest_change", action: "alert" }],
    },
    {
      slug: "release-chain-require-ci-attribution",
      name: "Require CI Attribution",
      description:
        "Alert when a release artifact changes without verified CI attribution.",
      category: "supply-chain",
      severity: "high",
      rules: [
        { ruleType: "release-chain.attribution", action: "alert" },
        { ruleType: "release-chain.attribution", action: "alert" },
      ],
    },
    {
      slug: "release-chain-enforce-signatures",
      name: "Enforce Signatures",
      description:
        "Alert when a Docker image lacks a cosign signature.",
      category: "supply-chain",
      severity: "critical",
      rules: [{ ruleType: "release-chain.security_policy", action: "alert" }],
    },
    {
      slug: "release-chain-enforce-provenance",
      name: "Enforce Provenance",
      description:
        "Alert when a release artifact lacks a SLSA provenance attestation.",
      category: "supply-chain",
      severity: "critical",
      rules: [
        { ruleType: "release-chain.security_policy", action: "alert" },
        { ruleType: "release-chain.security_policy", action: "alert" },
      ],
    },
    {
      slug: "release-chain-npm-monitor",
      name: "npm Package Monitor",
      description:
        "Alert on npm version changes, install script additions, major version jumps, and maintainer changes.",
      category: "package-security",
      severity: "high",
      rules: [
        { ruleType: "release-chain.npm_checks", action: "alert" },
        { ruleType: "release-chain.npm_checks", action: "alert" },
        { ruleType: "release-chain.npm_checks", action: "alert" },
      ],
    },
    {
      slug: "release-chain-full-security",
      name: "Full Release Chain Security",
      description:
        "Enable all release chain security monitors: Docker, npm, signatures, provenance, CI attribution, and anomaly detection.",
      category: "comprehensive",
      severity: "critical",
      rules: [
        { ruleType: "release-chain.digest_change", action: "alert" },
        { ruleType: "release-chain.security_policy", action: "alert" },
        { ruleType: "release-chain.attribution", action: "alert" },
        { ruleType: "release-chain.npm_checks", action: "alert" },
        { ruleType: "release-chain.anomaly_detection", action: "alert" },
      ],
    },
  ];
}
