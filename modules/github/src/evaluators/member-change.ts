import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

const configSchema = z.object({
  alertOnActions: z.array(z.enum(['added', 'removed', 'edited'])).default(['added', 'removed']),
  watchRoles: z.array(z.string()).default([]),  // empty = all roles
});

export const memberChangeEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.member_change',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (!event.eventType.startsWith('github.member.')) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      action: string;
      member: { login: string; id: number; role?: string };
      repository?: { full_name: string };
      sender: { login: string };
    };

    if (!config.alertOnActions.includes(payload.action as 'added' | 'removed' | 'edited')) {
      return null;
    }

    if (config.watchRoles.length > 0) {
      if (!payload.member.role || !config.watchRoles.includes(payload.member.role)) return null;
    }

    const scope = payload.repository
      ? `on ${payload.repository.full_name}`
      : 'in organization';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `Member ${payload.member.login} ${payload.action} ${scope}`,
      description: `${payload.sender.login} ${payload.action} ${payload.member.login}${payload.member.role ? ` as ${payload.member.role}` : ''}`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
