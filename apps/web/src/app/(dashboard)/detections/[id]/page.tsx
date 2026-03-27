"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { apiGet, apiFetch } from "@/lib/api";

/* ── types ───────────────────────────────────────────────────── */

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
}

interface Template {
  slug: string;
  name: string;
  description: string;
  severity: string;
  inputs?: TemplateInput[];
}

interface Rule {
  id: string;
  ruleType: string;
  config: Record<string, unknown>;
  action: string;
  priority: number;
  status: string;
}

interface Detection {
  id: string;
  moduleId: string;
  templateId: string | null;
  name: string;
  description: string | null;
  severity: string;
  status: string;
  cooldownMinutes: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  config: Record<string, unknown>;
  rules: Rule[];
}

/* ── helpers ─────────────────────────────────────────────────── */

const statusColor: Record<string, string> = {
  active: "text-primary",
  paused: "text-warning",
  error: "text-destructive",
  disabled: "text-muted-foreground",
};

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

/** True if value is still an unfilled {{placeholder}} */
function isPlaceholder(val: unknown): boolean {
  return typeof val === "string" && /^\{\{.+\}\}$/.test(val);
}

/** Check all rule configs recursively for any unfilled {{placeholder}} tokens */
function hasUnfilledPlaceholders(rules: Rule[]): boolean {
  function check(val: unknown): boolean {
    if (isPlaceholder(val)) return true;
    if (Array.isArray(val)) return val.some(check);
    if (val && typeof val === "object")
      return Object.values(val as Record<string, unknown>).some(check);
    return false;
  }
  return rules.some((r) => check(r.config));
}

/** Format a config value for display */
function displayValue(val: unknown, type: TemplateInputType): string {
  if (val === undefined || val === null || val === "") return "";
  if (isPlaceholder(val)) return "";
  if (type === "string-array" && Array.isArray(val))
    return (val as string[]).join(", ");
  if (type === "boolean") return val ? "true" : "false";
  return String(val);
}

/* ── page ────────────────────────────────────────────────────── */

