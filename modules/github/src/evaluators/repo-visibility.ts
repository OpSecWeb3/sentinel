import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

const configSchema = z.object({
  alertOn: z.enum(['publicized', 'privatized', 'any']).default('publicized'),
  excludeRepos: z.array(z.string()).default([]),
});

export const repoVisibilityEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.repo_visibility',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (event.eventType !== 'github.repository.visibility_changed') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      action: string;
      repository: { full_name: string; visibility: string };
      sender: { login: string };
    };

    // Check repo exclusions
    if (config.excludeRepos.some((pattern) => minimatch(payload.repository.full_name, pattern))) {
      return null;
    }

    // Check direction
    const wasPublicized = payload.action === 'publicized';
    if (config.alertOn === 'publicized' && !wasPublicized) return null;
    if (config.alertOn === 'privatized' && wasPublicized) return null;

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'critical',
      title: `Repository ${payload.repository.full_name} made ${payload.repository.visibility}`,
      description: `${payload.sender.login} changed repository visibility to ${payload.repository.visibility}`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
