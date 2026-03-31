import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  alertOn: z.enum(['publicized', 'privatized', 'any']).default('publicized'),
  excludeRepos: z.array(z.string()).default([]),
});

export const repoVisibilityEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.repo_visibility',
  configSchema,
  uiSchema: [
    { key: 'alertOn', label: 'Alert when repo is', type: 'select', required: false, options: [{ value: 'publicized', label: 'Made public' }, { value: 'privatized', label: 'Made private' }, { value: 'any', label: 'Either direction' }] },
    { key: 'excludeRepos', label: 'Repos to exclude', type: 'string-array', required: false, placeholder: 'my-public-repo\narchived-*', help: 'Glob patterns for repositories to ignore.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (event.eventType !== 'github.repository.visibility_changed') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      action: string;
      repository?: { full_name?: string; visibility?: string };
      sender: { login: string };
    };

    const repoFullName = payload.repository?.full_name;
    const visibility = payload.repository?.visibility;
    if (!repoFullName || !visibility) return null;

    // Check repo exclusions
    if (config.excludeRepos.some((pattern) => minimatch(repoFullName, pattern))) {
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
      title: `Repository ${repoFullName} made ${visibility}`,
      description: `${payload.sender.login} changed repository visibility to ${visibility}`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
