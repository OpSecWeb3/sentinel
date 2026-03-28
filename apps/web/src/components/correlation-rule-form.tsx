"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Card, CardContent } from "@/components/ui/card";
import { ToastContainer } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { apiGet, apiFetch } from "@/lib/api";

/* ── types ───────────────────────────────────────────────────── */

type RuleType = "sequence" | "aggregation" | "absence";

interface EventTypeDef {
  type: string;
  label: string;
  description: string;
}

interface ModuleMeta {
  id: string;
  name: string;
  eventTypes: EventTypeDef[];
}

interface FieldInfo {
  path: string;
  type: string;
  sample: unknown;
}

interface StepForm {
  name: string;
  moduleId: string;
  eventType: string;
  withinMinutes: string;
  conditions: Array<{ field: string; operator: string; value: string }>;
  matchConditions: Array<{ field: string; operator: string; refStep: string; refField: string }>;
}

export interface CorrelationRuleFormData {
  name: string;
  description: string;
  severity: string;
  ruleType: RuleType;
  windowMinutes: string;
  cooldownMinutes: string;
  correlationKeys: Array<{ field: string; alias: string }>;
  steps: StepForm[];
  aggThreshold: string;
  aggModuleId: string;
  aggEventType: string;
  aggCountField: string;
  aggGroupByField: string;
  aggConditions: Array<{ field: string; operator: string; value: string }>;
  absenceTriggerModuleId: string;
  absenceTriggerEventType: string;
  absenceTriggerConditions: Array<{ field: string; operator: string; value: string }>;
  absenceExpectedModuleId: string;
  absenceExpectedEventType: string;
  absenceExpectedConditions: Array<{ field: string; operator: string; value: string }>;
  absenceMatchConditions: Array<{ field: string; operator: string; triggerField: string }>;
  absenceGraceMinutes: string;
}

interface CorrelationRuleFormProps {
  mode: "create" | "edit";
  ruleId?: string;
  initialData?: CorrelationRuleFormData;
  loading?: boolean;
}

const OPERATORS = [
  { value: "==", label: "==" },
  { value: "!=", label: "!=" },
  { value: ">", label: ">" },
  { value: "<", label: "<" },
  { value: ">=", label: ">=" },
  { value: "<=", label: "<=" },
];

const CROSS_OPERATORS = [
  { value: "==", label: "==" },
  { value: "!=", label: "!=" },
];

/* ── helpers ─────────────────────────────────────────────────── */

function buildEventFilter(moduleId: string, eventType: string, conditions: Array<{ field: string; operator: string; value: string }>) {
  const ef: { moduleId?: string; eventType?: string; conditions: Array<{ field: string; operator: string; value: string }> } = { conditions: [] };
  if (moduleId) ef.moduleId = moduleId;
  if (eventType) ef.eventType = eventType;
  ef.conditions = conditions.filter((c) => c.field && c.value);
  return ef;
}

/* ── component ───────────────────────────────────────────────── */

