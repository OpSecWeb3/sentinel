import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

// https://docs.github.com/en/webhooks/webhook-events-and-payloads#secret_scanning_alert
const ALL_SECRET_SCANNING_ACTIONS = [
  'assigned',
  'created',
  'publicly_leaked',
  'reopened',
  'resolved',
  'unassigned',
  'validated',
] as const;

type SecretScanningAction = (typeof ALL_SECRET_SCANNING_ACTIONS)[number];

const configSchema = z.object({
  /** Empty = all actions documented for `secret_scanning_alert`. */
  alertOnActions: z
    .array(z.enum(ALL_SECRET_SCANNING_ACTIONS))
    .default(['created'])
    .transform((a) => (a.length > 0 ? a : [...ALL_SECRET_SCANNING_ACTIONS])),
  secretTypes: z.array(z.string()).default([]),  // empty = all types
});

export const secretScanningEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.secret_scanning',
  configSchema,
  uiSchema: [
    { key: 'alertOnActions', label: 'Alert on actions', type: 'string-array', required: false, placeholder: 'created\npublicly_leaked\nresolved', help: 'Leave empty for all secret_scanning_alert actions (assigned, created, publicly_leaked, reopened, resolved, unassigned, validated).' },
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

    if (!config.alertOnActions.includes(payload.action as SecretScanningAction)) {
      return null;
    }

    // Filter by secret type if specified
    if (config.secretTypes.length > 0 && !config.secretTypes.includes(payload.alert.secret_type)) {
      return null;
    }

    const criticalActions: SecretScanningAction[] = ['created', 'publicly_leaked'];
    const severity = criticalActions.includes(payload.action as SecretScanningAction) ? 'critical' : 'medium';

    const lead =
      payload.action === 'created' || payload.action === 'publicly_leaked'
        ? `${payload.alert.secret_type} secret`
        : `Secret scanning alert (${payload.alert.secret_type})`;

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title: `Secret scanning alert ${payload.action} on ${payload.repository.full_name}`,
      description: `${lead} — alert #${payload.alert.number}, ${payload.action} by ${payload.sender.login}`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
