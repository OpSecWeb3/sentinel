import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const ALL_BRANCH_PROTECTION_ACTIONS = ['created', 'edited', 'deleted'] as const;

const configSchema = z.object({
  /** Empty = all actions (matches GitHub branch_protection_rule webhook). */
  alertOnActions: z
    .array(z.enum(ALL_BRANCH_PROTECTION_ACTIONS))
    .default(['edited', 'deleted'])
    .transform((a) => (a.length > 0 ? a : [...ALL_BRANCH_PROTECTION_ACTIONS])),
  watchBranches: z.array(z.string()).default([]),  // empty = all branches
});

export const branchProtectionEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.branch_protection',
  configSchema,
  uiSchema: [
    { key: 'alertOnActions', label: 'Actions to alert on', type: 'string-array', required: false, placeholder: 'created\nedited\ndeleted', help: 'Leave empty for rule actions (created, edited, deleted). Repo-wide disable/enable (branch_protection_configuration) also matches deleted/created respectively.' },
    { key: 'watchBranches', label: 'Branches to watch', type: 'string-array', required: false, placeholder: 'main\nmaster\nrelease/*', help: 'Branch patterns to monitor. Leave empty to watch all branches.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    const isRuleEvent = event.eventType.startsWith('github.branch_protection.');
    const isConfigEvent = event.eventType.startsWith('github.branch_protection_configuration.');
    if (!isRuleEvent && !isConfigEvent) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      action: string;
      rule?: { name?: string; pattern?: string };
      repository: { full_name: string };
      sender: { login: string };
      changes?: Record<string, unknown>;
    };

    const matchesConfiguredAction = (): boolean => {
      const a = payload.action;
      if (config.alertOnActions.includes(a as 'created' | 'edited' | 'deleted')) return true;
      // GitHub branch_protection_configuration: disabled | enabled
      if (isConfigEvent) {
        if (a === 'disabled' && config.alertOnActions.includes('deleted')) return true;
        if (a === 'enabled' && config.alertOnActions.includes('created')) return true;
      }
      return false;
    };

    if (!matchesConfiguredAction()) {
      return null;
    }

    // Per-rule events: optional branch glob filter. Configuration events affect the whole repo — never filter out.
    if (isRuleEvent && config.watchBranches.length > 0) {
      const branchPattern = payload.rule?.pattern ?? payload.rule?.name ?? '';
      if (!config.watchBranches.some((b) => minimatch(branchPattern, b))) {
        return null;
      }
    }

    if (isConfigEvent) {
      const severity = payload.action === 'disabled' ? 'critical' : 'high';
      const verb = payload.action === 'disabled' ? 'disabled' : 'enabled';
      return {
        orgId: event.orgId,
        detectionId: rule.detectionId,
        ruleId: rule.id,
        eventId: event.id,
        severity,
        title: `Branch protection ${verb} for ${payload.repository.full_name}`,
        description: `${payload.sender.login} ${verb} branch protection for the repository (all rules)`,
        triggerType: 'immediate',
        triggerData: payload,
      };
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
