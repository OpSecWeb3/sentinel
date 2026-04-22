import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

// https://docs.github.com/en/webhooks/webhook-events-and-payloads#repository_advisory
const ALL_ADVISORY_ACTIONS = [
  'published',
  'reported',
] as const;

type AdvisoryAction = (typeof ALL_ADVISORY_ACTIONS)[number];

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
type AdvisorySeverity = (typeof SEVERITY_ORDER)[number];

const configSchema = z.object({
  /** Empty = all actions. */
  alertOnActions: z
    .array(z.enum(ALL_ADVISORY_ACTIONS))
    .default(['published'])
    .transform((a) => (a.length > 0 ? a : [...ALL_ADVISORY_ACTIONS])),
  /** Minimum CVSS severity from the advisory to fire an alert. Empty = all. */
  minSeverity: z.enum(SEVERITY_ORDER).optional(),
});

export const repositoryAdvisoryEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.repository_advisory',
  configSchema,
  uiSchema: [
    { key: 'alertOnActions', label: 'Alert on actions', type: 'string-array', required: false, placeholder: 'published\nreported', help: 'Leave empty for all repository_advisory actions (published, reported).' },
    { key: 'minSeverity', label: 'Minimum advisory severity', type: 'select', required: false, options: [{ value: 'critical', label: 'Critical' }, { value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }], help: 'Only alert when the advisory severity meets or exceeds this threshold. Leave empty to alert on all.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (!event.eventType.startsWith('github.repository_advisory.')) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      action: string;
      advisory: {
        ghsa_id?: string;
        cve_id?: string;
        summary?: string;
        severity?: string;
        cvss?: { score?: number };
      };
      repository: { full_name: string };
      sender: { login: string };
    };

    if (!config.alertOnActions.includes(payload.action as AdvisoryAction)) {
      return null;
    }

    // Severity filtering
    const advisorySeverity = (payload.advisory.severity || '').toLowerCase();
    if (config.minSeverity) {
      const minIdx = SEVERITY_ORDER.indexOf(config.minSeverity);
      const actualIdx = SEVERITY_ORDER.indexOf(advisorySeverity as AdvisorySeverity);
      // If advisory severity is unknown, let it through; otherwise filter
      if (actualIdx !== -1 && actualIdx > minIdx) return null;
    }

    // Map advisory severity to alert severity, default to high
    const severity = SEVERITY_ORDER.includes(advisorySeverity as AdvisorySeverity)
      ? advisorySeverity
      : 'high';

    const advisoryId = payload.advisory.ghsa_id || payload.advisory.cve_id || 'unknown';
    const summary = payload.advisory.summary || 'No summary provided';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title: `Security advisory ${payload.action} on ${payload.repository.full_name}`,
      description: `${advisoryId}: ${summary} — ${payload.action} by ${payload.sender.login}`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
