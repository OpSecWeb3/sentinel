"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { NavTabs, type NavTab } from "@/components/ui/nav-tabs";
import { SearchInput } from "@/components/ui/search-input";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { useToast } from "@/hooks/use-toast";
import { ToastContainer } from "@/components/ui/toast";

/* ── types ─────────────────────────────────────────────────────── */

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

interface TemplateInput {
  name: string;
  type: "contract" | "network" | "address" | "number" | "string";
  label: string;
  required: boolean;
  placeholder?: string;
}

interface DetectionTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  severity: string;
  category: string;
  inputs: TemplateInput[];
}

const CHAIN_TABS: NavTab[] = [
  { href: "/chain", label: "overview" },
  { href: "/chain/networks", label: "networks" },
  { href: "/chain/contracts", label: "contracts" },
  { href: "/chain/rpc", label: "rpc" },
  { href: "/chain/templates", label: "templates" },
  { href: "/chain/events", label: "events" },
  { href: "/chain/state-changes", label: "state-changes" },
];

interface TemplatesResponse {
  data: DetectionTemplate[];
  meta: { total: number };
}

interface NetworksResponse {
  data: Network[];
  meta: { total: number };
}

interface ContractsResponse {
  data: ChainContract[];
  meta: { total: number };
}

/* ── severity helpers ──────────────────────────────────────────── */

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

/* ── page ──────────────────────────────────────────────────────── */

export default function ChainTemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<DetectionTemplate[]>([]);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [contracts, setContracts] = useState<ChainContract[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const { toasts, toast, dismiss } = useToast();

  // Create detection state
  const [creatingFromTemplate, setCreatingFromTemplate] = useState<string | null>(null);
  const [createInputs, setCreateInputs] = useState<Record<string, string>>({});
  const [createName, setCreateName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Load networks and contracts for template inputs
  useEffect(() => {
    async function loadResources() {
      try {
        const [netsRes, contractsRes] = await Promise.all([
          apiFetch<NetworksResponse>("/modules/chain/networks", {
            credentials: "include",
          }),
          apiFetch<ContractsResponse>("/modules/chain/contracts?limit=100", {
            credentials: "include",
          }),
        ]);
        setNetworks(netsRes.data);
        setContracts(contractsRes.data);
      } catch {
        // silent
      }
    }
    loadResources();
  }, []);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      const qs = params.toString();
      const res = await apiFetch<TemplatesResponse>(
        `/modules/chain/templates${qs ? `?${qs}` : ""}`,
        { credentials: "include" },
      );
      setTemplates(res.data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load templates",
      );
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  function startCreateDetection(template: DetectionTemplate) {
    setCreatingFromTemplate(template.id);
    setCreateName(`${template.name} Detection`);
    const defaults: Record<string, string> = {};
    for (const input of template.inputs) {
      defaults[input.name] = "";
    }
    setCreateInputs(defaults);
  }

  async function handleCreateDetection(template: DetectionTemplate) {
    if (!createName) {
      toast("Detection name is required");
      return;
    }
    setSubmitting(true);
    try {
      const inputs: Record<string, unknown> = {};
      for (const input of template.inputs) {
        const val = createInputs[input.name];
        if (input.required && !val) {
          toast(`${input.label} is required`);
          setSubmitting(false);
          return;
        }
        if (val) {
          inputs[input.name] =
            input.type === "number" ? Number(val) : val;
        }
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
      toast(
        err instanceof Error ? err.message : "Failed to create detection",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const networkOptions = networks.map((n) => ({
    value: String(n.id),
    label: `${n.name} (${n.chainId})`,
  }));

  const contractOptions = contracts.map((c) => ({
    value: String(c.id),
    label: `${c.label || c.address.slice(0, 10)} (${c.networkName})`,
  }));

  function renderTemplateInput(input: TemplateInput) {
    const value = createInputs[input.name] ?? "";
    const onChange = (v: string) =>
      setCreateInputs((prev) => ({ ...prev, [input.name]: v }));

    if (input.type === "network") {
      return (
        <Select
          value={value}
          onValueChange={onChange}
          options={[
            { value: "", label: "select network..." },
            ...networkOptions,
          ]}
          className="w-full"
        />
      );
    }
    if (input.type === "contract") {
      return (
        <Select
          value={value}
          onValueChange={onChange}
          options={[
            { value: "", label: "select contract..." },
            ...contractOptions,
          ]}
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

  return (
    <div className="space-y-8">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ chain templates ls
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} pre-built on-chain detection templates
        </p>
      </div>

      {/* Navigation */}
      <NavTabs tabs={CHAIN_TABS} />

      {/* Search */}
      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="search templates..."
        className="max-w-sm"
      />

      {/* Content */}
      <div className="min-h-[400px]">
        {loading && (
          <div className={showLoading ? "space-y-4" : "space-y-4 invisible"}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-4 space-y-2 animate-pulse">
                  <div className="h-4 w-48 bg-muted-foreground/20 rounded" />
                  <div className="h-3 w-full bg-muted-foreground/20 rounded" />
                  <div className="h-3 w-32 bg-muted-foreground/20 rounded" />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {!loading && error && (
          <div className="space-y-2">
            <p className="text-sm text-destructive">[ERR] {error}</p>
            <Button variant="outline" size="sm" onClick={fetchTemplates}>
              $ retry
            </Button>
          </div>
        )}

        {!loading && !error && templates.length === 0 && (
          <div className="py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {">"} no chain detection templates found
            </p>
          </div>
        )}

        {!loading && !error && templates.length > 0 && (
          <div className="animate-content-ready">
            <p className="mb-3 text-xs text-muted-foreground">
              {templates.length} template{templates.length !== 1 ? "s" : ""}{" "}
              available
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((template) => {
                const isCreating = creatingFromTemplate === template.id;
                return (
                  <Card
                    key={template.id}
                    className={cn(
                      "transition-colors",
                      isCreating && "border-primary",
                    )}
                  >
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-sm font-medium text-foreground">
                            {template.name}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {template.category}
                          </p>
                        </div>
                        <span
                          className={cn(
                            "text-xs font-mono",
                            severityColor[template.severity] ??
                              "text-muted-foreground",
                          )}
                        >
                          {severityTag[template.severity] ?? `[${template.severity}]`}
                        </span>
                      </div>

                      <p className="text-xs text-muted-foreground">
                        {template.description}
                      </p>

                      {/* Required inputs display */}
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium">requires:</span>{" "}
                        {template.inputs
                          .filter((i) => i.required)
                          .map((i) => i.label)
                          .join(", ") || "none"}
                      </div>

                      {isCreating ? (
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
                          {template.inputs.map((input) => (
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
                              onClick={() =>
                                handleCreateDetection(template)
                              }
                            >
                              {submitting
                                ? "creating..."
                                : "$ create detection"}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setCreatingFromTemplate(null)
                              }
                            >
                              cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          className="w-full"
                          onClick={() => startCreateDetection(template)}
                        >
                          Create Detection
                        </Button>
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
