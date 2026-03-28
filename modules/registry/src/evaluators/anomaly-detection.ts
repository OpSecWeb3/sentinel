import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';
import { logger } from '@sentinel/shared/logger';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Glob patterns for tags/versions to monitor. */
  tagPatterns: z.array(z.string()).default(['*']),
  /** Change types this rule applies to. */
  changeTypes: z
    .array(
      z.enum([
        'digest_change',
        'new_tag',
        'tag_removed',
        'new_version',
        'version_unpublished',
        'dist_tag_updated',
        'version_published',
      ]),
    )
    .default(['digest_change', 'new_tag', 'tag_removed']),

  // ── Pusher allowlist ──────────────────────────────────────────────────
  /**
   * Docker Hub / registry usernames allowed to push. If non-empty, any
   * push from a username NOT in this list triggers an alert.
   */
  pusherAllowlist: z.array(z.string()).default([]),

  // ── Source mismatch ───────────────────────────────────────────────────
  /**
   * Expected detection source. For example, set to 'webhook' to alert
   * when changes are detected via polling (indicating webhook misconfiguration).
   * null = disabled.
   */
  expectedSource: z.string().nullable().default(null),

  // ── Rate limiting ─────────────────────────────────────────────────────
  /**
   * Maximum number of changes allowed within the time window. null = disabled.
   */
  maxChanges: z.number().int().positive().nullable().default(null),
  /** Rate-limit window size in minutes. */
  windowMinutes: z.number().int().positive().default(60),
  /**
   * Redis key prefix used for the sliding-window counter. Defaults to the
   * artifact name extracted from the event payload. Override only if you
   * need cross-artifact rate limiting.
   */
  rateLimitKeyPrefix: z.string().nullable().default(null),

  // ── Time window ───────────────────────────────────────────────────────
  /**
   * Allowed deployment window start in HH:MM format (e.g. "09:00").
   * null = disabled.
   */
  allowedHoursStart: z.string().nullable().default(null),
  /** Allowed deployment window end in HH:MM format (e.g. "18:00"). */
  allowedHoursEnd: z.string().nullable().default(null),
  /** IANA timezone for the time window (e.g. "America/New_York"). */
  timezone: z.string().default('UTC'),
  /** Allowed ISO day-of-week numbers (1=Mon .. 7=Sun). */
  allowedDays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
});

// ---------------------------------------------------------------------------
// Event types this evaluator handles
// ---------------------------------------------------------------------------

