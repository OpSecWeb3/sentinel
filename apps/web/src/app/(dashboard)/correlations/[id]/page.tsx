"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { apiGet, apiFetch } from "@/lib/api";

/* ── types ───────────────────────────────────────────────────── */

interface EventFilter {
  moduleId?: string;
  eventType?: string | string[];
  conditions: Array<{ field: string; operator: string; value: unknown }>;
}

interface CrossStepCondition {
  field: string;
  operator: string;
  ref: string;
}

interface CorrelationStep {
  name: string;
  eventFilter: EventFilter;
  withinMinutes?: number;
  matchConditions: CrossStepCondition[];
}

interface CorrelationKeyField {
  field: string;
  alias?: string;
}

interface RuleConfig {
  type: "sequence" | "aggregation" | "absence";
  correlationKey: CorrelationKeyField[];
  windowMinutes: number;
  steps?: CorrelationStep[];
  aggregation?: {
    eventFilter: EventFilter;
    threshold: number;
    countField?: string;
    groupByField?: string;
  };
  absence?: {
    trigger: { eventFilter: EventFilter };
    expected: {
      eventFilter: EventFilter;
      matchConditions?: Array<{ field: string; operator: string; triggerField: string }>;
    };
    graceMinutes: number;
  };
}

interface CorrelationRule {
  id: string;
  name: string;
  description: string | null;
  severity: string;
  status: string;
  config: RuleConfig;
  channelIds: string[];
  slackChannelId: string | null;
  slackChannelName: string | null;
  cooldownMinutes: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CorrelationInstance {
  ruleId: string;
  correlationKeyHash: string;
  correlationKeyValues: Record<string, string>;
  currentStepIndex: number;
  startedAt: number;
  expiresAt: number;
  matchedSteps: Array<{
    stepName: string;
    eventId: string;
    eventType: string;
    timestamp: number;
    actor: string | null;
  }>;
}

/* ── helpers ─────────────────────────────────────────────────── */

const statusColor: Record<string, string> = {
  active: "text-primary",
  paused: "text-warning",
};

const severityColor: Record<string, string> = {
  critical: "text-destructive",
  high: "text-warning",
  medium: "text-primary",
  low: "text-muted-foreground",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function formatEpoch(ms: number): string {
  return new Date(ms).toLocaleString();
}

function renderEventFilter(ef: EventFilter) {
  const parts: string[] = [];
  if (ef.moduleId) parts.push(`module=${ef.moduleId}`);
  if (ef.eventType) {
    const types = Array.isArray(ef.eventType) ? ef.eventType : [ef.eventType];
    parts.push(`type=${types.join("|")}`);
  }
  for (const c of ef.conditions) {
    parts.push(`${c.field} ${c.operator} ${JSON.stringify(c.value)}`);
  }
  return parts.length > 0 ? parts.join(", ") : "any event";
}

/* ── page ────────────────────────────────────────────────────── */

export default function CorrelationRuleDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [rule, setRule] = useState<CorrelationRule | null>(null);
  const [instances, setInstances] = useState<CorrelationInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const { toast, toasts, dismiss } = useToast();

  // Confirm dialog
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [confirmDesc, setConfirmDesc] = useState("");
  const [confirmResolve, setConfirmResolve] = useState<
    ((value: boolean) => void) | null
  >(null);

  function confirm(title: string, description: string): Promise<boolean> {
    return new Promise((resolve) => {
      setConfirmTitle(title);
      setConfirmDesc(description);
      setConfirmResolve(() => resolve);
      setConfirmOpen(true);
    });
  }

  function handleConfirmClose(result: boolean) {
    setConfirmOpen(false);
    confirmResolve?.(result);
  }

  const fetchRule = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [ruleRes, instancesRes] = await Promise.all([
        apiGet<{ data: CorrelationRule }>(`/api/correlation-rules/${id}`),
        apiGet<{ data: CorrelationInstance[] }>(`/api/correlation-rules/${id}/instances`).catch(() => ({ data: [] })),
      ]);
      setRule(ruleRes.data);
      setInstances(instancesRes.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rule");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchRule();
  }, [fetchRule]);

