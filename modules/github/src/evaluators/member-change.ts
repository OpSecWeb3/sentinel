import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const ALL_MEMBER_ALERT_ACTIONS = [
  'added',
  'removed',
  'edited',
  'member_added',
  'member_removed',
  'member_invited',
] as const;

const configSchema = z.object({
  /** Empty array = alert on all membership / access actions (same idea as org_settings watchActions). */
  alertOnActions: z
    .array(z.enum(ALL_MEMBER_ALERT_ACTIONS))
    .default(['added', 'removed'])
    .transform((a) => (a.length > 0 ? a : [...ALL_MEMBER_ALERT_ACTIONS])),
  watchRoles: z.array(z.string()).default([]),  // empty = all roles
});

/**
 * GitHub uses different `action` strings for the same idea:
 * - Repo collaborator webhooks (`member`): `added` | `removed` | `edited`
 * - Org membership webhooks (`organization`): `member_added` | `member_removed` | `member_invited`
 * Rules often list only one family (e.g. full-suite style `member_*`), so we treat them as equivalent for matching.
 */
function membershipActionMatches(alertOnActions: string[], payloadAction: string): boolean {
  if (alertOnActions.includes(payloadAction)) return true;
  if (payloadAction === 'added' && alertOnActions.includes('member_added')) return true;
  if (payloadAction === 'removed' && alertOnActions.includes('member_removed')) return true;
  if (payloadAction === 'member_added' && alertOnActions.includes('added')) return true;
  if (payloadAction === 'member_removed' && alertOnActions.includes('removed')) return true;
  return false;
}

/** Team → repo access webhooks use different action names than collaborator `member` events. */
const TEAM_REPO_ACCESS_ACTIONS = new Set(['added_to_repository', 'removed_from_repository', 'edited']);

function teamRepoActionToMembershipAction(action: string): 'added' | 'removed' | 'edited' | null {
  if (action === 'added_to_repository') return 'added';
  if (action === 'removed_from_repository') return 'removed';
  if (action === 'edited') return 'edited';
  return null;
}

export const memberChangeEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.member_change',
  configSchema,
  uiSchema: [
    { key: 'alertOnActions', label: 'Membership actions to alert on', type: 'string-array', required: false, placeholder: 'added\nremoved\nedited', help: 'Leave empty for all actions. Covers repo collaborators, org membership, and team access to repos (added_to_repository / removed_from_repository / team permission edited).' },
    { key: 'watchRoles', label: 'Roles to watch', type: 'string-array', required: false, placeholder: 'admin\nmaintainer', help: 'Leave empty to watch all roles.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      action: string;
      member?: { login: string; id?: number; role?: string };
      repository?: { full_name: string };
      organization?: { login: string };
      membership?: { user?: { login: string }; role?: string };
      team?: { name?: string; slug?: string; permission?: string };
      sender: { login: string };
    };

    // Repo collaborator (`member`), org membership (`organization`), or team given access to a repo (`team`).
    // Team `edited` without a repository is an org-level team metadata change — org_settings covers that.
    const isRepoMember = event.eventType.startsWith('github.member.');
    const isOrgMember = event.eventType.startsWith('github.organization.');
    const isTeamRepoAccess =
      event.eventType.startsWith('github.team.') &&
      TEAM_REPO_ACCESS_ACTIONS.has(payload.action) &&
      Boolean(payload.repository?.full_name);

    if (!isRepoMember && !isOrgMember && !isTeamRepoAccess) return null;

    let actionForMatch: string;
    if (isTeamRepoAccess) {
      const mapped = teamRepoActionToMembershipAction(payload.action);
      if (mapped == null) return null;
      actionForMatch = mapped;
    } else {
      actionForMatch = payload.action;
    }

    if (!membershipActionMatches(config.alertOnActions, actionForMatch)) {
      return null;
    }

    const memberLogin = isTeamRepoAccess
      ? (payload.team?.slug ?? payload.team?.name ?? 'unknown')
      : isRepoMember
        ? (payload.member?.login ?? 'unknown')
        : (payload.membership?.user?.login ?? 'unknown');

    const memberRole = isTeamRepoAccess
      ? (payload.team?.permission ?? null)
      : isRepoMember
        ? (payload.member?.role ?? null)
        : (payload.membership?.role ?? null);

    if (config.watchRoles.length > 0) {
      if (!memberRole || !config.watchRoles.includes(memberRole)) return null;
    }

    const scope = payload.repository?.full_name
      ?? payload.organization?.login
      ?? 'unknown';
    const scopeLabel = payload.repository ? 'repository' : 'organization';

    const subjectLabel = isTeamRepoAccess ? 'Team' : 'Member';
    const roleSuffix = memberRole ? ` as ${memberRole}` : '';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',
      title: `${subjectLabel} ${memberLogin} ${payload.action} in ${scopeLabel} ${scope}`,
      description: `${payload.sender.login} triggered ${payload.action} for ${subjectLabel.toLowerCase()} ${memberLogin}${roleSuffix}`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
