"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/lib/api";

/* -- types --------------------------------------------------------- */

interface Integration {
  id: string;
  name: string;
  accountId: string;
  isOrgIntegration: boolean;
  awsOrgId: string | null;
  connectedAccounts: string[];
  sqsQueueUrl: string | null;
  sqsRegion: string;
  regions: string[];
  enabled: boolean;
  status: string;
  errorMessage: string | null;
  lastPolledAt: string | null;
  pollIntervalSeconds: string;
  hasRoleArn: boolean;
  hasCredentials: boolean;
  hasExternalId: boolean;
  createdAt: string;
}

interface IntegrationDetail extends Integration {
  externalId: string | null;
  externalIdEnforced: boolean;
  updatedAt: string;
}

/* -- AWS regions --------------------------------------------------- */

const AWS_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "ca-central-1", "ca-west-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2",
  "eu-north-1", "eu-south-1", "eu-south-2",
  "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4",
  "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "ap-south-1", "ap-south-2", "ap-east-1",
  "sa-east-1", "af-south-1", "me-south-1", "me-central-1",
  "il-central-1",
];

/* -- RegionPicker -------------------------------------------------- */

function RegionPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (regions: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = AWS_REGIONS.filter(
    (r) => r.includes(input.toLowerCase()) && !value.includes(r),
  );

  function add(region: string) {
    onChange([...value, region]);
    setInput("");
    setOpen(false);
  }

  function remove(region: string) {
    onChange(value.filter((r) => r !== region));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && filtered.length > 0) {
      e.preventDefault();
      add(filtered[0]);
    }
    if (e.key === "Backspace" && input === "" && value.length > 0) {
      remove(value[value.length - 1]);
    }
  }

  // Close dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div
        className="min-h-[38px] w-full rounded border border-border bg-background px-2 py-1.5 flex flex-wrap gap-1.5 cursor-text focus-within:ring-1 focus-within:ring-primary"
        onClick={() => { setOpen(true); containerRef.current?.querySelector("input")?.focus(); }}
      >
        {value.map((r) => (
          <span
            key={r}
            className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-xs font-mono text-primary"
          >
            {r}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); remove(r); }}
              className="text-primary/60 hover:text-primary leading-none"
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={input}
          onChange={(e) => { setInput(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? "all regions" : ""}
          className="flex-1 min-w-[80px] bg-transparent text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
        />
      </div>

      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded border border-border bg-background shadow-lg max-h-48 overflow-y-auto">
          {filtered.map((r) => (
            <button
              key={r}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); add(r); }}
              className="w-full px-3 py-1.5 text-left text-xs font-mono text-foreground hover:bg-muted/30 transition-colors"
            >
              {r}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* -- CopyButton ---------------------------------------------------- */

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors"
    >
      {copied ? "[copied]" : "[copy]"}
    </button>
  );
}

/* -- helpers ------------------------------------------------------- */

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

const statusBadge: Record<string, "default" | "destructive" | "secondary"> = {
  active: "default",
  error: "destructive",
  disabled: "secondary",
  setup: "secondary",
  needs_update: "destructive",
};

const INIT_FORM = {
  name: "",
  accountId: "",
  isOrgIntegration: false,
  awsOrgId: "",
};

const FINALIZE_FORM = {
  roleArn: "",
  accessKeyId: "",
  secretAccessKey: "",
  sqsQueueUrl: "",
  sqsRegion: "us-east-1",
  regions: [] as string[],
  pollIntervalSeconds: "60",
};

/* -- page ---------------------------------------------------------- */