export default function DetectionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [detection, setDetection] = useState<Detection | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchDetection = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ data: Detection }>(`/api/detections/${id}`);
      const d = res.data;
      setDetection(d);

      // If this detection came from a template, fetch its definition so we can
      // render the inputs as a human-readable configuration panel.
      if (d.templateId) {
        apiFetch<{ data: { template: Template } }>(
          `/api/detections/resolve-template?moduleId=${encodeURIComponent(d.moduleId)}&slug=${encodeURIComponent(d.templateId)}`,
          { credentials: "include" },
        )
          .then((r) => setTemplate(r.data.template))
          .catch(() => {
            /* non-fatal — fall back to rule display */
          });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load detection");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDetection();
  }, [fetchDetection]);

  async function toggleStatus() {
    if (!detection) return;
    const newStatus = detection.status === "active" ? "paused" : "active";
    setActionLoading(true);
    try {
      await apiFetch(`/api/detections/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      setDetection((prev) =>
        prev ? { ...prev, status: newStatus } : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setActionLoading(false);
    }
  }

  async function archiveDetection() {
    if (!confirm(`Archive "${detection?.name}"?`)) return;
    setActionLoading(true);
    try {
      await apiFetch(`/api/detections/${id}`, { method: "DELETE" });
      router.push("/detections");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to archive detection",
      );
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 font-mono animate-pulse">
        <div className="h-5 w-48 rounded bg-muted" />
        <div className="h-3 w-64 rounded bg-muted" />
        <div className="h-24 rounded bg-muted" />
      </div>
    );
  }

  if (error || !detection) {
    return (
      <div className="font-mono space-y-3">
        <p className="text-sm text-destructive">
          [ERR] {error ?? "Detection not found"}
        </p>
        <Button variant="outline" size="sm" onClick={fetchDetection}>
          $ retry
        </Button>
      </div>
    );
  }

  const unfilled = hasUnfilledPlaceholders(detection.rules);
  const templateInputs = template?.inputs ?? [];

  return (
    <div className="space-y-6 font-mono">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground mb-1">
            <Link
              href="/detections"
              className="hover:text-primary transition-colors"
            >
              detections
            </Link>
            {" / "}
            <span className="text-foreground">{detection.id.slice(0, 8)}</span>
          </p>
          <h1 className="text-lg text-primary text-glow">
            $ detection inspect
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} {detection.name}
          </p>
        </div>

        {detection.status !== "disabled" && (
          <div className="flex items-center gap-2 shrink-0">
            <Link
              href={`/detections/${id}/edit`}
              className="text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              [edit]
            </Link>
            <button
              disabled={actionLoading || detection.status === "error"}
              onClick={toggleStatus}
              className="text-xs text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
            >
              {actionLoading
                ? "..."
                : detection.status === "active"
                  ? "[pause]"
                  : "[resume]"}
            </button>
            <button
              disabled={actionLoading}
              onClick={archiveDetection}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
            >
              [archive]
            </button>
          </div>
        )}
      </div>

      {/* Unfilled placeholder warning */}
      {unfilled && (
        <div className="border border-warning/40 bg-warning/5 p-3 space-y-1">
          <p className="text-xs text-warning">
            [!] this detection has unconfigured inputs — rules will not fire correctly
          </p>
          <p className="text-xs text-muted-foreground">
            {">"} open the editor to fill in the required values (network,
            contract, thresholds, etc.)
          </p>
          <Link
            href={`/detections/${id}/edit`}
            className="text-xs text-primary hover:underline"
          >
            [configure now →]
          </Link>
        </div>
      )}

      {/* Meta */}
      <Card>
        <CardContent className="p-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
          {[
            {
              key: "STATUS",
              value: detection.status,
              className: statusColor[detection.status],
            },
            {
              key: "SEVERITY",
              value: detection.severity,
              className:
                severityColor[detection.severity] ?? "text-muted-foreground",
            },
            {
              key: "MODULE",
              value: detection.moduleId,
              className: "text-foreground",
            },
            {
              key: "COOLDOWN",
              value: `${detection.cooldownMinutes}m`,
              className: "text-foreground",
            },
            {
              key: "RULES",
              value: String(detection.rules.length),
              className: "text-foreground",
            },
            {
              key: "LAST_ALERT",
              value: detection.lastTriggeredAt
                ? new Date(detection.lastTriggeredAt).toLocaleString()
                : "Never",
              className: "text-muted-foreground",
            },
          ].map(({ key, value, className }) => (
            <div key={key}>
              <p className="text-muted-foreground">{key}</p>
              <p className={cn("mt-0.5 font-mono uppercase", className)}>
                {value}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Description */}
      {detection.description && (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">$ cat description</p>
          <p className="text-sm text-foreground">{detection.description}</p>
        </div>
      )}

      {/* Template + configuration */}
      {detection.templateId && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">$ cat config</p>

          {/* Template badge */}
          <div className="border border-border p-3 space-y-1">
            <p className="text-xs text-muted-foreground">template</p>
            <p className="text-sm text-foreground">
              {template?.name ?? detection.templateId}
            </p>
            {template?.description && (
              <p className="text-xs text-muted-foreground/70">
                {template.description}
              </p>
            )}
          </div>

          {/* Input values */}
          {templateInputs.length > 0 && (
            <div className="border border-border divide-y divide-border">
              {templateInputs.map((inp) => {
                const raw = detection.config[inp.key];
                const val = displayValue(raw, inp.type);
                const missing = val === "" && inp.required;
                const unfill = isPlaceholder(raw);

                return (
                  <div
                    key={inp.key}
                    className="flex items-start justify-between gap-4 px-3 py-2 text-xs"
                  >
                    <span className="text-muted-foreground shrink-0">
                      {inp.label}
                    </span>
                    {unfill || missing ? (
                      <span className="text-warning font-mono">
                        [not configured]
                      </span>
                    ) : val ? (
                      <span className="text-foreground font-mono text-right break-all">
                        {val}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50 font-mono">
                        —
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Resource scoping: infra hostIds */}
          {detection.moduleId === "infra" &&
            Array.isArray(detection.config.hostIds) &&
            (detection.config.hostIds as string[]).length > 0 && (
              <div className="border border-border px-3 py-2 text-xs space-y-1">
                <p className="text-muted-foreground">scope · hosts</p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {(detection.config.hostIds as string[]).map((h) => (
                    <span
                      key={h}
                      className="border border-border px-1.5 py-0.5 text-foreground font-mono"
                    >
                      {h}
                    </span>
                  ))}
                </div>
              </div>
            )}

          {/* Resource scoping: registry artifactName */}
          {detection.moduleId === "registry" &&
            !!detection.config.artifactName && (
              <div className="border border-border px-3 py-2 text-xs flex items-center justify-between">
                <span className="text-muted-foreground">scope · artifact</span>
                <span className="text-foreground font-mono">
                  {String(detection.config.artifactName)}
                </span>
              </div>
            )}
        </div>
      )}

      {/* Rules */}
      <div>
        <p className="mb-3 text-xs text-muted-foreground">$ rules ls</p>
        <div className="space-y-2">
          {detection.rules.map((rule, i) => {
            const ruleHasPlaceholders = hasUnfilledPlaceholders([rule]);

            return (
              <Card key={rule.id}>
                <CardContent className="p-3 text-xs space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-foreground font-mono">
                      {rule.ruleType}
                    </span>
                    <div className="flex items-center gap-3">
                      <Badge variant="secondary">{rule.action}</Badge>
                      <span className="text-muted-foreground">
                        p:{rule.priority}
                      </span>
                      <span
                        className={
                          rule.status === "active"
                            ? "text-primary"
                            : "text-muted-foreground"
                        }
                      >
                        [{rule.status}]
                      </span>
                    </div>
                  </div>

                  {ruleHasPlaceholders && (
                    <p className="text-warning text-[10px]">
                      [!] rule[{i}] has unconfigured inputs —{" "}
                      <Link
                        href={`/detections/${id}/edit`}
                        className="underline"
                      >
                        configure →
                      </Link>
                    </p>
                  )}

                  {/* Only show config for rules without placeholders —
                      if there are placeholders, the config is meaningless raw JSON */}
                  {!ruleHasPlaceholders &&
                    !detection.templateId &&
                    Object.keys(rule.config).length > 0 && (
                      <pre className="text-muted-foreground overflow-x-auto text-xs">
                        {JSON.stringify(rule.config, null, 2)}
                      </pre>
                    )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Timestamps */}
      <div className="flex gap-6 text-xs text-muted-foreground">
        <span>created: {new Date(detection.createdAt).toLocaleString()}</span>
        <span>updated: {new Date(detection.updatedAt).toLocaleString()}</span>
      </div>
    </div>
  );
}
