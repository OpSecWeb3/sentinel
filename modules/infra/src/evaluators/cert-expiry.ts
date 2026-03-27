import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  /** Maximum days until expiry before alerting */
  thresholdDays: z.number().int().positive().default(30),
});

/**
 * Severity tiers based on days remaining:
 *   <= 0  -> critical  (already expired)
 *   <= 7  -> critical
 *   <= 14 -> high
 *   <= 30 -> medium
 */
function severityForDays(days: number): 'critical' | 'high' | 'medium' {
  if (days <= 7) return 'critical';
  if (days <= 14) return 'high';
  return 'medium';
}

export const certExpiryEvaluator: RuleEvaluator = {
  moduleId: 'infra',
  ruleType: 'infra.cert_expiry',
  configSchema,
  uiSchema: [
    { key: 'thresholdDays', label: 'Days before expiry to alert', type: 'number', required: false, default: 30, min: 1, help: 'Alert when a certificate expires within this many days.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;

    // React to scan-completed events that carry certificate data
    if (event.eventType !== 'infra.cert.expiring' && event.eventType !== 'infra.cert.expired') {
      return null;
    }

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      hostname: string;
      daysRemaining: number;
      notAfter: string;
      subject: string;
    };

    const days = payload.daysRemaining;

    // Only alert if within the configured threshold
    if (days > config.thresholdDays) return null;

    const severity = severityForDays(days);
    const expired = days <= 0;

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title: expired
        ? `Certificate expired for ${payload.hostname}`
        : `Certificate for ${payload.hostname} expires in ${days} days`,
      description: expired
        ? `The TLS certificate for ${payload.hostname} (subject: ${payload.subject}) expired on ${payload.notAfter}.`
        : `The TLS certificate for ${payload.hostname} (subject: ${payload.subject}) expires on ${payload.notAfter} (${days} days remaining, threshold: ${config.thresholdDays}d).`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
