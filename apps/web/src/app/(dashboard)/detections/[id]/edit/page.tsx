"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { apiFetch, apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ToastContainer } from "@/components/ui/toast";
import { SlackChannelPicker } from "@/components/slack-channel-picker";

/* ── types ────────────────────────────────────────────────────────── */

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
  slug: string;
  name: string;
  description: string;
  severity: string;
  inputs?: TemplateInput[];
}

interface Detection {
  id: string;
  moduleId: ModuleId;
  templateId: string | null;
  name: string;
  description: string | null;
  severity: string;
  cooldownMinutes: number;
  status: string;
  config: Record<string, unknown>;
  rules: Array<{
    ruleType: string;
    config: Record<string, unknown>;
    action: string;
    priority: number;
  }>;
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


/* ── helpers ──────────────────────────────────────────────────────── */

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

function toRawString(val: unknown, type: TemplateInputType): string {
  if (val === undefined || val === null) return "";
  if (type === "string-array" && Array.isArray(val))
    return (val as string[]).join("\n");
  return String(val);
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

/* ── main page ────────────────────────────────────────────────────── */

export default function EditDetectionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toasts, toast, dismiss } = useToast();

  const [detection, setDetection] = useState<Detection | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] =
    useState<(typeof SEVERITIES)[number]>("high");
  const [cooldownMinutes, setCooldownMinutes] = useState(5);
  const [saving, setSaving] = useState(false);

  // Template input values (string-keyed raw strings for all inputs)
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

  // Chain data
  const [networks, setNetworks] = useState<Network[]>([]);
  const [contracts, setContracts] = useState<ChainContract[]>([]);
  const chainDataLoaded = useRef(false);

  // Release-chain artifacts
  const [artifacts, setArtifacts] = useState<MonitoredArtifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState("");

  // Infra host scope
  const [hostScope, setHostScope] = useState("");

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

  async function fetchSlackChannels(q: string) {
    const res = await apiFetch<{ channels: Array<{ id: string; name: string; isPrivate: boolean }> }>(
      `/integrations/slack/channels?q=${encodeURIComponent(q)}`,
      { credentials: "include" },
    );
    return res.channels;
  }

  // Legacy rule editor state (for detections without a templateId)
  const ACTIONS = ["alert", "log", "suppress"] as const;
  const [legacyRules, setLegacyRules] = useState<
    Array<{
      ruleType: string;
      action: (typeof ACTIONS)[number];
      priority: number;
    }>
  >([]);
  // Per-rule form values, keyed by field key (parallel array to legacyRules)
  const [ruleInputValues, setRuleInputValues] = useState<
    Array<Record<string, string>>
  >([]);
  // Per-rule uiSchemas fetched from /api/detections/rule-schema
  const [ruleSchemas, setRuleSchemas] = useState<Map<string, TemplateInput[]>>(
    new Map(),
  );

  /* load detection + template */
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiGet<{ data: Detection }>(`/api/detections/${id}`);
      const d = res.data;

      if (d.status === "disabled") {
        setLoadError("Archived detections cannot be edited.");
        return;
      }

      setDetection(d);
      setName(d.name);
      setDescription(d.description ?? "");
      setSeverity(d.severity as (typeof SEVERITIES)[number]);
      setCooldownMinutes(d.cooldownMinutes);
      if (d.slackChannelId) setSlackChannelId(d.slackChannelId);
      if (d.slackChannelName) setSlackChannelName(d.slackChannelName);

      if (d.templateId) {
        // Fetch the template definition so we can render proper form fields
        try {
          const tRes = await apiFetch<{ data: { template: Template } }>(
            `/api/detections/resolve-template?moduleId=${encodeURIComponent(d.moduleId)}&slug=${encodeURIComponent(d.templateId)}`,
            { credentials: "include" },
          );
          const tmpl = tRes.data.template;
          setTemplate(tmpl);

          // Pre-fill input values from detection.config (which stores { ...inputs, ...overrides })
          const prefilled: Record<string, string> = {};
          for (const inp of tmpl.inputs ?? []) {
            const saved = d.config[inp.key];
            prefilled[inp.key] =
              saved !== undefined ? toRawString(saved, inp.type) : "";
          }
          setInputValues(prefilled);

          // Pre-fill resource scoping from config
          if (d.moduleId === "infra" && Array.isArray(d.config.hostScope)) {
            setHostScope((d.config.hostScope as string[]).join(", "));
          }
          if (
            d.moduleId === "registry" &&
            typeof d.config.artifactName === "string"
          ) {
            // We'll match by name after artifacts load — store the name as the id for now
            setSelectedArtifactId(d.config.artifactName as string);
          }
        } catch {
          // Template fetch failed — fall back to legacy editor
          setTemplate(null);
          setLegacyRules(
            d.rules.map((r) => ({
              ruleType: r.ruleType,
              config: JSON.stringify(r.config, null, 2),
              action: r.action as (typeof ACTIONS)[number],
              priority: r.priority,
            })),
          );
        }
      } else {
        // No templateId — fetch rule uiSchemas, pre-fill form values from config
        setLegacyRules(
          d.rules.map((r) => ({
            ruleType: r.ruleType,
            action: r.action as (typeof ACTIONS)[number],
            priority: r.priority,
          })),
        );

        // Pre-fill per-rule input values from existing rule.config
        setRuleInputValues(
          d.rules.map((r) => {
            const vals: Record<string, string> = {};
            for (const [k, v] of Object.entries(r.config)) {
              if (Array.isArray(v))
                vals[k] = (v as string[]).join("\n");
              else if (v !== null && v !== undefined)
                vals[k] = String(v);
            }
            return vals;
          }),
        );

        // Fetch uiSchema for each unique ruleType
        const uniqueTypes = [...new Set(d.rules.map((r) => r.ruleType))];
        const schemaMap = new Map<string, TemplateInput[]>();
        await Promise.allSettled(
          uniqueTypes.map(async (ruleType) => {
            try {
              const sr = await apiFetch<{ data: { uiSchema: TemplateInput[] } }>(
                `/api/detections/rule-schema?ruleType=${encodeURIComponent(ruleType)}`,
                { credentials: "include" },
              );
              schemaMap.set(ruleType, sr.data.uiSchema);
            } catch {
              schemaMap.set(ruleType, []);
            }
          }),
        );
        setRuleSchemas(schemaMap);
      }
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load detection",
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  /* fetch chain data when relevant */
  const allRuleSchemaFields = [...ruleSchemas.values()].flat();
  const hasNetworkInput =
    (template?.inputs ?? []).some((i) => i.type === "network") ||
    allRuleSchemaFields.some((i) => i.type === "network");
  const hasContractInput =
    (template?.inputs ?? []).some((i) => i.type === "contract") ||
    allRuleSchemaFields.some((i) => i.type === "contract");

  useEffect(() => {
    if (!(hasNetworkInput || hasContractInput) || chainDataLoaded.current)
      return;
    chainDataLoaded.current = true;
    if (hasNetworkInput) {
      apiFetch<{ data: Network[] }>("/modules/chain/networks", {
        credentials: "include",
      })
        .then((r) => setNetworks(r.data))
        .catch(() => {});
    }
    if (hasContractInput) {
      apiFetch<{ data: ChainContract[] }>(
        "/modules/chain/contracts?limit=100",
        { credentials: "include" },
      )
        .then((r) => setContracts(r.data))
        .catch(() => {});
    }
  }, [hasNetworkInput, hasContractInput]);

  /* fetch artifacts for registry */
  useEffect(() => {
    if (!detection || detection.moduleId !== "registry") return;
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
        // Reconcile: selectedArtifactId may be the artifact name stored in config
        if (detection.config.artifactName) {
          const match = combined.find(
            (a) => a.name === detection.config.artifactName,
          );
          if (match) setSelectedArtifactId(match.id ?? match.name);
        }
      })
      .finally(() => setArtifactsLoading(false));
  }, [detection]);

  /* input helpers */
  function setInput(key: string, value: string) {
    setInputValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleContractSelect(contractId: string, inputKey: string) {
    setInput(inputKey, contractId);
    const contract = contracts.find((c) => c.address === contractId);
    if (contract) {
      const networkInput = (template?.inputs ?? []).find(
        (i) => i.type === "network",
      );
      if (networkInput && !inputValues[networkInput.key]) {
        setInput(networkInput.key, String(contract.networkId));
      }
    }
  }

  function setRuleInput(ruleIndex: number, key: string, value: string) {
    setRuleInputValues((prev) => {
      const next = [...prev];
      next[ruleIndex] = { ...(next[ruleIndex] ?? {}), [key]: value };
      return next;
    });
  }

  function handleRuleContractSelect(
    contractId: string,
    inputKey: string,
    ruleIndex: number,
  ) {
    setRuleInput(ruleIndex, inputKey, contractId);
    const contract = contracts.find((c) => c.address === contractId);
    if (contract) {
      const schema = ruleSchemas.get(legacyRules[ruleIndex]?.ruleType ?? "");
      const networkInput = (schema ?? []).find((i) => i.type === "network");
      if (networkInput && !(ruleInputValues[ruleIndex]?.[networkInput.key] ?? "")) {
        setRuleInput(ruleIndex, networkInput.key, String(contract.networkId));
      }
    }
  }

  function renderRuleInput(input: TemplateInput, ruleIndex: number) {
    const ruleVals = ruleInputValues[ruleIndex] ?? {};
    if (input.showIf && !ruleVals[input.showIf]) return null;

    const value = ruleVals[input.key] ?? "";
    const schema = ruleSchemas.get(legacyRules[ruleIndex]?.ruleType ?? "") ?? [];
    const selectedNet =
      ruleVals[schema.find((i) => i.type === "network")?.key ?? ""] ?? "";
    const filteredC = selectedNet
      ? contracts.filter((c) => String(c.networkId) === selectedNet)
      : contracts;

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
              onValueChange={(v) => setRuleInput(ruleIndex, input.key, v)}
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
      case "contract":
        return (
          <div key={input.key} className="space-y-1">
            {labelEl}
            <Select
              value={value}
              onValueChange={(v) =>
                handleRuleContractSelect(v, input.key, ruleIndex)
              }
              options={[
                {
                  value: "",
                  label: input.required
                    ? "select contract..."
                    : "all contracts on network",
                },
                ...filteredC.map((c) => ({
                  value: c.address,
                  label: `${c.label || c.address.slice(0, 10) + "..."} · ${c.networkName}`,
                })),
              ]}
              className="w-full"
            />
          </div>
        );
      case "select":
        return (
          <div key={input.key} className="space-y-1">
            {labelEl}
            <Select
              value={value}
              onValueChange={(v) => setRuleInput(ruleIndex, input.key, v)}
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
                  onClick={() => setRuleInput(ruleIndex, input.key, opt)}
                  className={cn(
                    "transition-colors",
                    value === opt
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
              onChange={(e) => setRuleInput(ruleIndex, input.key, e.target.value)}
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
              onChange={(e) => setRuleInput(ruleIndex, input.key, e.target.value)}
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
              onChange={(e) => setRuleInput(ruleIndex, input.key, e.target.value)}
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
              onChange={(e) => setRuleInput(ruleIndex, input.key, e.target.value)}
              placeholder={input.placeholder ?? ""}
              className="h-8 text-xs"
            />
          </div>
        );
    }
  }

  const selectedNetworkId =
    inputValues[
      (template?.inputs ?? []).find((i) => i.type === "network")?.key ?? ""
    ];
  const filteredContracts = selectedNetworkId
    ? contracts.filter((c) => String(c.networkId) === selectedNetworkId)
    : contracts;

  /* render a single template input */
  function renderInput(input: TemplateInput) {
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

      case "contract":
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
                    value === opt ||
                      (value === "" &&
                        opt === "true" &&
                        input.default === true)
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

  /* submit: template-based */
  async function handleTemplateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!detection || !template) return;

    for (const inp of template.inputs ?? []) {
      if (!inp.required) continue;
      if (inp.showIf && !inputValues[inp.showIf]) continue;
      if (!(inputValues[inp.key] ?? "").trim()) {
        toast(`"${inp.label}" is required`);
        return;
      }
    }

    setSaving(true);
    try {
      const parsedInputs: Record<string, unknown> = {};
      for (const inp of template.inputs ?? []) {
        if (inp.showIf && !inputValues[inp.showIf]) continue;
        const raw = inputValues[inp.key] ?? "";
        if (raw.trim() !== "") {
          parsedInputs[inp.key] = parseInputValue(raw, inp.type);
        }
      }

      const overrides: Record<string, unknown> = {};
      if (detection.moduleId === "infra") {
        const patterns = hostScope.split(",").map((s) => s.trim()).filter(Boolean);
        if (patterns.length > 0) overrides.hostScope = patterns;
      }
      if (detection.moduleId === "registry" && selectedArtifactId) {
        const artifact = artifacts.find(
          (a) => (a.id ?? a.name) === selectedArtifactId,
        );
        if (artifact) overrides.artifactName = artifact.name;
      }

      await apiFetch(`/api/detections/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || detection.name,
          description: description || null,
          severity,
          cooldownMinutes,
          templateSlug: template.slug,
          inputs: parsedInputs,
          overrides,
          slackChannelId: slackChannelId || null,
          slackChannelName: slackChannelId ? slackChannelName || null : null,
        }),
      });
      router.push(`/detections/${id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  /* submit: rule-schema-driven (or raw config) */
  async function handleLegacySubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const rulesPayload: Array<{
        ruleType: string;
        config: Record<string, unknown>;
        action: string;
        priority: number;
      }> = [];

      for (let i = 0; i < legacyRules.length; i++) {
        const rule = legacyRules[i];
        const schema = ruleSchemas.get(rule.ruleType);
        let config: Record<string, unknown>;

        if (schema && schema.length > 0) {
          // Build config from typed form values
          config = {};
          for (const inp of schema) {
            const raw = ruleInputValues[i]?.[inp.key] ?? "";
            if (raw.trim() !== "") {
              config[inp.key] = parseInputValue(raw, inp.type);
            }
          }
        } else {
          // No schema — preserve existing config from ruleInputValues (raw key=value)
          config = Object.fromEntries(
            Object.entries(ruleInputValues[i] ?? {}).filter(
              ([, v]) => v.trim() !== "",
            ),
          );
        }

        rulesPayload.push({
          ruleType: rule.ruleType,
          config,
          action: rule.action,
          priority: rule.priority,
        });
      }

      await apiFetch(`/api/detections/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || null,
          severity,
          cooldownMinutes,
          rules: rulesPayload,
          slackChannelId: slackChannelId || null,
          slackChannelName: slackChannelId ? slackChannelName || null : null,
        }),
      });
      router.push(`/detections/${id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  /* ── render ─────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="mx-auto max-w-xl space-y-4 font-mono animate-pulse">
        <div className="h-5 w-48 rounded bg-muted" />
        <div className="h-8 rounded bg-muted" />
        <div className="h-8 rounded bg-muted" />
        <div className="h-24 rounded bg-muted" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-8 font-mono">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ detection edit
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} update detection settings and rules
          </p>
        </div>
        <Link
          href={`/detections/${id}`}
          className="text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          [cancel]
        </Link>
      </div>

      {loadError && (
        <p className="text-xs text-destructive">[ERR] {loadError}</p>
      )}

      {!loadError && detection && template && (
        /* ── TEMPLATE-BASED FORM ─────────────────────────────────── */
        <>
          {/* Template badge */}
          <div className="border border-border p-3 space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">template</p>
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
            <p className="text-xs text-muted-foreground/70">
              {template.description}
            </p>
          </div>

          <form onSubmit={handleTemplateSubmit} className="space-y-5">
            {/* Name */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>

            {/* Description */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                description{" "}
                <span className="text-muted-foreground/50">(optional)</span>
              </label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this detection monitor?"
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
                <label className="text-xs text-muted-foreground">cooldown (min)</label>
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
            {(template.inputs ?? []).length > 0 && (
              <div className="space-y-4 border-t border-border pt-4">
                <p className="text-xs text-muted-foreground">
                  configuration
</p>
                {(template.inputs ?? []).map((inp) => renderInput(inp))}
              </div>
            )}

            {/* Infra: host scope */}
            {detection.moduleId === "infra" && (
              <div className="space-y-2 border-t border-border pt-4">
                <p className="text-xs text-muted-foreground">
                  host scope{" "}
                  <span className="text-muted-foreground/50">
                    (leave empty to apply to all hosts)
                  </span>
                </p>
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
            {detection.moduleId === "registry" && (
              <div className="space-y-2 border-t border-border pt-4">
                <p className="text-xs text-muted-foreground">
                  artifact scope{" "}
                  <span className="text-muted-foreground/50">(optional)</span>
                </p>
                {artifactsLoading ? (
                  <p className="text-xs text-muted-foreground animate-pulse">
                    loading artifacts...
                  </p>
                ) : (
                  <Select
                    value={selectedArtifactId}
                    onValueChange={setSelectedArtifactId}
                    options={[
                      { value: "", label: "all artifacts" },
                      ...artifacts.map((a) => ({
                        value: a.id ?? a.name,
                        label: `${a.name} (${a.registry})`,
                      })),
                    ]}
                    className="w-full"
                  />
                )}
              </div>
            )}

            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">
                slack channel{" "}
                <span className="text-muted-foreground/50">(optional)</span>
              </p>
              {slackConnected ? (
                <SlackChannelPicker
                  value={slackChannelId}
                  valueName={slackChannelName}
                  onValueChange={(id, name) => {
                    setSlackChannelId(id);
                    setSlackChannelName(name);
                  }}
                  fetchChannels={fetchSlackChannels}
                />
              ) : (
                <p className="text-xs text-muted-foreground/60">
                  Connect Slack in{" "}
                  <a href="/settings" className="underline hover:text-foreground">
                    Settings
                  </a>{" "}
                  to enable notifications.
                </p>
              )}
            </div>

            <Button type="submit" className="w-full" disabled={saving}>
              {saving ? "> saving..." : "$ save changes"}
            </Button>
          </form>
        </>
      )}

      {!loadError && detection && !template && (
        /* ── LEGACY JSON EDITOR (no templateId or template fetch failed) ── */
        <form onSubmit={handleLegacySubmit} className="space-y-6">
          {/* Name */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>

          {/* Description */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              description{" "}
              <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this detection monitor?"
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

          {/* Rules — schema-driven forms */}
          <div className="space-y-3">
            <label className="text-xs text-muted-foreground">rules</label>

            {legacyRules.map((rule, i) => {
              const schema = ruleSchemas.get(rule.ruleType) ?? [];
              return (
                <div key={i} className="space-y-3 border border-border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-foreground font-mono">
                      {rule.ruleType}
                    </span>
                    <div className="flex items-center gap-3 text-xs">
                      {/* action picker */}
                      {ACTIONS.map((a) => (
                        <button
                          key={a}
                          type="button"
                          onClick={() =>
                            setLegacyRules((prev) =>
                              prev.map((r, idx) =>
                                idx === i ? { ...r, action: a } : r,
                              ),
                            )
                          }
                          className={
                            rule.action === a
                              ? "text-foreground"
                              : "text-muted-foreground/60 hover:text-foreground transition-colors"
                          }
                        >
                          {rule.action === a ? `[${a}]` : a}
                        </button>
                      ))}
                    </div>
                  </div>

                  {schema.length > 0 ? (
                    /* schema-driven fields */
                    <div className="space-y-3 border-t border-border pt-3">
                      {schema.map((inp) => renderRuleInput(inp, i))}
                    </div>
                  ) : (
                    /* fallback: no schema — show raw key=value pairs */
                    <div className="space-y-2 border-t border-border pt-3">
                      <p className="text-[10px] text-muted-foreground/60">
                        no schema available — editing raw config fields
                      </p>
                      {Object.keys(ruleInputValues[i] ?? {}).map((k) => (
                        <div key={k} className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground w-32 shrink-0 font-mono">
                            {k}
                          </span>
                          <Input
                            value={ruleInputValues[i]?.[k] ?? ""}
                            onChange={(e) =>
                              setRuleInput(i, k, e.target.value)
                            }
                            className="h-7 text-xs font-mono"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              slack channel{" "}
              <span className="text-muted-foreground/50">(optional)</span>
            </p>
            {slackConnected ? (
              <SlackChannelPicker
                value={slackChannelId}
                valueName={slackChannelName}
                onValueChange={(id, name) => {
                  setSlackChannelId(id);
                  setSlackChannelName(name);
                }}
                fetchChannels={fetchSlackChannels}
              />
            ) : (
              <p className="text-xs text-muted-foreground/60">
                Connect Slack in{" "}
                <a href="/settings" className="underline hover:text-foreground">
                  Settings
                </a>{" "}
                to enable notifications.
              </p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? "> saving..." : "$ save changes"}
          </Button>
        </form>
      )}
    </div>
  );
}
