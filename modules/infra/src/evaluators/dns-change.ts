import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

const configSchema = z.object({
  /** Which DNS record types to watch; empty = all */
  watchRecordTypes: z.array(z.string()).default([]),
  /** Only alert on specific change types: added, modified, removed; empty = all */
  watchChangeTypes: z.array(z.enum(['added', 'modified', 'removed'])).default([]),
});

export const dnsChangeEvaluator: RuleEvaluator = {
  moduleId: 'infra',
  ruleType: 'infra.dns_change',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (event.eventType !== 'infra.dns.change') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      hostname: string;
      changes: Array<{
        recordType: string;
        changeType: string;
        oldValue?: string;
        newValue?: string;
        severity?: string;
      }>;
    };

    // Filter changes by configured record types
    let relevantChanges = payload.changes;
    if (config.watchRecordTypes.length > 0) {
      relevantChanges = relevantChanges.filter((c) =>
        config.watchRecordTypes.includes(c.recordType),
      );
    }
    if (config.watchChangeTypes.length > 0) {
      relevantChanges = relevantChanges.filter((c) =>
        config.watchChangeTypes.includes(c.changeType as any),
      );
    }

    if (relevantChanges.length === 0) return null;

    // NS record changes or any critical-flagged change elevate severity
    const hasCritical = relevantChanges.some(
      (c) => c.severity === 'critical' || c.recordType === 'NS',
    );
    const severity = hasCritical ? 'critical' : 'high';

    const summary = relevantChanges
      .map((c) => `${c.changeType} ${c.recordType}: ${c.oldValue ?? ''} -> ${c.newValue ?? ''}`)
      .join('; ');

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title: `DNS change detected for ${payload.hostname} (${relevantChanges.length} change${relevantChanges.length === 1 ? '' : 's'})`,
      description: summary,
      triggerType: 'immediate',
      triggerData: { ...payload, changes: relevantChanges },
    };
  },
};
