"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { apiGet } from "@/lib/api";
import { CorrelationRuleForm, type CorrelationRuleFormData } from "@/components/correlation-rule-form";

/* ── types ───────────────────────────────────────────────────── */

interface EventFilter {
  moduleId?: string;
  eventType?: string | string[];
  conditions: Array<{ field: string; operator: string; value: unknown }>;
}

interface RuleConfig {
  type: "sequence" | "aggregation" | "absence";
  correlationKey: Array<{ field: string; alias?: string }>;
  windowMinutes: number;
  steps?: Array<{
    name: string;
    eventFilter: EventFilter;
    withinMinutes?: number;
    matchConditions: Array<{ field: string; operator: string; ref: string }>;
  }>;
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
  cooldownMinutes: number;
}

/* ── helpers ─────────────────────────────────────────────────── */

function parseRef(ref: string): { refStep: string; refField: string } {
  // ref format: "steps.StepName.field.path"
  const parts = ref.replace(/^steps\./, "").split(".");
  const refStep = parts[0] ?? "";
  const refField = parts.slice(1).join(".");
  return { refStep, refField };
}

function toFormData(rule: CorrelationRule): CorrelationRuleFormData {
  const config = rule.config;

  const steps = config.type === "sequence" && config.steps
    ? config.steps.map((s) => ({
        name: s.name,
        moduleId: s.eventFilter.moduleId ?? "",
        eventType: Array.isArray(s.eventFilter.eventType)
          ? s.eventFilter.eventType[0] ?? ""
          : s.eventFilter.eventType ?? "",
        withinMinutes: s.withinMinutes ? String(s.withinMinutes) : "",
        conditions: s.eventFilter.conditions.map((c) => ({
          field: c.field,
          operator: c.operator,
          value: String(c.value ?? ""),
        })),
        matchConditions: s.matchConditions.map((mc) => {
          const { refStep, refField } = parseRef(mc.ref);
          return { field: mc.field, operator: mc.operator, refStep, refField };
        }),
      }))
    : [
        { name: "Step 1", moduleId: "", eventType: "", withinMinutes: "", conditions: [], matchConditions: [] },
        { name: "Step 2", moduleId: "", eventType: "", withinMinutes: "", conditions: [], matchConditions: [] },
      ];

  return {
    name: rule.name,
    description: rule.description ?? "",
    severity: rule.severity,
    ruleType: config.type,
    windowMinutes: String(config.windowMinutes),
    cooldownMinutes: String(rule.cooldownMinutes),
    correlationKeys: config.correlationKey.map((k) => ({ field: k.field, alias: k.alias ?? "" })),
    steps,
    aggThreshold: config.aggregation ? String(config.aggregation.threshold) : "5",
    aggModuleId: config.aggregation?.eventFilter.moduleId ?? "",
    aggEventType: (() => {
      const et = config.aggregation?.eventFilter.eventType;
      return Array.isArray(et) ? et[0] ?? "" : et ?? "";
    })(),
    aggCountField: config.aggregation?.countField ?? "",
    aggGroupByField: config.aggregation?.groupByField ?? "",
    aggConditions: (config.aggregation?.eventFilter.conditions ?? []).map((c) => ({
      field: c.field, operator: c.operator, value: String(c.value ?? ""),
    })),
    absenceTriggerModuleId: config.absence?.trigger.eventFilter.moduleId ?? "",
    absenceTriggerEventType: (() => {
      const et = config.absence?.trigger.eventFilter.eventType;
      return Array.isArray(et) ? et[0] ?? "" : et ?? "";
    })(),
    absenceTriggerConditions: (config.absence?.trigger.eventFilter.conditions ?? []).map((c) => ({
      field: c.field, operator: c.operator, value: String(c.value ?? ""),
    })),
    absenceExpectedModuleId: config.absence?.expected.eventFilter.moduleId ?? "",
    absenceExpectedEventType: (() => {
      const et = config.absence?.expected.eventFilter.eventType;
      return Array.isArray(et) ? et[0] ?? "" : et ?? "";
    })(),
    absenceExpectedConditions: (config.absence?.expected.eventFilter.conditions ?? []).map((c) => ({
      field: c.field, operator: c.operator, value: String(c.value ?? ""),
    })),
    absenceMatchConditions: (config.absence?.expected.matchConditions ?? []).map((mc) => ({
      field: mc.field, operator: mc.operator, triggerField: mc.triggerField,
    })),
    absenceGraceMinutes: config.absence ? String(config.absence.graceMinutes) : "15",
  };
}

/* ── page ────────────────────────────────────────────────────── */

export default function EditCorrelationRulePage() {
  const params = useParams();
  const id = params.id as string;

  const [formData, setFormData] = useState<CorrelationRuleFormData | undefined>(undefined);
  const [ruleName, setRuleName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRule = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiGet<{ data: CorrelationRule }>(`/api/correlation-rules/${id}`);
      setFormData(toFormData(res.data));
      setRuleName(res.data.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rule");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadRule();
  }, [loadRule]);

  if (error) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href="/correlations" className="hover:text-primary transition-colors">correlations</Link>
          <span>/</span>
          <span className="text-destructive">error</span>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-destructive">[ERR] {error}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={loadRule}>$ retry</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/correlations" className="hover:text-primary transition-colors">correlations</Link>
        <span>/</span>
        <Link href={`/correlations/${id}`} className="hover:text-primary transition-colors truncate max-w-[200px]">
          {ruleName || "..."}
        </Link>
        <span>/</span>
        <span className="text-foreground">edit</span>
      </div>

      {/* Header */}
      <div>
        <h1 className="text-lg text-primary text-glow">
          $ correlation edit
          <span className="ml-1 animate-pulse">_</span>
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {">"} modify correlation rule configuration
        </p>
      </div>

      <CorrelationRuleForm
        mode="edit"
        ruleId={id}
        initialData={formData}
        loading={loading}
      />
    </div>
  );
}
