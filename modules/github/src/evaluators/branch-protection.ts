import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  alertOnActions: z.array(z.enum(['created', 'edited', 'deleted'])).default(['edited', 'deleted']),
  watchBranches: z.array(z.string()).default([]),  // empty = all branches
});

export const branchProtectionEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.branch_protection',
  configSchema,
  uiSchema: [
    { key: 'alertOnActions', label: 'Actions to alert on', type: 'string-array', required: false, placeholder: 'created\nedited\ndeleted', help: 'Leave empty to alert on all actions. Values: created, edited, deleted.' },
    { key: 'watchBranches', label: 'Branches to watch', type: 'string-array', required: false, placeholder: 'main\nmaster\nrelease/*', help: 'Branch patterns to monitor. Leave empty to watch all branches.' },
  ] as TemplateInput[],

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

    // Check branch filter — supports glob patterns (e.g. release/*) via minimatch
    if (config.watchBranches.length > 0) {
      const branchPattern = payload.rule?.pattern ?? payload.rule?.name ?? '';
      if (!config.watchBranches.some((b) => minimatch(branchPattern, b))) {
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
