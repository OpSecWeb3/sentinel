import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

const configSchema = z.object({
  watchBranches: z.array(z.string()).default(['main', 'master', 'release/*', 'production']),
  alertOnAllForced: z.boolean().default(false),  // true = alert on any force push
});

export const forcePushEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.force_push',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (event.eventType !== 'github.push') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      ref: string;
      forced: boolean;
      repository: { full_name: string };
      pusher: { name: string };
      sender: { login: string };
      commits_count: number;
      head_commit: { id: string; message: string } | null;
    };

    // Only care about force pushes
    if (!payload.forced) return null;

    // Fix #15: Skip tag pushes — this evaluator is for branches only
    if (payload.ref.startsWith('refs/tags/')) return null;

    // Extract branch name from ref (refs/heads/main → main)
    const branch = payload.ref.replace('refs/heads/', '');

    // Check if this branch is watched
    if (!config.alertOnAllForced) {
      const matched = config.watchBranches.some((pattern) =>
        minimatch(branch, pattern) || pattern === branch,
      );
      if (!matched) return null;
    }

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'critical',
      title: `Force push to ${branch} on ${payload.repository.full_name}`,
      description: `${payload.sender.login} force-pushed to ${branch} (${payload.commits_count} commit${payload.commits_count === 1 ? '' : 's'})`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
