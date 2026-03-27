import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  alertOnActions: z.array(z.enum(['created', 'resolved', 'reopened'])).default(['created']),
  secretTypes: z.array(z.string()).default([]),  // empty = all types
});

export const secretScanningEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.secret_scanning',
  configSchema,
  uiSchema: [
    { key: 'alertOnActions', label: 'Alert on actions', type: 'string-array', required: false, placeholder: 'created\nresolved\nreopened', help: 'Leave empty for all actions.' },
    { key: 'secretTypes', label: 'Secret types to watch', type: 'string-array', required: false, placeholder: 'github_personal_access_token\naws_access_key_id', help: 'Leave empty to alert on all secret types.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (!event.eventType.startsWith('github.secret_scanning.')) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      action: string;
      alert: { number: number; secret_type: string; state: string };
      repository: { full_name: string };
      sender: { login: string };
    };

    if (!config.alertOnActions.includes(payload.action as 'created' | 'resolved' | 'reopened')) {
      return null;
    }

    // Filter by secret type if specified
    if (config.secretTypes.length > 0 && !config.secretTypes.includes(payload.alert.secret_type)) {
      return null;
    }

    const severity = payload.action === 'created' ? 'critical' : 'medium';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title: `Secret scanning alert ${payload.action} on ${payload.repository.full_name}`,
      description: `${payload.alert.secret_type} secret detected (alert #${payload.alert.number}) — ${payload.action} by ${payload.sender.login}`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
