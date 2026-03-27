import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  watchActions: z.array(z.string()).default([]),  // empty = all actions
});

export const orgSettingsEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.org_settings',
  configSchema,
  uiSchema: [
    { key: 'watchActions', label: 'Actions to watch', type: 'string-array', required: false, placeholder: 'member_added\nteam_created\norg_setting_changed', help: 'Leave empty to watch all org/team actions.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;

    // Match organization and team events
    const isOrgEvent = event.eventType.startsWith('github.organization.');
    const isTeamEvent = event.eventType.startsWith('github.team.');
    if (!isOrgEvent && !isTeamEvent) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      action: string;
      organization?: { login: string };
      team?: { name: string; slug: string; permission: string };
      membership?: unknown;
      sender: { login: string };
    };

    // Filter by action if specified
    if (config.watchActions.length > 0 && !config.watchActions.includes(payload.action)) {
      return null;
    }

    let title: string;
    let description: string;
    let severity: 'critical' | 'high' | 'medium' | 'low';

    if (isTeamEvent) {
      const teamName = payload.team?.name ?? 'unknown';
      title = `Team ${payload.action}: ${teamName}`;
      description = `${payload.sender.login} ${payload.action} team "${teamName}"`;
      severity = payload.action === 'deleted' ? 'high' : 'medium';

      if (payload.team?.permission === 'admin' && payload.action === 'created') {
        severity = 'high';
        description += ' with admin permissions';
      }
    } else {
      const orgLogin = payload.organization?.login ?? 'unknown';
      title = `Organization event: ${payload.action}`;
      description = `${payload.sender.login} triggered ${payload.action} on ${orgLogin}`;

      // Member events are higher severity
      severity = ['member_added', 'member_removed', 'member_invited'].includes(payload.action)
        ? 'high'
        : 'medium';
    }

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title,
      description,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
