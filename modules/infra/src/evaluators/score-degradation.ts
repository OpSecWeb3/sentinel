import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

const configSchema = z.object({
  /** Alert when score drops below this absolute threshold */
  minScore: z.number().int().min(0).max(100).default(70),
  /** Alert when score drops by at least this many points since last scan */
  minDrop: z.number().int().min(1).default(10),
  /** Which check to apply: 'below', 'drop', or 'both' */
  mode: z.enum(['below', 'drop', 'both']).default('both'),
});

export const scoreDegradationEvaluator: RuleEvaluator = {
  moduleId: 'infra',
  ruleType: 'infra.score_degradation',
  configSchema,

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
    if ((config.mode === 'below' || config.mode === 'both') && payload.currentScore < config.minScore) {
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