export function CorrelationRuleForm({ mode, ruleId, initialData, loading: externalLoading }: CorrelationRuleFormProps) {
  const router = useRouter();
  const { toast, toasts, dismiss } = useToast();
  const [saving, setSaving] = useState(false);

  // Module metadata
  const [modules, setModules] = useState<ModuleMeta[]>([]);
  const [modulesLoading, setModulesLoading] = useState(true);

  // Field caches: keyed by "moduleId:eventType"
  const [fieldCache, setFieldCache] = useState<Record<string, FieldInfo[]>>({});
  const [fieldHasData, setFieldHasData] = useState<Record<string, boolean>>({});
  const [fieldLoading, setFieldLoading] = useState<Record<string, boolean>>({});

  // Form state
  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [severity, setSeverity] = useState(initialData?.severity ?? "high");
  const [ruleType, setRuleType] = useState<RuleType>(initialData?.ruleType ?? "sequence");
  const [windowMinutes, setWindowMinutes] = useState(initialData?.windowMinutes ?? "30");
  const [cooldownMinutes, setCooldownMinutes] = useState(initialData?.cooldownMinutes ?? "0");
  const [correlationKeys, setCorrelationKeys] = useState<Array<{ field: string; alias: string }>>(
    initialData?.correlationKeys ?? [{ field: "", alias: "" }],
  );

  // Sequence
  const [steps, setSteps] = useState<StepForm[]>(
    initialData?.steps ?? [
      { name: "Step 1", moduleId: "", eventType: "", withinMinutes: "", conditions: [], matchConditions: [] },
      { name: "Step 2", moduleId: "", eventType: "", withinMinutes: "", conditions: [], matchConditions: [] },
    ],
  );

  // Aggregation
  const [aggThreshold, setAggThreshold] = useState(initialData?.aggThreshold ?? "5");
  const [aggModuleId, setAggModuleId] = useState(initialData?.aggModuleId ?? "");
  const [aggEventType, setAggEventType] = useState(initialData?.aggEventType ?? "");
  const [aggCountField, setAggCountField] = useState(initialData?.aggCountField ?? "");
  const [aggGroupByField, setAggGroupByField] = useState(initialData?.aggGroupByField ?? "");
  const [aggConditions, setAggConditions] = useState<Array<{ field: string; operator: string; value: string }>>(
    initialData?.aggConditions ?? [],
  );

  // Absence
  const [absenceTriggerModuleId, setAbsenceTriggerModuleId] = useState(initialData?.absenceTriggerModuleId ?? "");
  const [absenceTriggerEventType, setAbsenceTriggerEventType] = useState(initialData?.absenceTriggerEventType ?? "");
  const [absenceTriggerConditions, setAbsenceTriggerConditions] = useState<Array<{ field: string; operator: string; value: string }>>(
    initialData?.absenceTriggerConditions ?? [],
  );
  const [absenceExpectedConditions, setAbsenceExpectedConditions] = useState<Array<{ field: string; operator: string; value: string }>>(
    initialData?.absenceExpectedConditions ?? [],
  );
  const [absenceExpectedModuleId, setAbsenceExpectedModuleId] = useState(initialData?.absenceExpectedModuleId ?? "");
  const [absenceExpectedEventType, setAbsenceExpectedEventType] = useState(initialData?.absenceExpectedEventType ?? "");
  const [absenceMatchConditions, setAbsenceMatchConditions] = useState<Array<{ field: string; operator: string; triggerField: string }>>(
    initialData?.absenceMatchConditions ?? [],
  );
  const [absenceGraceMinutes, setAbsenceGraceMinutes] = useState(initialData?.absenceGraceMinutes ?? "15");

  // Sync when initialData changes (edit mode load)
  useEffect(() => {
    if (!initialData) return;
    setName(initialData.name);
    setDescription(initialData.description);
    setSeverity(initialData.severity);
    setRuleType(initialData.ruleType);
    setWindowMinutes(initialData.windowMinutes);
    setCooldownMinutes(initialData.cooldownMinutes);
    setCorrelationKeys(initialData.correlationKeys);
    setSteps(initialData.steps);
    setAggThreshold(initialData.aggThreshold);
    setAggModuleId(initialData.aggModuleId);
    setAggEventType(initialData.aggEventType);
    setAggCountField(initialData.aggCountField);
    setAggGroupByField(initialData.aggGroupByField);
    setAggConditions(initialData.aggConditions);
    setAbsenceTriggerModuleId(initialData.absenceTriggerModuleId);
    setAbsenceTriggerEventType(initialData.absenceTriggerEventType);
    setAbsenceTriggerConditions(initialData.absenceTriggerConditions);
    setAbsenceExpectedModuleId(initialData.absenceExpectedModuleId);
    setAbsenceExpectedEventType(initialData.absenceExpectedEventType);
    setAbsenceExpectedConditions(initialData.absenceExpectedConditions);
    setAbsenceMatchConditions(initialData.absenceMatchConditions);
    setAbsenceGraceMinutes(initialData.absenceGraceMinutes);
  }, [initialData]);

  /* ── fetch modules metadata ────────────────────────────────── */

  useEffect(() => {
    async function load() {
      try {
        const res = await apiGet<{ data: ModuleMeta[] }>("/api/modules/metadata");
        setModules(res.data);
      } catch {
        toast("Failed to load module metadata.");
      } finally {
        setModulesLoading(false);
      }
    }
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── fetch field paths for a module+eventType ──────────────── */

  const fetchFields = useCallback(async (moduleId: string, eventType: string) => {
    if (!moduleId || !eventType) return;
    const cacheKey = `${moduleId}:${eventType}`;
    if (fieldCache[cacheKey] || fieldLoading[cacheKey]) return;

    setFieldLoading((prev) => ({ ...prev, [cacheKey]: true }));
    try {
      const res = await apiGet<{ data: { fields: FieldInfo[]; hasData: boolean } }>(
        `/api/modules/metadata/sample-fields?moduleId=${encodeURIComponent(moduleId)}&eventType=${encodeURIComponent(eventType)}`,
      );
      setFieldCache((prev) => ({ ...prev, [cacheKey]: res.data.fields }));
      setFieldHasData((prev) => ({ ...prev, [cacheKey]: res.data.hasData }));
    } catch {
      // silently fail — user can still type manually
    } finally {
      setFieldLoading((prev) => ({ ...prev, [cacheKey]: false }));
    }
  }, [fieldCache, fieldLoading]);

  function getFieldsFor(moduleId: string, eventType: string): FieldInfo[] {
    return fieldCache[`${moduleId}:${eventType}`] ?? [];
  }

  function getFieldOptions(moduleId: string, eventType: string) {
    const fields = getFieldsFor(moduleId, eventType);
    return fields.map((f) => ({
      value: f.path,
      label: `${f.path} (${f.type})`,
    }));
  }

  function hasNoSampleData(moduleId: string, eventType: string): boolean {
    const key = `${moduleId}:${eventType}`;
    return key in fieldHasData && !fieldHasData[key];
  }

  /* ── module / event type helpers ───────────────────────────── */

  const moduleOptions = modules.map((m) => ({ value: m.id, label: m.name }));

  function eventTypesForModule(moduleId: string) {
    const mod = modules.find((m) => m.id === moduleId);
    if (!mod) return [];
    return mod.eventTypes.map((et) => ({
      value: et.type,
      label: et.label,
      description: et.description,
    }));
  }

  /* ── step helpers ──────────────────────────────────────────── */

  function updateStep(index: number, updates: Partial<StepForm>) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...updates } : s)));
  }

  function handleStepModuleChange(stepIndex: number, moduleId: string) {
    updateStep(stepIndex, { moduleId, eventType: "", conditions: [] });
  }

  function handleStepEventTypeChange(stepIndex: number, eventType: string) {
    const step = steps[stepIndex];
    updateStep(stepIndex, { eventType, conditions: [] });
    if (step.moduleId && eventType) {
      fetchFields(step.moduleId, eventType);
    }
  }

  function addStep() {
    setSteps((prev) => [
      ...prev,
      { name: `Step ${prev.length + 1}`, moduleId: "", eventType: "", withinMinutes: "", conditions: [], matchConditions: [] },
    ]);
  }

  function removeStep(index: number) {
    if (steps.length <= 2) return;
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }

  function addCondition(stepIndex: number) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === stepIndex
          ? { ...s, conditions: [...s.conditions, { field: "", operator: "==", value: "" }] }
          : s,
      ),
    );
  }

  function removeCondition(stepIndex: number, condIndex: number) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === stepIndex ? { ...s, conditions: s.conditions.filter((_, j) => j !== condIndex) } : s,
      ),
    );
  }

  function updateCondition(stepIndex: number, condIndex: number, updates: Partial<{ field: string; operator: string; value: string }>) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === stepIndex
          ? { ...s, conditions: s.conditions.map((c, j) => (j === condIndex ? { ...c, ...updates } : c)) }
          : s,
      ),
    );
  }

  function addMatchCondition(stepIndex: number) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === stepIndex
          ? { ...s, matchConditions: [...s.matchConditions, { field: "", operator: "==", refStep: "", refField: "" }] }
          : s,
      ),
    );
  }

  function removeMatchCondition(stepIndex: number, condIndex: number) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === stepIndex ? { ...s, matchConditions: s.matchConditions.filter((_, j) => j !== condIndex) } : s,
      ),
    );
  }

  function updateMatchCondition(stepIndex: number, condIndex: number, updates: Partial<{ field: string; operator: string; refStep: string; refField: string }>) {
    setSteps((prev) =>
      prev.map((s, i) =>
        i === stepIndex
          ? { ...s, matchConditions: s.matchConditions.map((c, j) => (j === condIndex ? { ...c, ...updates } : c)) }
          : s,
      ),
    );
  }

  // Previous steps for cross-step reference
  function previousStepOptions(currentIndex: number) {
    return steps.slice(0, currentIndex).map((s, i) => ({
      value: s.name || `Step ${i + 1}`,
      label: s.name || `Step ${i + 1}`,
    }));
  }

  function fieldsForStepName(stepName: string) {
    const step = steps.find((s) => s.name === stepName);
    if (!step || !step.moduleId || !step.eventType) return [];
    return getFieldOptions(step.moduleId, step.eventType);
  }

  // When a refStep is selected, ensure its fields are loaded
  function handleRefStepChange(stepIndex: number, condIndex: number, refStepName: string) {
    const refStep = steps.find((s) => s.name === refStepName);
    if (refStep?.moduleId && refStep?.eventType) {
      fetchFields(refStep.moduleId, refStep.eventType);
    }
    updateMatchCondition(stepIndex, condIndex, { refStep: refStepName, refField: "" });
  }

  /* ── correlation key helpers ───────────────────────────────── */

  function addCorrelationKey() {
    setCorrelationKeys((prev) => [...prev, { field: "", alias: "" }]);
  }

  function removeCorrelationKey(index: number) {
    if (correlationKeys.length <= 1) return;
    setCorrelationKeys((prev) => prev.filter((_, i) => i !== index));
  }

  function updateCorrelationKey(index: number, updates: Partial<{ field: string; alias: string }>) {
    setCorrelationKeys((prev) => prev.map((k, i) => (i === index ? { ...k, ...updates } : k)));
  }

  // Gather all available field options across all configured steps for correlation key dropdown
  function allConfiguredFieldOptions() {
    const seen = new Set<string>();
    const options: Array<{ value: string; label: string }> = [];
    for (const step of steps) {
      if (!step.moduleId || !step.eventType) continue;
      const fields = getFieldsFor(step.moduleId, step.eventType);
      for (const f of fields) {
        if (!seen.has(f.path)) {
          seen.add(f.path);
          options.push({ value: f.path, label: `${f.path} (${f.type})` });
        }
      }
    }
    // For aggregation/absence, include those fields too
    if (ruleType === "aggregation" && aggModuleId && aggEventType) {
      const fields = getFieldsFor(aggModuleId, aggEventType);
      for (const f of fields) {
        if (!seen.has(f.path)) {
          seen.add(f.path);
          options.push({ value: f.path, label: `${f.path} (${f.type})` });
        }
      }
    }
    if (ruleType === "absence") {
      for (const pair of [
        [absenceTriggerModuleId, absenceTriggerEventType],
        [absenceExpectedModuleId, absenceExpectedEventType],
      ]) {
        if (pair[0] && pair[1]) {
          const fields = getFieldsFor(pair[0], pair[1]);
          for (const f of fields) {
            if (!seen.has(f.path)) {
              seen.add(f.path);
              options.push({ value: f.path, label: `${f.path} (${f.type})` });
            }
          }
        }
      }
    }
    return options;
  }

  /* ── build config ──────────────────────────────────────────── */

  function buildConfig() {
    const base = {
      type: ruleType,
      correlationKey: correlationKeys
        .filter((k) => k.field)
        .map((k) => ({ field: k.field, ...(k.alias ? { alias: k.alias } : {}) })),
      windowMinutes: Number(windowMinutes) || 30,
    };

    if (ruleType === "sequence") {
      return {
        ...base,
        steps: steps.map((s) => ({
          name: s.name || "Unnamed",
          eventFilter: buildEventFilter(s.moduleId, s.eventType, s.conditions),
          ...(s.withinMinutes ? { withinMinutes: Number(s.withinMinutes) } : {}),
          matchConditions: s.matchConditions
            .filter((mc) => mc.field && mc.refField)
            .map((mc) => ({
              field: mc.field,
              operator: mc.operator,
              ref: `steps.${mc.refStep}.${mc.refField}`,
            })),
        })),
      };
    }

    if (ruleType === "aggregation") {
      return {
        ...base,
        aggregation: {
          eventFilter: buildEventFilter(aggModuleId, aggEventType, aggConditions),
          threshold: Number(aggThreshold) || 5,
          ...(aggCountField ? { countField: aggCountField } : {}),
          ...(aggGroupByField ? { groupByField: aggGroupByField } : {}),
        },
      };
    }

    return {
      ...base,
      absence: {
        trigger: { eventFilter: buildEventFilter(absenceTriggerModuleId, absenceTriggerEventType, absenceTriggerConditions) },
        expected: {
          eventFilter: buildEventFilter(absenceExpectedModuleId, absenceExpectedEventType, absenceExpectedConditions),
          matchConditions: absenceMatchConditions
            .filter((mc) => mc.field && mc.triggerField)
            .map((mc) => ({ field: mc.field, operator: mc.operator, triggerField: mc.triggerField })),
        },
        graceMinutes: Number(absenceGraceMinutes) || 15,
      },
    };
  }

  /* ── submit ────────────────────────────────────────────────── */

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!name.trim()) {
      toast("Name is required.");
      return;
    }
    if (correlationKeys.filter((k) => k.field).length === 0) {
      toast("At least one correlation key is required.");
      return;
    }
    if (ruleType === "sequence" && steps.length < 2) {
      toast("Sequence rules require at least 2 steps.");
      return;
    }

    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || (mode === "edit" ? null : undefined),
        severity,
        config: buildConfig(),
        cooldownMinutes: Number(cooldownMinutes) || 0,
      };

      if (mode === "create") {
        const res = await apiFetch<{ data: { id: string } }>("/api/correlation-rules", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        router.push(`/correlations/${res.data.id}`);
      } else {
        await apiFetch(`/api/correlation-rules/${ruleId}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        router.push(`/correlations/${ruleId}`);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : `Failed to ${mode} rule.`);
    } finally {
      setSaving(false);
    }
  }

  /* ── render helpers ────────────────────────────────────────── */

  // A select that also allows manual input as fallback
  function FieldSelect({
    value,
    onChange,
    options,
    placeholder,
    loading: isLoading,
    noDataHint,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: string }>;
    placeholder: string;
    loading?: boolean;
    noDataHint?: boolean;
  }) {
    if (isLoading) {
      return (
        <div className="flex h-10 w-full items-center border-b border-border px-1 py-2 text-sm text-muted-foreground">
          loading fields...
        </div>
      );
    }
    if (options.length > 0) {
      // Add the current value as an option if it's set but not in the list (from edit mode)
      const allOptions = value && !options.find((o) => o.value === value)
        ? [{ value, label: value }, ...options]
        : options;
      return (
        <Select
          value={value}
          onValueChange={onChange}
          options={allOptions}
          placeholder={placeholder}
        />
      );
    }
    // Fallback to manual text input
    return (
      <div>
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        {noDataHint && (
          <p className="mt-1 text-xs text-muted-foreground/50">
            no sample events yet — type a field path manually (e.g. sender.login)
          </p>
        )}
      </div>
    );
  }

  // Event filter section used by aggregation and absence configs
  function EventFilterSelect({
    moduleId,
    eventType,
    onModuleChange,
    onEventTypeChange,
    conditions,
    onConditionsChange,
  }: {
    moduleId: string;
    eventType: string;
    onModuleChange: (v: string) => void;
    onEventTypeChange: (v: string) => void;
    conditions?: Array<{ field: string; operator: string; value: string }>;
    onConditionsChange?: (conditions: Array<{ field: string; operator: string; value: string }>) => void;
  }) {
    const fieldOpts = getFieldOptions(moduleId, eventType);
    const isFieldsLoading = fieldLoading[`${moduleId}:${eventType}`] ?? false;
    const noData = hasNoSampleData(moduleId, eventType);

    function addCond() {
      onConditionsChange?.([...(conditions ?? []), { field: "", operator: "==", value: "" }]);
    }
    function removeCond(idx: number) {
      onConditionsChange?.((conditions ?? []).filter((_, i) => i !== idx));
    }
    function updateCond(idx: number, updates: Partial<{ field: string; operator: string; value: string }>) {
      onConditionsChange?.((conditions ?? []).map((c, i) => (i === idx ? { ...c, ...updates } : c)));
    }

    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Module</label>
            {modulesLoading ? (
              <div className="flex h-10 items-center text-xs text-muted-foreground">loading modules...</div>
            ) : (
              <Select
                value={moduleId}
                onValueChange={(v) => {
                  onModuleChange(v);
                  onEventTypeChange("");
                  onConditionsChange?.([]);
                }}
                options={moduleOptions}
                placeholder="Select module..."
              />
            )}
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Event Type</label>
            {moduleId ? (
              <Combobox
                value={eventType}
                onValueChange={(v) => {
                  onEventTypeChange(v);
                  if (moduleId && v) fetchFields(moduleId, v);
                  onConditionsChange?.([]);
                }}
                options={eventTypesForModule(moduleId)}
                placeholder="Select event type..."
                searchPlaceholder="search by name, type, or description..."
              />
            ) : (
              <div className="flex h-10 items-center text-xs text-muted-foreground">
                select a module first
              </div>
            )}
          </div>
        </div>

        {/* Conditions */}
        {onConditionsChange && moduleId && eventType && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-muted-foreground">Conditions</label>
              <button
                type="button"
                onClick={addCond}
                className="text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                [+ condition]
              </button>
            </div>
            {(!conditions || conditions.length === 0) && (
              <p className="text-xs text-muted-foreground/60">
                no conditions — matches all events of this type
              </p>
            )}
            {conditions?.map((cond, j) => (
              <div key={j} className="flex items-center gap-2 mb-2">
                <div className="flex-1">
                  <FieldSelect
                    value={cond.field}
                    onChange={(v) => updateCond(j, { field: v })}
                    options={fieldOpts}
                    placeholder="field"
                    loading={isFieldsLoading}
                    noDataHint={noData}
                  />
                </div>
                <Select
                  value={cond.operator}
                  onValueChange={(v) => updateCond(j, { operator: v })}
                  options={OPERATORS}
                  className="w-20"
                />
                <div className="flex-1">
                  <Input
                    value={cond.value}
                    onChange={(e) => updateCond(j, { value: e.target.value })}
                    placeholder="value"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeCond(j)}
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0"
                >
                  [x]
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (externalLoading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-5 w-64 rounded bg-muted" />
        <div className="h-40 rounded bg-muted" />
      </div>
    );
  }

  /* ── render ────────────────────────────────────────────────── */

  const cancelHref = mode === "edit" ? `/correlations/${ruleId}` : "/correlations";

  return (
    <div className="space-y-6">
      <ToastContainer toasts={toasts} dismiss={dismiss} />

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <Card>
          <CardContent className="p-4 space-y-4">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Basic Information
            </h2>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Name *</label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Branch Protection Bypass Sequence"
                />
              </div>

              <div>
                <label className="text-xs text-muted-foreground block mb-1">Description</label>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe what this rule detects..."
                />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Severity</label>
                  <Select
                    value={severity}
                    onValueChange={setSeverity}
                    options={[
                      { value: "critical", label: "critical" },
                      { value: "high", label: "high" },
                      { value: "medium", label: "medium" },
                      { value: "low", label: "low" },
                    ]}
                  />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Rule Type</label>
                  <Select
                    value={ruleType}
                    onValueChange={(v) => setRuleType(v as RuleType)}
                    options={[
                      { value: "sequence", label: "sequence" },
                      { value: "aggregation", label: "aggregation" },
                      { value: "absence", label: "absence" },
                    ]}
                  />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Window (min)</label>
                  <Input
                    type="number"
                    min="1"
                    value={windowMinutes}
                    onChange={(e) => setWindowMinutes(e.target.value)}
                  />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Cooldown (min)</label>
                  <Input
                    type="number"
                    min="0"
                    value={cooldownMinutes}
                    onChange={(e) => setCooldownMinutes(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Correlation Key */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Correlation Key
              </h2>
              <button
                type="button"
                onClick={addCorrelationKey}
                className="text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                [+ add field]
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Events must share these field values to be correlated together.
            </p>

            {correlationKeys.map((k, i) => {
              const corrKeyFieldOptions = allConfiguredFieldOptions();
              return (
                <div key={i} className="flex items-center gap-2">
                  <div className="flex-1">
                    <FieldSelect
                      value={k.field}
                      onChange={(v) => updateCorrelationKey(i, { field: v })}
                      options={corrKeyFieldOptions}
                      placeholder="e.g., repository.full_name"
                    />
                  </div>
                  <Input
                    value={k.alias}
                    onChange={(e) => updateCorrelationKey(i, { alias: e.target.value })}
                    placeholder="alias (optional)"
                    className="w-40"
                  />
                  {correlationKeys.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeCorrelationKey(i)}
                      className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0"
                    >
                      [x]
                    </button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* ── Sequence Steps ──────────────────────────────────── */}
        {ruleType === "sequence" && (
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Sequence Steps ({steps.length})
                </h2>
                <button
                  type="button"
                  onClick={addStep}
                  className="text-xs text-muted-foreground hover:text-primary transition-colors"
                >
                  [+ add step]
                </button>
              </div>

              {steps.map((step, i) => {
                const stepFieldOptions = getFieldOptions(step.moduleId, step.eventType);
                const isFieldsLoading = fieldLoading[`${step.moduleId}:${step.eventType}`] ?? false;

                return (
                  <div key={i} className="border border-border p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-primary font-mono">[Step {i + 1}]</span>
                      {steps.length > 2 && (
                        <button
                          type="button"
                          onClick={() => removeStep(i)}
                          className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                        >
                          [remove]
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Step Name *</label>
                        <Input
                          value={step.name}
                          onChange={(e) => updateStep(i, { name: e.target.value })}
                          placeholder="e.g., ProtectionDisabled"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Within (min of prev)</label>
                        <Input
                          type="number"
                          min="1"
                          value={step.withinMinutes}
                          onChange={(e) => updateStep(i, { withinMinutes: e.target.value })}
                          placeholder="optional"
                        />
                      </div>
                    </div>

                    {/* Module + Event Type selects */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Module</label>
                        {modulesLoading ? (
                          <div className="flex h-10 items-center text-xs text-muted-foreground">loading...</div>
                        ) : (
                          <Select
                            value={step.moduleId}
                            onValueChange={(v) => handleStepModuleChange(i, v)}
                            options={moduleOptions}
                            placeholder="Select module..."
                          />
                        )}
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Event Type</label>
                        {step.moduleId ? (
                          <Combobox
                            value={step.eventType}
                            onValueChange={(v) => handleStepEventTypeChange(i, v)}
                            options={eventTypesForModule(step.moduleId)}
                            placeholder="Select event type..."
                            searchPlaceholder="search by name, type, or description..."
                          />
                        ) : (
                          <div className="flex h-10 items-center text-xs text-muted-foreground">
                            select a module first
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Event Conditions */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs text-muted-foreground">Event Conditions</label>
                        <button
                          type="button"
                          onClick={() => addCondition(i)}
                          className="text-xs text-muted-foreground hover:text-primary transition-colors"
                        >
                          [+ condition]
                        </button>
                      </div>
                      {step.conditions.length === 0 && step.moduleId && step.eventType && (
                        <p className="text-xs text-muted-foreground/60 mb-1">
                          no conditions — matches all events of this type
                        </p>
                      )}
                      {step.conditions.map((cond, j) => (
                        <div key={j} className="flex items-center gap-2 mb-2">
                          <div className="flex-1">
                            <FieldSelect
                              value={cond.field}
                              onChange={(v) => updateCondition(i, j, { field: v })}
                              options={stepFieldOptions}
                              placeholder="field"
                              loading={isFieldsLoading}
                              noDataHint={hasNoSampleData(step.moduleId, step.eventType)}
                            />
                          </div>
                          <Select
                            value={cond.operator}
                            onValueChange={(v) => updateCondition(i, j, { operator: v })}
                            options={OPERATORS}
                            className="w-20"
                          />
                          <div className="flex-1">
                            <Input
                              value={cond.value}
                              onChange={(e) => updateCondition(i, j, { value: e.target.value })}
                              placeholder="value"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => removeCondition(i, j)}
                            className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0"
                          >
                            [x]
                          </button>
                        </div>
                      ))}
                    </div>

                    {/* Cross-step Match Conditions */}
                    {i > 0 && (
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-xs text-muted-foreground">Cross-Step Match</label>
                          <button
                            type="button"
                            onClick={() => addMatchCondition(i)}
                            className="text-xs text-muted-foreground hover:text-primary transition-colors"
                          >
                            [+ match]
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground/60 mb-2">
                          Link fields between this event and a previous step event
                        </p>
                        {step.matchConditions.map((mc, j) => {
                          const refStepFields = mc.refStep ? fieldsForStepName(mc.refStep) : [];
                          return (
                            <div key={j} className="flex items-center gap-2 mb-2">
                              {/* Current step field */}
                              <div className="flex-1">
                                <FieldSelect
                                  value={mc.field}
                                  onChange={(v) => updateMatchCondition(i, j, { field: v })}
                                  options={stepFieldOptions}
                                  placeholder="this event's field"
                                  loading={isFieldsLoading}
                                  noDataHint={hasNoSampleData(step.moduleId, step.eventType)}
                                />
                              </div>

                              <Select
                                value={mc.operator}
                                onValueChange={(v) => updateMatchCondition(i, j, { operator: v })}
                                options={CROSS_OPERATORS}
                                className="w-16"
                              />

                              {/* Reference step */}
                              <div className="w-32">
                                <Select
                                  value={mc.refStep}
                                  onValueChange={(v) => handleRefStepChange(i, j, v)}
                                  options={previousStepOptions(i)}
                                  placeholder="step..."
                                />
                              </div>

                              {/* Reference field */}
                              <div className="flex-1">
                                <FieldSelect
                                  value={mc.refField}
                                  onChange={(v) => updateMatchCondition(i, j, { refField: v })}
                                  options={refStepFields}
                                  placeholder="that step's field"
                                />
                              </div>

                              <button
                                type="button"
                                onClick={() => removeMatchCondition(i, j)}
                                className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0"
                              >
                                [x]
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        {/* ── Aggregation Config ──────────────────────────────── */}
        {ruleType === "aggregation" && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Aggregation Config
              </h2>

              <EventFilterSelect
                moduleId={aggModuleId}
                eventType={aggEventType}
                onModuleChange={(v) => { setAggModuleId(v); setAggEventType(""); setAggConditions([]); }}
                onEventTypeChange={(v) => {
                  setAggEventType(v);
                  if (aggModuleId && v) fetchFields(aggModuleId, v);
                }}
                conditions={aggConditions}
                onConditionsChange={setAggConditions}
              />

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Threshold *</label>
                  <Input
                    type="number"
                    min="1"
                    value={aggThreshold}
                    onChange={(e) => setAggThreshold(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Count Distinct Field</label>
                  <FieldSelect
                    value={aggCountField}
                    onChange={setAggCountField}
                    options={getFieldOptions(aggModuleId, aggEventType)}
                    placeholder="optional — count unique values"
                    loading={fieldLoading[`${aggModuleId}:${aggEventType}`]}
                  />
                  <p className="mt-1 text-xs text-muted-foreground/50">
                    count unique values instead of raw events (e.g. distinct actors)
                  </p>
                </div>
              </div>

              <div>
                <label className="text-xs text-muted-foreground block mb-1">Group By Field</label>
                <FieldSelect
                  value={aggGroupByField}
                  onChange={setAggGroupByField}
                  options={getFieldOptions(aggModuleId, aggEventType)}
                  placeholder="optional — separate counter per value"
                  loading={fieldLoading[`${aggModuleId}:${aggEventType}`]}
                />
                <p className="mt-1 text-xs text-muted-foreground/50">
                  track threshold independently per unique value (e.g. per repository)
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Absence Config ──────────────────────────────────── */}
        {ruleType === "absence" && (
          <Card>
            <CardContent className="p-4 space-y-4">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Absence Config
              </h2>

              <div className="border border-border p-3 space-y-3">
                <h3 className="text-xs text-primary font-mono">[Trigger Event]</h3>
                <p className="text-xs text-muted-foreground/60">The event that starts the timer</p>
                <EventFilterSelect
                  moduleId={absenceTriggerModuleId}
                  eventType={absenceTriggerEventType}
                  onModuleChange={(v) => { setAbsenceTriggerModuleId(v); setAbsenceTriggerEventType(""); setAbsenceTriggerConditions([]); }}
                  onEventTypeChange={(v) => {
                    setAbsenceTriggerEventType(v);
                    if (absenceTriggerModuleId && v) fetchFields(absenceTriggerModuleId, v);
                  }}
                  conditions={absenceTriggerConditions}
                  onConditionsChange={setAbsenceTriggerConditions}
                />
              </div>

              <div className="border border-border p-3 space-y-3">
                <h3 className="text-xs text-primary font-mono">[Expected Event]</h3>
                <p className="text-xs text-muted-foreground/60">The event we expect to see within the grace period</p>
                <EventFilterSelect
                  moduleId={absenceExpectedModuleId}
                  eventType={absenceExpectedEventType}
                  onModuleChange={(v) => { setAbsenceExpectedModuleId(v); setAbsenceExpectedEventType(""); setAbsenceExpectedConditions([]); }}
                  onEventTypeChange={(v) => {
                    setAbsenceExpectedEventType(v);
                    if (absenceExpectedModuleId && v) fetchFields(absenceExpectedModuleId, v);
                  }}
                  conditions={absenceExpectedConditions}
                  onConditionsChange={setAbsenceExpectedConditions}
                />
              </div>

              {/* Cross-event match conditions */}
              {absenceTriggerModuleId && absenceTriggerEventType && absenceExpectedModuleId && absenceExpectedEventType && (
                <div className="border border-border p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs text-primary font-mono">[Field Matching]</h3>
                    <button
                      type="button"
                      onClick={() => setAbsenceMatchConditions((prev) => [...prev, { field: "", operator: "==", triggerField: "" }])}
                      className="text-xs text-muted-foreground hover:text-primary transition-colors"
                    >
                      [+ match]
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground/60">
                    Link expected event fields to trigger event fields (e.g. same actor, same repo)
                  </p>
                  {absenceMatchConditions.length === 0 && (
                    <p className="text-xs text-muted-foreground/40">
                      no match conditions — any expected event with the same correlation key will cancel the timer
                    </p>
                  )}
                  {absenceMatchConditions.map((mc, j) => {
                    const expectedFieldOpts = getFieldOptions(absenceExpectedModuleId, absenceExpectedEventType);
                    const triggerFieldOpts = getFieldOptions(absenceTriggerModuleId, absenceTriggerEventType);
                    const expectedFieldsLoading = fieldLoading[`${absenceExpectedModuleId}:${absenceExpectedEventType}`] ?? false;
                    const triggerFieldsLoading = fieldLoading[`${absenceTriggerModuleId}:${absenceTriggerEventType}`] ?? false;

                    return (
                      <div key={j} className="flex items-center gap-2">
                        <div className="flex-1">
                          <FieldSelect
                            value={mc.field}
                            onChange={(v) =>
                              setAbsenceMatchConditions((prev) =>
                                prev.map((c, i) => (i === j ? { ...c, field: v } : c)),
                              )
                            }
                            options={expectedFieldOpts}
                            placeholder="expected event field"
                            loading={expectedFieldsLoading}
                            noDataHint={hasNoSampleData(absenceExpectedModuleId, absenceExpectedEventType)}
                          />
                        </div>
                        <Select
                          value={mc.operator}
                          onValueChange={(v) =>
                            setAbsenceMatchConditions((prev) =>
                              prev.map((c, i) => (i === j ? { ...c, operator: v } : c)),
                            )
                          }
                          options={CROSS_OPERATORS}
                          className="w-16"
                        />
                        <div className="flex-1">
                          <FieldSelect
                            value={mc.triggerField}
                            onChange={(v) =>
                              setAbsenceMatchConditions((prev) =>
                                prev.map((c, i) => (i === j ? { ...c, triggerField: v } : c)),
                              )
                            }
                            options={triggerFieldOpts}
                            placeholder="trigger event field"
                            loading={triggerFieldsLoading}
                            noDataHint={hasNoSampleData(absenceTriggerModuleId, absenceTriggerEventType)}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setAbsenceMatchConditions((prev) => prev.filter((_, i) => i !== j))}
                          className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0"
                        >
                          [x]
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div>
                <label className="text-xs text-muted-foreground block mb-1">Grace Period (min)</label>
                <Input
                  type="number"
                  min="1"
                  value={absenceGraceMinutes}
                  onChange={(e) => setAbsenceGraceMinutes(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Submit */}
        <div className="flex items-center justify-end gap-3">
          <Button variant="outline" type="button" asChild>
            <Link href={cancelHref}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={saving}>
            {saving
              ? mode === "create" ? "Creating..." : "Saving..."
              : mode === "create" ? "Create Rule" : "Save Changes"}
          </Button>
        </div>
      </form>
    </div>
  );
}