const HANDLED_EVENT_TYPES = new Set([
  'registry.docker.digest_change',
  'registry.docker.new_tag',
  'registry.docker.tag_removed',
  'registry.npm.version_published',
  'registry.npm.version_unpublished',
  'registry.npm.new_tag',
  'registry.npm.tag_removed',
  'registry.npm.dist_tag_updated',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strips the module prefix and registry sub-namespace from event types.
 * e.g. 'registry.docker.digest_change' -> 'digest_change'
 *      'registry.npm.version_published' -> 'version_published'
 */
function stripModulePrefix(eventType: string): string {
  return eventType.replace(/^registry\.(?:docker|npm|verification|attribution)\./, '');
}

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

interface AnomalyPayload {
  artifact: string;
  tag: string;
  eventType: string;
  source: string;
  pusher: string | null;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const anomalyDetectionEvaluator: RuleEvaluator = {
  moduleId: 'registry',
  ruleType: 'registry.anomaly_detection',
  configSchema,
  uiSchema: [
    { key: 'tagPatterns', label: 'Tag patterns to watch', type: 'string-array', required: false, placeholder: '*' },
    { key: 'pusherAllowlist', label: 'Allowed pushers', type: 'string-array', required: false, placeholder: 'deploy-bot\nci-user', help: 'If set, alert when a pusher not in this list makes a change.' },
    { key: 'maxChanges', label: 'Max changes per window', type: 'number', required: false, min: 1, help: 'Alert if more than this many changes occur in the time window.' },
    { key: 'windowMinutes', label: 'Rate limit window (minutes)', type: 'number', required: false, default: 60, min: 1 },
    { key: 'allowedHoursStart', label: 'Allowed hours start (HH:MM)', type: 'text', required: false, placeholder: '09:00', help: 'Only allow changes after this time. Uses timezone below.' },
    { key: 'allowedHoursEnd', label: 'Allowed hours end (HH:MM)', type: 'text', required: false, placeholder: '18:00' },
    { key: 'timezone', label: 'Timezone', type: 'text', required: false, placeholder: 'UTC', help: 'IANA timezone name, e.g. America/New_York.' },
    { key: 'allowedDays', label: 'Allowed days (1=Mon…7=Sun)', type: 'string-array', required: false, placeholder: '1\n2\n3\n4\n5', help: 'Days of the week when changes are permitted.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule, redis } = ctx;
    if (!HANDLED_EVENT_TYPES.has(event.eventType)) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as unknown as AnomalyPayload;
    const changeType = stripModulePrefix(event.eventType);

    // Must be a change type we care about
    if (!config.changeTypes.includes(changeType as (typeof config.changeTypes)[number])) {
      return null;
    }

    // Must match at least one tag pattern
    if (!config.tagPatterns.some((p) => minimatch(payload.tag, p))) {
      return null;
    }

    // ── Pusher allowlist ─────────────────────────────────────────────────
    if (config.pusherAllowlist.length > 0) {
      const pusher = payload.pusher;
      if (!pusher || !config.pusherAllowlist.includes(pusher)) {
        return {
          orgId: event.orgId,
          detectionId: rule.detectionId,
          ruleId: rule.id,
          eventId: event.id,
          severity: 'high',
          title: `Unauthorized pusher on ${payload.artifact}:${payload.tag}`,
          description: `Pusher "${pusher ?? 'unknown'}" is not in the allowlist [${config.pusherAllowlist.join(', ')}]`,
          triggerType: 'immediate',
          triggerData: event.payload,
        };
      }
    }

    // ── Source mismatch ──────────────────────────────────────────────────
    if (config.expectedSource) {
      if (payload.source !== config.expectedSource) {
        return {
          orgId: event.orgId,
          detectionId: rule.detectionId,
          ruleId: rule.id,
          eventId: event.id,
          severity: 'medium',
          title: `Source mismatch on ${payload.artifact}:${payload.tag}`,
          description: `Change detected via "${payload.source}" but expected "${config.expectedSource}". This may indicate webhook misconfiguration.`,
          triggerType: 'immediate',
          triggerData: event.payload,
        };
      }
    }

    // ── Time window check ────────────────────────────────────────────────
    if (config.allowedHoursStart && config.allowedHoursEnd) {
      let outsideWindow: boolean;
      try {
        outsideWindow = isOutsideTimeWindow(
          event.occurredAt,
          config.allowedHoursStart,
          config.allowedHoursEnd,
          config.timezone,
          config.allowedDays,
        );
      } catch (err) {
        // A misconfigured timezone must not silently disable the off-hours
        // check. Log a warning and surface an alert so the operator notices.
        logger.warn(
          { err, timezone: config.timezone, ruleId: rule.id },
          'anomaly-detection: invalid timezone in rule config — off-hours check cannot run',
        );
        return {
          orgId: event.orgId,
          detectionId: rule.detectionId,
          ruleId: rule.id,
          eventId: event.id,
          severity: 'medium',
          title: `Misconfigured timezone in off-hours rule for ${payload.artifact}`,
          description: `Rule "${rule.id}" specifies an invalid timezone "${config.timezone}". The off-hours check could not be evaluated. Please correct the rule configuration.`,
          triggerType: 'immediate',
          triggerData: event.payload,
        };
      }
      if (outsideWindow) {
        return {
          orgId: event.orgId,
          detectionId: rule.detectionId,
          ruleId: rule.id,
          eventId: event.id,
          severity: 'high',
          title: `Off-hours change to ${payload.artifact}:${payload.tag}`,
          description: `Change occurred outside allowed window (${config.allowedHoursStart}-${config.allowedHoursEnd} ${config.timezone}, days ${config.allowedDays.join(',')})`,
          triggerType: 'immediate',
          triggerData: event.payload,
        };
      }
    }

    // ── Rate limiting (sliding window via Redis) ─────────────────────────
    if (config.maxChanges != null) {
      const keyPrefix = config.rateLimitKeyPrefix ?? payload.artifact;
      const alert = await checkRateLimit(
        redis,
        keyPrefix,
        rule.id,
        config.maxChanges,
        config.windowMinutes,
        event,
        rule,
        payload,
      );
      if (alert) return alert;
    }

    return null;
  },
};

// ---------------------------------------------------------------------------
// Time window helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the event timestamp falls outside the allowed window.
 * Throws if the timezone string is invalid so that the caller can distinguish
 * a misconfigured timezone (which should alert) from "inside window" (which
 * should not). Never silently returns false on error.
 */
function isOutsideTimeWindow(
  timestamp: Date,
  startTime: string,
  endTime: string,
  timezone: string,
  allowedDays: number[],
): boolean {
  // Validate the timezone before use so that a bad string throws with a clear
  // message rather than producing a cryptic Intl error later.
  // Validate timezone by attempting to use it — supportedValuesOf() omits
  // aliases like UTC and Etc/* that DateTimeFormat accepts just fine.
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new RangeError(`Invalid IANA timezone: "${timezone}"`);
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(timestamp);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';

  const dayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  const isoDay = dayMap[weekday] ?? 0;

  // Day check
  if (!allowedDays.includes(isoDay)) return true;

  // Time check
  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);
  const eventMinutes = hour * 60 + minute;
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Fix #13: Handle midnight-crossing windows (e.g. 22:00 - 06:00)
  if (startMinutes > endMinutes) {
    // Window crosses midnight: event is INSIDE if >= start OR <= end
    const insideWindow = eventMinutes >= startMinutes || eventMinutes <= endMinutes;
    return !insideWindow;
  }

  return eventMinutes < startMinutes || eventMinutes > endMinutes;
}

// ---------------------------------------------------------------------------
// Rate-limit helper (sliding window using Redis sorted set)
// ---------------------------------------------------------------------------

async function checkRateLimit(
  redis: import('ioredis').Redis,
  keyPrefix: string,
  ruleId: string,
  maxChanges: number,
  windowMinutes: number,
  event: import('@sentinel/shared/rules').NormalizedEvent,
  rule: import('@sentinel/shared/rules').RuleRow,
  payload: AnomalyPayload,
): Promise<AlertCandidate | null> {
  const key = `sentinel:registry:rate:${keyPrefix}:${ruleId}`;
  const now = event.occurredAt.getTime();
  const windowMs = windowMinutes * 60 * 1000;
  const windowStart = now - windowMs;

  // Add current event and trim old entries in one pipeline
  const pipeline = redis.pipeline();
  pipeline.zadd(key, now.toString(), event.id);
  pipeline.zremrangebyscore(key, '-inf', windowStart.toString());
  pipeline.zcard(key);
  pipeline.expire(key, windowMinutes * 60 + 60); // TTL = window + 1min buffer
  const results = await pipeline.exec();

  // zcard result is the third command (index 2)
  const zcardResult = results?.[2];
  const count = (zcardResult?.[1] as number) ?? 0;

  if (count > maxChanges) {
    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `Rapid changes detected on ${payload.artifact}`,
      description: `${count} changes in the last ${windowMinutes} minutes exceeds the limit of ${maxChanges}`,
      triggerType: 'windowed',
      triggerData: {
        ...event.payload,
        rateLimit: { count, maxChanges, windowMinutes },
      },
    };
  }

  return null;
}