export default function AwsIntegrationsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const showLoading = useDelayedLoading(loading);
  const [error, setError] = useState<string | null>(null);

  // Two-step creation flow
  const [step, setStep] = useState<"idle" | "init" | "finalize">("idle");
  const [initForm, setInitForm] = useState(INIT_FORM);
  const [finalizeForm, setFinalizeForm] = useState(FINALIZE_FORM);
  const [setupIntegration, setSetupIntegration] = useState<{ id: string; externalId: string; name: string } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState<Record<string, boolean>>({});
  const { toasts, toast, dismiss } = useToast();

  // Rotation state
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotationResult, setRotationResult] = useState<{ externalId: string; status: string } | null>(null);

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ regions: [] as string[], pollIntervalSeconds: "" });

  const fetchIntegrations = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiGet<{ data: Integration[] }>("/modules/aws/integrations");
      setIntegrations(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchIntegrations();
  }, [fetchIntegrations]);

  // Step 1: Initialize integration
  async function handleInit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        name: initForm.name,
        accountId: initForm.accountId,
        isOrgIntegration: initForm.isOrgIntegration,
      };
      if (initForm.isOrgIntegration && initForm.awsOrgId) payload.awsOrgId = initForm.awsOrgId;

      const res = await apiPost<{ data: { id: string; externalId: string; name: string } }>("/modules/aws/integrations/init", payload);
      setSetupIntegration({ id: res.data.id, externalId: res.data.externalId, name: res.data.name });
      setStep("finalize");
      await fetchIntegrations();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to initialize integration");
    } finally {
      setSubmitting(false);
    }
  }

  // Step 2: Finalize integration
  async function handleFinalize(e: React.FormEvent) {
    e.preventDefault();
    if (!setupIntegration) return;
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        sqsRegion: finalizeForm.sqsRegion,
        pollIntervalSeconds: parseInt(finalizeForm.pollIntervalSeconds, 10),
        regions: finalizeForm.regions,
      };
      if (finalizeForm.sqsQueueUrl) payload.sqsQueueUrl = finalizeForm.sqsQueueUrl;
      if (finalizeForm.roleArn) payload.roleArn = finalizeForm.roleArn;
      if (finalizeForm.accessKeyId && finalizeForm.secretAccessKey) {
        payload.accessKeyId = finalizeForm.accessKeyId;
        payload.secretAccessKey = finalizeForm.secretAccessKey;
      }

      await apiPatch(`/modules/aws/integrations/${setupIntegration.id}`, payload);
      toast("Integration activated", "success");
      setStep("idle");
      setInitForm(INIT_FORM);
      setFinalizeForm(FINALIZE_FORM);
      setSetupIntegration(null);
      await fetchIntegrations();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to finalize integration");
    } finally {
      setSubmitting(false);
    }
  }

  // Resume a setup integration
  async function handleResume(integration: Integration) {
    try {
      const res = await apiGet<{ data: IntegrationDetail }>(`/modules/aws/integrations/${integration.id}`);
      setSetupIntegration({
        id: res.data.id,
        externalId: res.data.externalId ?? "",
        name: res.data.name,
      });
      setStep("finalize");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load integration details");
    }
  }

  // Regenerate external ID
  async function handleRegenerateExternalId(id: string) {
    try {
      const res = await apiPost<{ data: { externalId: string; status: string }; warning?: string }>(
        `/modules/aws/integrations/${id}/regenerate-external-id`,
        { confirm: true },
      );
      if (setupIntegration?.id === id) {
        setSetupIntegration({ ...setupIntegration, externalId: res.data.externalId });
      }
      setRotationResult(res.data);
      toast(res.warning ?? "External ID regenerated", "success");
      await fetchIntegrations();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to regenerate external ID");
    }
  }

  // Acknowledge rotation
  async function handleAcknowledgeRotation(id: string) {
    try {
      await apiPost(`/modules/aws/integrations/${id}/acknowledge-rotation`, {});
      toast("Rotation acknowledged", "success");
      setRotatingId(null);
      setRotationResult(null);
      await fetchIntegrations();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to acknowledge rotation");
    }
  }

  // Rotate External ID (for active integrations)
  async function handleStartRotation(id: string) {
    if (!confirm("Rotate the external ID? This will break the integration until you update the AWS trust policy with the new value.")) return;
    setRotatingId(id);
    await handleRegenerateExternalId(id);
  }

  async function handleToggle(integration: Integration) {
    try {
      await apiPatch(`/modules/aws/integrations/${integration.id}`, {
        enabled: !integration.enabled,
      });
      setIntegrations((prev) =>
        prev.map((i) => i.id === integration.id ? { ...i, enabled: !i.enabled } : i)
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update integration");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this AWS integration? All raw events will be removed.")) return;
    try {
      await apiDelete(`/modules/aws/integrations/${id}`);
      setIntegrations((prev) => prev.filter((i) => i.id !== id));
      toast("Integration deleted", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete integration");
    }
  }

  function startEditing(integration: Integration) {
    setEditingId(integration.id);
    setEditForm({
      regions: [...integration.regions],
      pollIntervalSeconds: String(integration.pollIntervalSeconds),
    });
  }

  async function handleSaveEdit(id: string) {
    const poll = parseInt(editForm.pollIntervalSeconds, 10);
    if (isNaN(poll) || poll < 30 || poll > 3600) {
      toast("Poll interval must be between 30 and 3600 seconds");
      return;
    }
    try {
      await apiPatch(`/modules/aws/integrations/${id}`, {
        regions: editForm.regions,
        pollIntervalSeconds: poll,
      });
      setIntegrations((prev) =>
        prev.map((i) => i.id === id ? { ...i, regions: editForm.regions, pollIntervalSeconds: String(poll) } : i)
      );
      setEditingId(null);
      toast("Integration updated", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update integration");
    }
  }

  async function handlePoll(id: string) {
    setPolling((prev) => ({ ...prev, [id]: true }));
    try {
      await apiPost(`/modules/aws/integrations/${id}/poll`, {});
      toast("Poll job enqueued", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to enqueue poll");
    } finally {
      setPolling((prev) => ({ ...prev, [id]: false }));
    }
  }

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg text-primary text-glow">
            $ aws integrations ls
            <span className="ml-1 animate-pulse">_</span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {">"} manage AWS account integrations and SQS queue configurations
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              if (step !== "idle") {
                setStep("idle");
                setSetupIntegration(null);
                setInitForm(INIT_FORM);
                setFinalizeForm(FINALIZE_FORM);
              } else {
                setStep("init");
              }
            }}
            className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors"
          >
            {step !== "idle" ? "[cancel]" : "[+ add]"}
          </button>
          <Link href="/aws" className="text-xs text-muted-foreground hover:text-primary transition-colors">
            [back]
          </Link>
        </div>
      </div>

      {/* Step 1: Initialize */}
      {step === "init" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono text-primary">$ aws integrations init — step 1 of 2</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleInit} className="space-y-4 text-sm">
              {/* Org toggle */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setInitForm((f) => ({ ...f, isOrgIntegration: !f.isOrgIntegration }))}
                  className={`text-xs font-mono transition-colors ${initForm.isOrgIntegration ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {initForm.isOrgIntegration ? "[x] AWS Organizations" : "[ ] AWS Organizations"}
                </button>
                <span className="text-xs text-muted-foreground">
                  {initForm.isOrgIntegration
                    ? "— one integration covers all accounts in the org"
                    : "— single account"}
                </span>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground">Name *</label>
                  <input
                    required
                    value={initForm.name}
                    onChange={(e) => setInitForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder={initForm.isOrgIntegration ? "My Organisation" : "Production account"}
                    className="mt-1 w-full rounded border border-border bg-background px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">
                    {initForm.isOrgIntegration ? "Management Account ID * (12 digits)" : "AWS Account ID * (12 digits)"}
                  </label>
                  <input
                    required
                    pattern="\d{12}"
                    value={initForm.accountId}
                    onChange={(e) => setInitForm((f) => ({ ...f, accountId: e.target.value }))}
                    placeholder="123456789012"
                    className="mt-1 w-full rounded border border-border bg-background px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              {initForm.isOrgIntegration && (
                <div className="rounded border border-primary/20 bg-primary/5 p-3">
                  <div>
                    <label className="text-xs text-muted-foreground flex items-center gap-1.5">
                      AWS Organization ID (optional)
                      <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-muted-foreground/40 text-[9px] text-muted-foreground cursor-help" title="Events from all member accounts flow through the management account's SQS queue">i</span>
                    </label>
                    <input
                      value={initForm.awsOrgId}
                      onChange={(e) => setInitForm((f) => ({ ...f, awsOrgId: e.target.value }))}
                      placeholder="o-aa111bb222cc"
                      className="mt-1 w-full rounded border border-border bg-background px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setStep("idle")}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  [cancel]
                </button>
                <Button type="submit" size="sm" disabled={submitting}>
                  {submitting ? "..." : "[initialize]"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Step 2: Finalize (shows external ID + remaining config) */}
      {step === "finalize" && setupIntegration && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono text-primary">$ aws integrations finalize — step 2 of 2</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* External ID display */}
            <div className="rounded border border-primary/20 bg-primary/5 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">External ID (auto-generated)</label>
                <div className="flex items-center gap-2">
                  <CopyButton value={setupIntegration.externalId} />
                  <button
                    type="button"
                    onClick={() => handleRegenerateExternalId(setupIntegration.id)}
                    className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors"
                  >
                    [regenerate]
                  </button>
                </div>
              </div>
              <div className="rounded bg-background border border-border px-3 py-2 font-mono text-sm text-foreground break-all select-all">
                {setupIntegration.externalId}
              </div>
              <div className="text-xs text-muted-foreground space-y-1">
                <p>{">"} Copy this external ID into your AWS IAM trust policy or Terraform configuration:</p>
                <pre className="rounded bg-background border border-border px-3 py-2 overflow-x-auto text-xs">
{`variable "external_id" {
  default = "${setupIntegration.externalId}"
}`}
                </pre>
              </div>
            </div>

            {/* Finalize form */}
            <form onSubmit={handleFinalize} className="space-y-4 text-sm">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground">Role ARN <span className="text-primary">(recommended)</span></label>
                  <input
                    value={finalizeForm.roleArn}
                    onChange={(e) => setFinalizeForm((f) => ({ ...f, roleArn: e.target.value }))}
                    placeholder="arn:aws:iam::123456789012:role/SentinelRole"
                    className="mt-1 w-full rounded border border-border bg-background px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">External ID</label>
                  <input
                    readOnly
                    value={setupIntegration.externalId}
                    className="mt-1 w-full rounded border border-border bg-muted/20 px-3 py-1.5 text-sm font-mono text-muted-foreground cursor-not-allowed"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground">Access Key ID</label>
                  <input
                    value={finalizeForm.accessKeyId}
                    onChange={(e) => setFinalizeForm((f) => ({ ...f, accessKeyId: e.target.value }))}
                    placeholder="AKIAIOSFODNN7EXAMPLE"
                    className="mt-1 w-full rounded border border-border bg-background px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Secret Access Key</label>
                  <input
                    type="password"
                    value={finalizeForm.secretAccessKey}
                    onChange={(e) => setFinalizeForm((f) => ({ ...f, secretAccessKey: e.target.value }))}
                    placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
                    className="mt-1 w-full rounded border border-border bg-background px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground">SQS Queue URL (CloudTrail delivery)</label>
                  <input
                    value={finalizeForm.sqsQueueUrl}
                    onChange={(e) => setFinalizeForm((f) => ({ ...f, sqsQueueUrl: e.target.value }))}
                    placeholder="https://sqs.us-east-1.amazonaws.com/..."
                    className="mt-1 w-full rounded border border-border bg-background px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">SQS Region</label>
                  <input
                    value={finalizeForm.sqsRegion}
                    onChange={(e) => setFinalizeForm((f) => ({ ...f, sqsRegion: e.target.value }))}
                    placeholder="us-east-1"
                    className="mt-1 w-full rounded border border-border bg-background px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground">
                    Watch regions (empty = all)
                  </label>
                  <div className="mt-1">
                    <RegionPicker
                      value={finalizeForm.regions}
                      onChange={(regions) => setFinalizeForm((f) => ({ ...f, regions }))}
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Poll interval (seconds)</label>
                  <input
                    type="number"
                    min={30}
                    max={3600}
                    value={finalizeForm.pollIntervalSeconds}
                    onChange={(e) => setFinalizeForm((f) => ({ ...f, pollIntervalSeconds: e.target.value }))}
                    className="mt-1 w-full rounded border border-border bg-background px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => { setStep("idle"); setSetupIntegration(null); setFinalizeForm(FINALIZE_FORM); }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  [cancel]
                </button>
                <Button type="submit" size="sm" disabled={submitting}>
                  {submitting ? "..." : "[finalize]"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Rotation result panel */}
      {rotatingId && rotationResult && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono text-destructive">$ external-id rotated</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {">"} Update your AWS trust policy with the new external ID, then acknowledge the rotation.
            </p>
            <div className="flex items-center gap-2">
              <div className="flex-1 rounded bg-background border border-border px-3 py-2 font-mono text-sm text-foreground break-all select-all">
                {rotationResult.externalId}
              </div>
              <CopyButton value={rotationResult.externalId} />
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => handleAcknowledgeRotation(rotatingId)}
              >
                [acknowledge update]
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Integrations list */}
      {showLoading ? (
        <div className="space-y-3">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded border border-border bg-muted/20" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-destructive">[ERR] {error}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={fetchIntegrations}>$ retry</Button>
          </CardContent>
        </Card>
      ) : integrations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16">
            <p className="text-sm text-muted-foreground">{">"} no AWS integrations</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add an integration to start ingesting CloudTrail events.
            </p>
            <button
              onClick={() => setStep("init")}
              className="mt-4 text-xs text-primary hover:underline"
            >
              [+ add integration]
            </button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3 animate-content-ready">
          <p className="text-xs text-muted-foreground">
            {integrations.length} integration{integrations.length !== 1 ? "s" : ""}
          </p>
          {integrations.map((integration) => (
            <Card key={integration.id}>
              <CardContent className="pt-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-mono text-foreground">{integration.name}</span>
                      <span className="text-xs text-muted-foreground">[{integration.accountId}]</span>
                      {integration.isOrgIntegration && (
                        <Badge variant="secondary">
                          [org{integration.awsOrgId ? `: ${integration.awsOrgId}` : ""}]
                        </Badge>
                      )}
                      <Badge variant={statusBadge[integration.status] ?? "secondary"}>
                        [{integration.status}]
                      </Badge>
                      {!integration.enabled && integration.status !== "setup" && (
                        <Badge variant="secondary">[disabled]</Badge>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {integration.status === "setup" ? (
                        <span className="text-primary">awaiting configuration — click [resume] to continue setup</span>
                      ) : (
                        <>
                          {integration.sqsQueueUrl ? (
                            <span>queue: {integration.sqsQueueUrl.replace(/^https:\/\/sqs\.\S+\.amazonaws\.com\//, '…/')}</span>
                          ) : (
                            <span className="text-warning">no queue configured</span>
                          )}
                          <span>region: {integration.sqsRegion}</span>
                          {integration.regions.length > 0 && (
                            <span>watching: {integration.regions.join(", ")}</span>
                          )}
                          <span>
                            auth: {integration.hasRoleArn ? "role" : integration.hasCredentials ? "access-key" : "env"}
                          </span>
                          <span>poll: {integration.pollIntervalSeconds}s</span>
                          {integration.lastPolledAt && (
                            <span>last: {formatTimestamp(integration.lastPolledAt)}</span>
                          )}
                        </>
                      )}
                    </div>

                    {integration.status === "needs_update" && (
                      <p className="text-xs text-destructive">
                        [WARN] External ID was rotated — update your AWS trust policy, then acknowledge.
                      </p>
                    )}

                    {integration.connectedAccounts.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                        <span className="text-xs text-muted-foreground shrink-0">
                          {integration.isOrgIntegration ? "member accounts:" : "account:"}
                        </span>
                        {integration.connectedAccounts.map((acct) => (
                          <span
                            key={acct}
                            className="inline-flex items-center rounded bg-muted/30 px-1.5 py-0.5 text-xs font-mono text-muted-foreground"
                          >
                            {acct}
                          </span>
                        ))}
                      </div>
                    )}

                    {integration.errorMessage && (
                      <p className="text-xs text-destructive">[ERR] {integration.errorMessage}</p>
                    )}

                    {editingId === integration.id && (
                      <div className="mt-3 space-y-3 border-t border-border pt-3">
                        <div>
                          <label className="text-xs text-muted-foreground block mb-1">Watch regions (empty = all)</label>
                          <RegionPicker
                            value={editForm.regions}
                            onChange={(regions) => setEditForm((f) => ({ ...f, regions }))}
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground block mb-1">Poll interval (seconds)</label>
                          <input
                            type="number"
                            min={30}
                            max={3600}
                            value={editForm.pollIntervalSeconds}
                            onChange={(e) => setEditForm((f) => ({ ...f, pollIntervalSeconds: e.target.value }))}
                            className="h-8 w-32 rounded border border-border bg-background px-2 text-xs font-mono text-foreground"
                          />
                        </div>
                        <button
                          onClick={() => handleSaveEdit(integration.id)}
                          className="text-xs text-primary hover:text-primary/80 transition-colors"
                        >
                          [save]
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-3 text-xs shrink-0">
                    {integration.status === "setup" && (
                      <button
                        onClick={() => handleResume(integration)}
                        className="text-primary hover:text-primary/80 transition-colors"
                      >
                        [resume]
                      </button>
                    )}
                    {integration.status === "needs_update" && (
                      <button
                        onClick={() => {
                          setRotatingId(integration.id);
                          // Fetch the current external ID for display
                          apiGet<{ data: IntegrationDetail }>(`/modules/aws/integrations/${integration.id}`)
                            .then((res) => {
                              if (res.data.externalId) {
                                setRotationResult({ externalId: res.data.externalId, status: res.data.status });
                              }
                            });
                        }}
                        className="text-destructive hover:text-destructive/80 transition-colors"
                      >
                        [acknowledge]
                      </button>
                    )}
                    {integration.status !== "setup" && (
                      <>
                        <button
                          onClick={() => editingId === integration.id ? setEditingId(null) : startEditing(integration)}
                          className="text-muted-foreground hover:text-primary transition-colors"
                        >
                          {editingId === integration.id ? "[cancel]" : "[edit]"}
                        </button>
                        <button
                          onClick={() => handlePoll(integration.id)}
                          disabled={polling[integration.id]}
                          className="text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                        >
                          {polling[integration.id] ? "..." : "[poll]"}
                        </button>
                        <button
                          onClick={() => handleStartRotation(integration.id)}
                          className="text-muted-foreground hover:text-destructive transition-colors"
                        >
                          [rotate ID]
                        </button>
                        <button
                          onClick={() => handleToggle(integration)}
                          className="text-muted-foreground hover:text-primary transition-colors"
                        >
                          {integration.enabled ? "[disable]" : "[enable]"}
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => handleDelete(integration.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      [delete]
                    </button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
