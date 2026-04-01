/**
 * Hook for serializing/deserializing detection form state to/from the
 * `POST /api/detections` JSON body shape (`createBodySchema`).
 */

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

interface TemplateRule {
  ruleType: string;
  config?: Record<string, unknown>;
  action?: string;
  priority?: number;
}

interface DetectionPayload {
  moduleId: string;
  name: string;
  severity: string;
  cooldownMinutes: number;
  slackChannelId?: string;
  slackChannelName?: string;
  rules: Array<{
    ruleType: string;
    config: Record<string, unknown>;
    action: string;
    priority: number;
  }>;
}

const VALID_SEVERITIES = ["critical", "high", "medium", "low"];
const VALID_ACTIONS = ["alert", "log", "suppress"];

/* ── applyTemplateInputs (client-side mirror of server logic) ──── */

function applyTemplateInputs(
  config: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  function interpolate(val: unknown): unknown {
    if (typeof val === "string") {
      const full = val.match(/^\{\{(\w+)\}\}$/);
      if (full) return inputs[full[1]] ?? val;
      return val.replace(/\{\{(\w+)\}\}/g, (_, k: string) =>
        inputs[k] !== undefined ? String(inputs[k]) : `{{${k}}}`,
      );
    }
    if (Array.isArray(val)) return val.map(interpolate);
    if (val && typeof val === "object") {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).map(([k, v]) => [
          k,
          interpolate(v),
        ]),
      );
    }
    return val;
  }
  return { ...(interpolate(config) as Record<string, unknown>), ...inputs };
}

/* ── parseInputValue (mirrors server + form helpers) ────────────── */

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

function toRawString(val: unknown, type: TemplateInputType): string {
  if (val === undefined || val === null) return "";
  if (type === "string-array" && Array.isArray(val))
    return (val as string[]).join("\n");
  if (type === "boolean") return String(val);
  if (type === "number") return String(val);
  return String(val);
}

/* ── serializeToJson ────────────────────────────────────────────── */

export function serializeToJson(opts: {
  moduleId: string;
  templateRules: TemplateRule[];
  templateInputs: TemplateInput[];
  name: string;
  severity: string;
  cooldownMinutes: number;
  inputValues: Record<string, string>;
  slackChannelId?: string;
  slackChannelName?: string;
}): string {
  const {
    moduleId,
    templateRules,
    templateInputs,
    name,
    severity,
    cooldownMinutes,
    inputValues,
    slackChannelId,
    slackChannelName,
  } = opts;

  // Build typed inputs from raw string values
  const parsedInputs: Record<string, unknown> = {};
  for (const inp of templateInputs) {
    const raw = inputValues[inp.key];
    if (raw !== undefined && raw.trim() !== "") {
      parsedInputs[inp.key] = parseInputValue(raw, inp.type);
    }
  }

  // Apply template inputs to each rule's config (mirrors server-side interpolation)
  const rules = templateRules.map((r) => ({
    ruleType: r.ruleType,
    config: applyTemplateInputs({ ...(r.config ?? {}) }, parsedInputs),
    action: r.action ?? "alert",
    priority: r.priority ?? 50,
  }));

  const payload: DetectionPayload = {
    moduleId,
    name,
    severity,
    cooldownMinutes,
    rules,
  };

  if (slackChannelId) {
    payload.slackChannelId = slackChannelId;
    if (slackChannelName) payload.slackChannelName = slackChannelName;
  }

  return JSON.stringify(payload, null, 2);
}

/* ── deserializeFromJson ────────────────────────────────────────── */

interface DeserializeResult {
  name: string;
  severity: string;
  cooldownMinutes: number;
  slackChannelId: string;
  slackChannelName: string;
  inputValues: Record<string, string>;
}

