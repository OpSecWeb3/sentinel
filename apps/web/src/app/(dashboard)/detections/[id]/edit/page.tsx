"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiGet, apiFetch } from "@/lib/api";

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const ACTIONS = ["alert", "log", "suppress"] as const;

interface RuleForm {
  ruleType: string;
  config: string;
  action: (typeof ACTIONS)[number];
  priority: number;
}

function emptyRule(): RuleForm {
  return { ruleType: "", config: "{}", action: "alert", priority: 50 };
}

export default function EditDetectionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>("high");
  const [cooldownMinutes, setCooldownMinutes] = useState(5);
  const [rulesList, setRulesList] = useState<RuleForm[]>([emptyRule()]);
  const [configErrors, setConfigErrors] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDetection = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{
        data: {
          name: string;
          description: string | null;
          severity: string;
          cooldownMinutes: number;
          status: string;
          rules: Array<{
            ruleType: string;
            config: Record<string, unknown>;
            action: string;
            priority: number;
          }>;
        };
      }>(`/api/detections/${id}`);
      const d = res.data;
      if (d.status === "disabled") {
        setError("Archived detections cannot be edited.");
        return;
      }
      setName(d.name);
      setDescription(d.description ?? "");
      setSeverity(d.severity as (typeof SEVERITIES)[number]);
      setCooldownMinutes(d.cooldownMinutes);
      setRulesList(
        d.rules.length > 0
          ? d.rules.map((r) => ({
              ruleType: r.ruleType,
              config: JSON.stringify(r.config, null, 2),
              action: (r.action as (typeof ACTIONS)[number]) ?? "alert",
              priority: r.priority ?? 50,
            }))
          : [emptyRule()],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load detection");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDetection();
  }, [fetchDetection]);

  function updateRule(i: number, patch: Partial<RuleForm>) {
    setRulesList((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    );
  }

  function addRule() {
    setRulesList((prev) => [...prev, emptyRule()]);
  }

  function removeRule(i: number) {
    setRulesList((prev) => prev.filter((_, idx) => idx !== i));
    setConfigErrors((prev) => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
  }

  function validateConfigs(): boolean {
    const errs: Record<number, string> = {};
    rulesList.forEach((r, i) => {
      try {
        JSON.parse(r.config);
      } catch {
        errs[i] = "Invalid JSON";
      }
    });
    setConfigErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!validateConfigs()) return;
    setSaving(true);
    try {
      await apiFetch(`/api/detections/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          description: description || null,
          severity,
          cooldownMinutes,
          rules: rulesList.map((r) => ({
            ruleType: r.ruleType,
            config: JSON.parse(r.config),
            action: r.action,
            priority: r.priority,
          })),
        }),
      });
      router.push(`/detections/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 font-mono animate-pulse">
        <div className="h-5 w-48 rounded bg-muted" />
        <div className="h-8 rounded bg-muted" />
        <div className="h-8 rounded bg-muted" />
        <div className="h-24 rounded bg-muted" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 font-mono">
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

      {error && <p className="text-xs text-destructive">[ERR] {error}</p>}

      {!error && (
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Name */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">--name</label>
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
              --description{" "}
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
              <label className="text-xs text-muted-foreground">--severity</label>
              <div className="flex gap-3 flex-wrap text-xs">
                {SEVERITIES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSeverity(s)}
                    className={
                      severity === s
                        ? "text-foreground"
                        : "text-muted-foreground/60 hover:text-foreground transition-colors"
                    }
                  >
                    {severity === s ? `[${s}]` : s}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                --cooldown-minutes
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

          {/* Rules */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs text-muted-foreground">--rules</label>
              <button
                type="button"
                onClick={addRule}
                className="text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                [+ add rule]
              </button>
            </div>

            {rulesList.map((rule, i) => (
              <div key={i} className="space-y-2 border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    rule[{i}]
                  </span>
                  {rulesList.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeRule(i)}
                      className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                    >
                      [remove]
                    </button>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    rule_type
                  </label>
                  <Input
                    value={rule.ruleType}
                    onChange={(e) =>
                      updateRule(i, { ruleType: e.target.value })
                    }
                    placeholder="e.g. infra.dns_change"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    config (JSON)
                  </label>
                  <textarea
                    value={rule.config}
                    onChange={(e) => updateRule(i, { config: e.target.value })}
                    rows={3}
                    className="w-full rounded border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono resize-none"
                    placeholder="{}"
                  />
                  {configErrors[i] && (
                    <p className="text-xs text-destructive">
                      [ERR] {configErrors[i]}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-4">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">
                      action
                    </label>
                    <div className="flex gap-2 text-xs">
                      {ACTIONS.map((a) => (
                        <button
                          key={a}
                          type="button"
                          onClick={() => updateRule(i, { action: a })}
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

                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">
                      priority
                    </label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={rule.priority}
                      onChange={(e) =>
                        updateRule(i, { priority: Number(e.target.value) })
                      }
                      className="w-20"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? "> saving..." : "$ save changes"}
          </Button>
        </form>
      )}
    </div>
  );
}