  async function toggleStatus() {
    if (!rule) return;
    const newStatus = rule.status === "active" ? "paused" : "active";
    setActionLoading(true);
    try {
      await apiFetch(`/api/correlation-rules/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      setRule((prev) => prev ? { ...prev, status: newStatus } : prev);
    } catch {
      toast("Failed to update status.");
    } finally {
      setActionLoading(false);
    }
  }

  async function deleteRule() {
    if (!rule) return;
    const confirmed = await confirm(
      "Delete Correlation Rule",
      `Are you sure you want to delete "${rule.name}"? This action cannot be undone.`,
    );
    if (!confirmed) return;
    setActionLoading(true);
    try {
      await apiFetch(`/api/correlation-rules/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      router.push("/correlations");
    } catch {
      toast("Failed to delete rule.");
      setActionLoading(false);
    }
  }

  async function clearInstances() {
    const confirmed = await confirm(
      "Clear Active Instances",
      "This will reset all in-flight correlation tracking for this rule. Are you sure?",
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/api/correlation-rules/${id}/instances`, {
        method: "DELETE",
        credentials: "include",
      });
      setInstances([]);
      toast("Active instances cleared.");
    } catch {
      toast("Failed to clear instances.");
    }
  }

  /* ── loading / error ───────────────────────────────────────── */

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/correlations" className="hover:text-primary transition-colors">
            correlations
          </Link>
          <span>/</span>
          <span className="animate-pulse">loading...</span>
        </div>
        <div className="space-y-4 animate-pulse">
          <div className="h-5 w-64 rounded bg-muted" />
          <div className="h-3 w-96 rounded bg-muted" />
          <div className="h-40 rounded bg-muted" />
        </div>
      </div>
    );
  }

  if (error || !rule) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/correlations" className="hover:text-primary transition-colors">
            correlations
          </Link>
          <span>/</span>
          <span className="text-destructive">error</span>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-destructive">[ERR] {error ?? "Rule not found"}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={fetchRule}>
              $ retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const config = rule.config;

  /* ── render ────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />
      <ConfirmDialog
        open={confirmOpen}
        title={confirmTitle}
        description={confirmDesc}
        onClose={handleConfirmClose}
      />

      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/correlations" className="hover:text-primary transition-colors">
          correlations
        </Link>
        <span>/</span>
        <span className="text-foreground truncate max-w-[300px]">{rule.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ correlation inspect
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-sm text-foreground">{rule.name}</p>
          {rule.description && (
            <p className="mt-1 text-xs text-muted-foreground">{rule.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={actionLoading}
            onClick={toggleStatus}
          >
            {rule.status === "active" ? "Pause" : "Resume"}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/correlations/${rule.id}/edit`}>Edit</Link>
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={actionLoading}
            onClick={deleteRule}
          >
            Delete
          </Button>
        </div>
      </div>

      {/* Metadata */}
      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Status</p>
              <p className={cn("mt-1 font-mono", statusColor[rule.status] ?? "text-foreground")}>
                [{rule.status}]
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Severity</p>
              <p className={cn("mt-1 capitalize", severityColor[rule.severity] ?? "text-foreground")}>
                {rule.severity}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Type</p>
              <p className="mt-1">{config.type}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Window</p>
              <p className="mt-1">{config.windowMinutes} minutes</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Cooldown</p>
              <p className="mt-1">{rule.cooldownMinutes > 0 ? `${rule.cooldownMinutes}m` : "None"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Last Triggered</p>
              <p className="mt-1 text-xs">{formatDate(rule.lastTriggeredAt)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Created</p>
              <p className="mt-1 text-xs">{formatDate(rule.createdAt)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Updated</p>
              <p className="mt-1 text-xs">{formatDate(rule.updatedAt)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Correlation Key */}
      <Card>
        <CardContent className="p-4">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
            Correlation Key
          </h2>
          <div className="flex flex-wrap gap-2">
            {config.correlationKey.map((k, i) => (
              <Badge key={i} variant="outline">
                {k.alias ? `${k.alias}: ` : ""}{k.field}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Type-specific config */}
      {config.type === "sequence" && config.steps && (
        <Card>
          <CardContent className="p-4">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
              Sequence Steps ({config.steps.length})
            </h2>
            <div className="space-y-3">
              {config.steps.map((step, i) => (
                <div key={i} className="border border-border p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-primary font-mono">
                      [{i + 1}]
                    </span>
                    <span className="text-sm font-medium">{step.name}</span>
                    {step.withinMinutes && (
                      <span className="text-xs text-muted-foreground ml-auto">
                        within {step.withinMinutes}m of prev
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    filter: {renderEventFilter(step.eventFilter)}
                  </p>
                  {step.matchConditions.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      cross-step:{" "}
                      {step.matchConditions.map((mc, j) => (
                        <span key={j}>
                          {j > 0 && ", "}
                          {mc.field} {mc.operator} {mc.ref}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {config.type === "aggregation" && config.aggregation && (
        <Card>
          <CardContent className="p-4">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
              Aggregation Config
            </h2>
            <div className="space-y-2 text-sm">
              <p>
                <span className="text-muted-foreground">threshold:</span>{" "}
                {config.aggregation.threshold} events
              </p>
              <p>
                <span className="text-muted-foreground">filter:</span>{" "}
                {renderEventFilter(config.aggregation.eventFilter)}
              </p>
              {config.aggregation.countField && (
                <p>
                  <span className="text-muted-foreground">count field:</span>{" "}
                  {config.aggregation.countField}
                </p>
              )}
              {config.aggregation.groupByField && (
                <p>
                  <span className="text-muted-foreground">group by:</span>{" "}
                  {config.aggregation.groupByField}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {config.type === "absence" && config.absence && (
        <Card>
          <CardContent className="p-4">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
              Absence Config
            </h2>
            <div className="space-y-2 text-sm">
              <p>
                <span className="text-muted-foreground">trigger:</span>{" "}
                {renderEventFilter(config.absence.trigger.eventFilter)}
              </p>
              <p>
                <span className="text-muted-foreground">expected:</span>{" "}
                {renderEventFilter(config.absence.expected.eventFilter)}
              </p>
              {config.absence.expected.matchConditions && config.absence.expected.matchConditions.length > 0 && (
                <div>
                  <span className="text-muted-foreground">field matching:</span>
                  <div className="mt-1 space-y-1">
                    {config.absence.expected.matchConditions.map((mc, i) => (
                      <p key={i} className="text-xs text-muted-foreground pl-2">
                        expected.{mc.field} {mc.operator} trigger.{mc.triggerField}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              <p>
                <span className="text-muted-foreground">grace period:</span>{" "}
                {config.absence.graceMinutes} minutes
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Active Instances */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Active Instances ({instances.length})
            </h2>
            {instances.length > 0 && (
              <button
                onClick={clearInstances}
                className="text-xs text-muted-foreground hover:text-destructive transition-colors"
              >
                [clear all]
              </button>
            )}
          </div>

          {instances.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {">"} no active correlation instances
            </p>
          ) : (
            <div className="space-y-2">
              {instances.map((inst, i) => (
                <div key={i} className="border border-border p-3 text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-primary font-mono">
                      step {inst.currentStepIndex + 1}
                      {config.steps ? ` / ${config.steps.length}` : ""}
                    </span>
                    <span className="text-muted-foreground">
                      expires {formatEpoch(inst.expiresAt)}
                    </span>
                  </div>
                  <div className="text-muted-foreground">
                    key: {Object.entries(inst.correlationKeyValues).map(([k, v]) => `${k}=${v}`).join(", ")}
                  </div>
                  {inst.matchedSteps.length > 0 && (
                    <div className="text-muted-foreground">
                      matched: {inst.matchedSteps.map((s) => s.stepName).join(" → ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notification channels */}
      {(rule.channelIds.length > 0 || rule.slackChannelName) && (
        <Card>
          <CardContent className="p-4">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
              Notifications
            </h2>
            <div className="space-y-1 text-sm">
              {rule.channelIds.length > 0 && (
                <p className="text-muted-foreground">
                  {rule.channelIds.length} notification channel{rule.channelIds.length !== 1 ? "s" : ""} configured
                </p>
              )}
              {rule.slackChannelName && (
                <p className="text-muted-foreground">
                  Slack: #{rule.slackChannelName}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
