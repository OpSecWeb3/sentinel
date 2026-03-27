import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

const configSchema = z.object({
  /** Issuer name patterns to ignore (glob-like). E.g. ["Let's Encrypt*", "DigiCert*"] */
  ignorePatterns: z.array(z.string()).default([]),
});

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*') && pattern.endsWith('*')) {
    return value.includes(pattern.slice(1, -1));
  }
  if (pattern.startsWith('*')) {
    return value.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}

export const ctNewEntryEvaluator: RuleEvaluator = {
  moduleId: 'infra',
  ruleType: 'infra.ct_new_entry',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (event.eventType !== 'infra.ct.new_entry') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      hostname: string;
      issuerName: string | null;
      commonName: string | null;
      nameValue: string | null;
      serialNumber: string | null;
      notBefore: string | null;
      notAfter: string | null;
      entryTimestamp: string | null;
    };

    // Check ignore patterns against issuer
    if (
      payload.issuerName &&
      config.ignorePatterns.some((pattern) => matchesPattern(payload.issuerName!, pattern))
    ) {
      return null;
    }

    const cn = payload.commonName ?? payload.nameValue ?? 'unknown';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'medium',
      title: `New CT log entry for ${payload.hostname}: ${cn}`,
      description: `A new certificate was logged in Certificate Transparency for ${payload.hostname}. Common name: ${cn}, Issuer: ${payload.issuerName ?? 'unknown'}`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
