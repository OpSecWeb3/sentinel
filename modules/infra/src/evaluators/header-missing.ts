import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const ALL_HEADERS = [
  'HSTS',
  'CSP',
  'X-Frame-Options',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
] as const;

const configSchema = z.object({
  /** Which security headers are required; empty = all known headers */
  requiredHeaders: z.array(z.string()).default([]),
});

export const headerMissingEvaluator: RuleEvaluator = {
  moduleId: 'infra',
  ruleType: 'infra.header_missing',
  configSchema,
  uiSchema: [
    { key: 'requiredHeaders', label: 'Required security headers', type: 'string-array', required: false, placeholder: 'Strict-Transport-Security\nContent-Security-Policy\nX-Frame-Options', help: 'HTTP response headers that must be present. Leave empty to check all known security headers.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (event.eventType !== 'infra.header.missing') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      hostname: string;
      missingHeaders: string[];
    };

    const required = config.requiredHeaders.length > 0
      ? config.requiredHeaders
      : [...ALL_HEADERS];

    // Intersect: only alert on missing headers the user actually requires
    const relevant = payload.missingHeaders.filter((h) =>
      required.some((r) => r.toLowerCase() === h.toLowerCase()),
    );

    if (relevant.length === 0) return null;

    // HSTS or CSP missing is high; others are medium
    const hasCriticalMissing = relevant.some((h) => {
      const lower = h.toLowerCase();
      return lower === 'hsts' || lower === 'csp';
    });
    const severity = hasCriticalMissing ? 'high' : 'medium';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title: `Missing security headers on ${payload.hostname}`,
      description: `The following required security headers are absent: ${relevant.join(', ')}`,
      triggerType: 'immediate',
      triggerData: { ...payload, missingHeaders: relevant },
    };
  },
};
