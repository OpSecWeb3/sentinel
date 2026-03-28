import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  alertOnActions: z.array(z.enum(['added', 'removed', 'edited', 'member_added', 'member_removed', 'member_invited'])).default(['added', 'removed']),
  watchRoles: z.array(z.string()).default([]),  // empty = all roles
});

export const memberChangeEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.member_change',
  configSchema,
  uiSchema: [
    { key: 'alertOnActions', label: 'Membership actions to alert on', type: 'string-array', required: false, placeholder: 'added\nremoved\nedited', help: 'Leave empty for all actions. Supports both repo collaborator (added/removed/edited) and org membership (member_added/member_removed/member_invited) events.' },
    { key: 'watchRoles', label: 'Roles to watch', type: 'string-array', required: false, placeholder: 'admin\nmaintainer', help: 'Leave empty to watch all roles.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;

    // Support both repo collaborator events (github.member.*) and
    // org membership events (github.organization.member_*).
    const isRepoMember = event.eventType.startsWith('github.member.');
    const isOrgMember = event.eventType.startsWith('github.organization.');
    if (!isRepoMember && !isOrgMember) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      action: string;
      // Repo collaborator events use `member`
      member?: { login: string; id?: number; role?: string };
      repository?: { full_name: string };
      // Org membership events use `membership`
      organization?: { login: string };
      membership?: { user?: { login: string }; role?: string };
      sender: { login: string };
    };

    if (!config.alertOnActions.includes(payload.action as any)) {
      return null;
    }

    // Extract member info from whichever payload shape we have
    const memberLogin = isRepoMember
      ? (payload.member?.login ?? 'unknown')
      : (payload.membership?.user?.login ?? 'unknown');

    const memberRole = isRepoMember
      ? (payload.member?.role ?? null)
      : (payload.membership?.role ?? null);

    if (config.watchRoles.length > 0) {
      if (!memberRole || !config.watchRoles.includes(memberRole)) return null;
    }

    // Scope: repo name for collaborator events, org name for org events
    const scope = payload.repository?.full_name
      ?? payload.organization?.login
      ?? 'unknown';
    const scopeLabel = payload.repository ? 'repository' : 'organization';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `Member ${memberLogin} ${payload.action} in ${scopeLabel} ${scope}`,
      description: `${payload.sender.login} triggered ${payload.action} for ${memberLogin}${memberRole ? ` as ${memberRole}` : ''}`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