export function deserializeFromJson(
  jsonStr: string,
  templateInputs: TemplateInput[],
): DeserializeResult | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { error: "Invalid JSON" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Expected a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  const name = typeof obj.name === "string" ? obj.name : "";
  const severity =
    typeof obj.severity === "string" && VALID_SEVERITIES.includes(obj.severity)
      ? obj.severity
      : "high";
  const cooldownMinutes =
    typeof obj.cooldownMinutes === "number" ? obj.cooldownMinutes : 0;
  const slackChannelId =
    typeof obj.slackChannelId === "string" ? obj.slackChannelId : "";
  const slackChannelName =
    typeof obj.slackChannelName === "string" ? obj.slackChannelName : "";

  // Extract input values from rules[*].config
  const rules = Array.isArray(obj.rules) ? obj.rules : [];
  const inputValues: Record<string, string> = {};

  for (const inp of templateInputs) {
    let found = false;
    for (const rule of rules) {
      if (rule && typeof rule === "object" && !Array.isArray(rule)) {
        const config = (rule as Record<string, unknown>).config;
        if (config && typeof config === "object" && !Array.isArray(config)) {
          const val = (config as Record<string, unknown>)[inp.key];
          if (val !== undefined) {
            inputValues[inp.key] = toRawString(val, inp.type);
            found = true;
            break;
          }
        }
      }
    }
    if (!found) {
      inputValues[inp.key] = "";
    }
  }

  return { name, severity, cooldownMinutes, slackChannelId, slackChannelName, inputValues };
}

/* ── validateJson ───────────────────────────────────────────────── */

export function validateJson(jsonStr: string): {
  valid: boolean;
  errors: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return {
      valid: false,
      errors: [e instanceof SyntaxError ? e.message : "Invalid JSON"],
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, errors: ["Expected a JSON object"] };
  }

  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof obj.moduleId !== "string" || !obj.moduleId) {
    errors.push("moduleId is required");
  }
  if (typeof obj.name !== "string" || !obj.name) {
    errors.push("name is required");
  } else if (obj.name.length > 255) {
    errors.push("name must be 255 characters or fewer");
  }
  if (
    obj.severity !== undefined &&
    (typeof obj.severity !== "string" ||
      !VALID_SEVERITIES.includes(obj.severity))
  ) {
    errors.push(`severity must be one of: ${VALID_SEVERITIES.join(", ")}`);
  }
  if (obj.cooldownMinutes !== undefined) {
    if (
      typeof obj.cooldownMinutes !== "number" ||
      obj.cooldownMinutes < 0 ||
      obj.cooldownMinutes > 1440
    ) {
      errors.push("cooldownMinutes must be between 0 and 1440");
    }
  }

  if (!Array.isArray(obj.rules) || obj.rules.length === 0) {
    errors.push("rules must be a non-empty array");
  } else {
    for (let i = 0; i < obj.rules.length; i++) {
      const rule = obj.rules[i];
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
        errors.push(`rules[${i}]: must be an object`);
        continue;
      }
      const r = rule as Record<string, unknown>;
      if (typeof r.ruleType !== "string" || !r.ruleType) {
        errors.push(`rules[${i}]: ruleType is required`);
      }
      if (!r.config || typeof r.config !== "object" || Array.isArray(r.config)) {
        errors.push(`rules[${i}]: config must be an object`);
      }
      if (r.action !== undefined && !VALID_ACTIONS.includes(r.action as string)) {
        errors.push(
          `rules[${i}]: action must be one of: ${VALID_ACTIONS.join(", ")}`,
        );
      }
      if (
        r.priority !== undefined &&
        (typeof r.priority !== "number" || r.priority < 0 || r.priority > 100)
      ) {
        errors.push(`rules[${i}]: priority must be between 0 and 100`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/* ── serializeDetectionToJson (for edit page — from existing detection) ── */

export function serializeDetectionToJson(opts: {
  moduleId: string;
  name: string;
  severity: string;
  cooldownMinutes: number;
  rules: Array<{
    ruleType: string;
    config: Record<string, unknown>;
    action: string;
    priority: number;
  }>;
  slackChannelId?: string;
  slackChannelName?: string;
}): string {
  const payload: DetectionPayload = {
    moduleId: opts.moduleId,
    name: opts.name,
    severity: opts.severity,
    cooldownMinutes: opts.cooldownMinutes,
    rules: opts.rules,
  };

  if (opts.slackChannelId) {
    payload.slackChannelId = opts.slackChannelId;
    if (opts.slackChannelName) payload.slackChannelName = opts.slackChannelName;
  }

  return JSON.stringify(payload, null, 2);
}
