import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

const configSchema = z.object({
  alertOnActions: z.array(z.enum(['created', 'deleted'])).default(['created']),
  alertOnWriteKeys: z.boolean().default(true),  // only alert on write-access keys
});

export const deployKeyEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.deploy_key',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (!event.eventType.startsWith('github.deploy_key.')) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      action: string;
      key: { id: number; title: string; read_only: boolean };
      repository: { full_name: string };
      sender: { login: string };
    };

    if (!config.alertOnActions.includes(payload.action as 'created' | 'deleted')) {
      return null;
    }

    // If alertOnWriteKeys is true, only alert on keys with write access
    if (config.alertOnWriteKeys && payload.key.read_only) {
      return null;
    }

    const accessLevel = payload.key.read_only ? 'read-only' : 'read-write';
    const severity = payload.key.read_only ? 'medium' : 'high';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title: `Deploy key ${payload.action} on ${payload.repository.full_name}`,
      description: `${payload.sender.login} ${payload.action} ${accessLevel} deploy key "${payload.key.title}"`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
