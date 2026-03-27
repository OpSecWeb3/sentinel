import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

const configSchema = z.object({
  alertOnActions: z.array(z.enum(['created', 'edited', 'deleted'])).default(['edited', 'deleted']),
  watchBranches: z.array(z.string()).default([]),  // empty = all branches
});

export const branchProtectionEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.branch_protection',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (!event.eventType.startsWith('github.branch_protection.')) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      action: string;
      rule: { name: string; pattern: string };
      repository: { full_name: string };
      sender: { login: string };
      changes?: Record<string, unknown>;
    };

    // Check if we care about this action
    if (!config.alertOnActions.includes(payload.action as 'created' | 'edited' | 'deleted')) {
      return null;
    }

    // Check branch filter
    if (config.watchBranches.length > 0) {
      const pattern = payload.rule?.pattern ?? '';
      if (!config.watchBranches.some((b) => b === pattern || b === '*')) {
        return null;
      }
    }

    const severity = payload.action === 'deleted' ? 'critical' : 'high';
    const actionVerb = payload.action === 'deleted'
      ? 'removed'
      : payload.action === 'edited'
        ? 'modified'
        : 'created';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title: `Branch protection ${actionVerb} on ${payload.repository.full_name}`,
      description: `${payload.sender.login} ${actionVerb} branch protection rule "${payload.rule?.name ?? payload.rule?.pattern}"`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
