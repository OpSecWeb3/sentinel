import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

const configSchema = z.object({
  /** Maximum days until domain expiry before alerting */
  thresholdDays: z.number().int().positive().default(30),
});

function severityForDays(days: number): 'critical' | 'high' | 'medium' {
  if (days <= 7) return 'critical';
  if (days <= 14) return 'high';
  return 'medium';
}

export const whoisExpiryEvaluator: RuleEvaluator = {
  moduleId: 'infra',
  ruleType: 'infra.whois_expiry',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;

    if (event.eventType !== 'infra.whois.expiring') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      hostname: string;
      daysRemaining: number;
      expiryDate: string;
      registrar: string | null;
    };

    if (payload.daysRemaining > config.thresholdDays) return null;

    const severity = severityForDays(payload.daysRemaining);

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title: `Domain for ${payload.hostname} expires in ${payload.daysRemaining} days`,
      description: `The domain registration for ${payload.hostname} expires on ${payload.expiryDate} (${payload.daysRemaining} days remaining, threshold: ${config.thresholdDays}d).${payload.registrar ? ` Registrar: ${payload.registrar}` : ''}`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
