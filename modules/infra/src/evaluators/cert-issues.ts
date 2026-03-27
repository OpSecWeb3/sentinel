import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

const ISSUE_TYPES = [
  'chain_error',
  'self_signed',
  'weak_key',
  'sha1_signature',
  'revoked',
] as const;

const configSchema = z.object({
  /** Which issue types to alert on; empty = all */
  issueTypes: z.array(z.enum(ISSUE_TYPES)).default([]),
});

const SEVERITY_MAP: Record<string, 'critical' | 'high' | 'medium'> = {
  revoked: 'critical',
  chain_error: 'critical',
  self_signed: 'high',
  weak_key: 'high',
  sha1_signature: 'medium',
};

export const certIssuesEvaluator: RuleEvaluator = {
  moduleId: 'infra',
  ruleType: 'infra.cert_issues',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (event.eventType !== 'infra.cert.issue') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      hostname: string;
      issueType: string;
      detail: string;
      subject?: string;
      issuer?: string;
    };

    // If the rule is scoped to specific issue types, filter
    if (config.issueTypes.length > 0 && !config.issueTypes.includes(payload.issueType as any)) {
      return null;
    }

    const severity = SEVERITY_MAP[payload.issueType] ?? 'high';

    const LABELS: Record<string, string> = {
      chain_error: 'Certificate chain validation error',
      self_signed: 'Self-signed certificate detected',
      weak_key: 'Weak certificate key detected',
      sha1_signature: 'SHA-1 signature algorithm detected',
      revoked: 'Certificate has been revoked',
    };

    const label = LABELS[payload.issueType] ?? `Certificate issue: ${payload.issueType}`;

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title: `${label} on ${payload.hostname}`,
      description: payload.detail,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
