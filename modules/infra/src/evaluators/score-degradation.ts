import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  /** Alert when score drops below this absolute threshold */
  minScore: z.number().int().min(0).max(100).default(70),
  /** Alert when score drops by at least this many points since last scan */
  minDrop: z.number().int().min(1).default(10),
  /** Which check to apply: 'score' (below min), 'drop' (by N points), or 'both' (either condition) */
  mode: z.enum(['score', 'drop', 'both']).default('both'),
});

export const scoreDegradationEvaluator: RuleEvaluator = {
  moduleId: 'infra',
  ruleType: 'infra.score_degradation',
  configSchema,
  uiSchema: [
    { key: 'mode', label: 'Alert mode', type: 'select', required: false, options: [{ value: 'score', label: 'Score drops below minimum' }, { value: 'drop', label: 'Score drops by N points' }, { value: 'both', label: 'Either condition (OR)' }] },
    { key: 'minScore', label: 'Minimum acceptable score', type: 'number', required: false, default: 70, min: 0, max: 100 },
    { key: 'minDrop', label: 'Score drop to alert on', type: 'number', required: false, default: 10, min: 1 },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (event.eventType !== 'infra.score.degraded') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      hostname: string;
      currentScore: number;
      previousScore: number | null;
      grade: string;
    };

    const reasons: string[] = [];
    let triggered = false;

    // Check absolute threshold
    if ((config.mode === 'score' || config.mode === 'both') && payload.currentScore < config.minScore) {
      reasons.push(`Score ${payload.currentScore} is below threshold ${config.minScore}`);
      triggered = true;
    }

    // Check relative drop
    if (
      (config.mode === 'drop' || config.mode === 'both') &&
      payload.previousScore !== null
    ) {
      const drop = payload.previousScore - payload.currentScore;
      if (drop >= config.minDrop) {
        reasons.push(`Score dropped ${drop} points (${payload.previousScore} -> ${payload.currentScore})`);
        triggered = true;
      }
    }

    if (!triggered) return null;

    const drop = payload.previousScore !== null
      ? payload.previousScore - payload.currentScore
      : 0;
    const severity = drop >= 20 || payload.currentScore < 50 ? 'critical' : 'high';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title: `Security score degraded for ${payload.hostname} (${payload.grade}: ${payload.currentScore}/100)`,
      description: reasons.join('. '),
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
