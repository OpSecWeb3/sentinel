import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

const configSchema = z.object({
  /** Subdomain patterns to ignore (glob-like). E.g. ['staging-*', 'test.*'] */
  ignorePatterns: z.array(z.string()).default([]),
});

/**
 * Simple glob matcher supporting only leading/trailing wildcards.
 * Sufficient for subdomain patterns like 'staging-*' or '*.internal'.
 */
function matchesPattern(subdomain: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*') && pattern.endsWith('*')) {
    return subdomain.includes(pattern.slice(1, -1));
  }
  if (pattern.startsWith('*')) {
    return subdomain.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith('*')) {
    return subdomain.startsWith(pattern.slice(0, -1));
  }
  return subdomain === pattern;
}

export const newSubdomainEvaluator: RuleEvaluator = {
  moduleId: 'infra',
  ruleType: 'infra.new_subdomain',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (event.eventType !== 'infra.subdomain.discovered') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      parentHostname: string;
      subdomain: string;
      source: string; // crt_sh, dns_zone, brute_force
    };

    // Check ignore patterns
    if (config.ignorePatterns.some((pattern) => matchesPattern(payload.subdomain, pattern))) {
      return null;
    }

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'medium',
      title: `New subdomain discovered: ${payload.subdomain}`,
      description: `Subdomain ${payload.subdomain} was discovered under ${payload.parentHostname} via ${payload.source}`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
