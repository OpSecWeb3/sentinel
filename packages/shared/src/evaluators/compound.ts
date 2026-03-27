import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate, RuleRow } from '../rules.js';

const subRuleSchema = z.object({
  ruleType: z.string(),
  config: z.record(z.unknown()),
});

const configSchema = z.object({
  operator: z.enum(['AND', 'OR']),
  /** For N-of-M logic: at least `threshold` sub-rules must trigger. Ignored for AND/OR. */
  threshold: z.number().int().positive().optional(),
  subRules: z.array(subRuleSchema).min(1),
});

export const compoundEvaluator: RuleEvaluator = {
  moduleId: 'platform',
  ruleType: 'platform.compound',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule, redis, resourceId, evaluators } = ctx;
    if (!evaluators) return null;

    const config = configSchema.parse(rule.config);
    const results: Array<{ candidate: AlertCandidate; ruleType: string }> = [];

    for (const subRule of config.subRules) {
      // Resolve evaluator by scanning for matching ruleType suffix
      // Keys are formatted as "moduleId:ruleType"
      let evaluator: RuleEvaluator | undefined;
      for (const [key, ev] of evaluators) {
        if (ev.ruleType === subRule.ruleType || key.endsWith(`:${subRule.ruleType}`)) {
          evaluator = ev;
          break;
        }
      }
      if (!evaluator) continue;

      // Validate sub-rule config
      const parsed = evaluator.configSchema.safeParse(subRule.config);
      if (!parsed.success) continue;

      // Build a synthetic RuleRow for the sub-rule evaluation
      const syntheticRule: RuleRow = {
        id: `${rule.id}:sub:${subRule.ruleType}`,
        detectionId: rule.detectionId,
        orgId: rule.orgId,
        moduleId: evaluator.moduleId,
        ruleType: subRule.ruleType,
        config: subRule.config,
        status: 'active',
        priority: rule.priority,
        action: rule.action,
      };

      try {
        const candidate = await evaluator.evaluate({
          event,
          rule: syntheticRule,
          redis,
          resourceId,
          evaluators,
        });
        if (candidate) {
          results.push({ candidate, ruleType: subRule.ruleType });
        }
      } catch {
        // Sub-rule evaluation failed — skip it
      }
    }

    const total = config.subRules.length;
    const triggered = results.length;

    // Determine if compound condition is met
    let met = false;
    if (config.threshold !== undefined) {
      // N-of-M mode
      met = triggered >= config.threshold;
    } else if (config.operator === 'AND') {
      met = triggered === total;
    } else {
      // OR
      met = triggered > 0;
    }

    if (!met) return null;

    // Combine sub-rule results into a single alert
    const titles = results.map((r) => r.candidate.title);
    const severities = results.map((r) => r.candidate.severity);
    const highestSeverity = pickHighestSeverity(severities);

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: highestSeverity,
      title: `Compound rule triggered (${triggered}/${total} ${config.operator}): ${titles[0]}`,
      description: `Compound detection with ${config.operator} logic: ${triggered} of ${total} sub-rules triggered.\n\nTriggered sub-rules:\n${titles.map((t) => `- ${t}`).join('\n')}`,
      triggerType: 'immediate',
      triggerData: {
        operator: config.operator,
        threshold: config.threshold,
        totalSubRules: total,
        triggeredCount: triggered,
        subResults: results.map((r) => ({
          ruleType: r.ruleType,
          title: r.candidate.title,
          severity: r.candidate.severity,
        })),
      },
    };
  },
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

function pickHighestSeverity(severities: string[]): string {
  for (const s of SEVERITY_ORDER) {
    if (severities.includes(s)) return s;
  }
  return 'medium';
}
