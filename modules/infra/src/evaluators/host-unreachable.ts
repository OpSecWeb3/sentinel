import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  /** Response time threshold in milliseconds for slow-response alerts */
  thresholdMs: z.number().int().positive().default(5000),
  /** Number of consecutive failures before alerting on unreachable */
  consecutiveFailures: z.number().int().positive().default(2),
});

export const hostUnreachableEvaluator: RuleEvaluator = {
  moduleId: 'infra',
  ruleType: 'infra.host_unreachable',
  configSchema,
  uiSchema: [
    { key: 'thresholdMs', label: 'Response timeout (ms)', type: 'number', required: false, default: 5000, min: 100, help: 'Alert when response time exceeds this value.' },
    { key: 'consecutiveFailures', label: 'Consecutive failures before alert', type: 'number', required: false, default: 2, min: 1, help: 'Require this many consecutive failures to avoid false positives.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;

    if (event.eventType === 'infra.host.unreachable') {
      return evaluateUnreachable(ctx);
    }

    if (event.eventType === 'infra.host.slow') {
      return evaluateSlow(ctx);
    }

    return null;
  },
};

async function evaluateUnreachable(ctx: EvalContext): Promise<AlertCandidate | null> {
  const { event, rule } = ctx;
  const config = configSchema.parse(rule.config);
  const payload = event.payload as {
    hostname: string;
    consecutiveFailures: number;
    isReachable: boolean;
    dnsResolved?: boolean;
    httpStatus?: number;
    errorMessage?: string;
  };

  if (payload.consecutiveFailures < config.consecutiveFailures) return null;

  const detail = payload.errorMessage
    ? ` Error: ${payload.errorMessage}`
    : payload.httpStatus
      ? ` HTTP ${payload.httpStatus}`
      : '';

  return {
    orgId: event.orgId,
    detectionId: rule.detectionId,
    ruleId: rule.id,
    eventId: event.id,
    severity: 'critical',
    title: `Host unreachable: ${payload.hostname}`,
    description: `${payload.hostname} failed ${payload.consecutiveFailures} consecutive reachability checks.${detail}`,
    triggerType: 'immediate',
    triggerData: payload,
  };
}

async function evaluateSlow(ctx: EvalContext): Promise<AlertCandidate | null> {
  const { event, rule } = ctx;
  const config = configSchema.parse(rule.config);
  const payload = event.payload as {
    hostname: string;
    responseTimeMs: number;
  };

  if (payload.responseTimeMs < config.thresholdMs) return null;

  return {
    orgId: event.orgId,
    detectionId: rule.detectionId,
    ruleId: rule.id,
    eventId: event.id,
    severity: 'high',
    title: `Slow response from ${payload.hostname}`,
    description: `${payload.hostname} responded in ${payload.responseTimeMs}ms (threshold: ${config.thresholdMs}ms)`,
    triggerType: 'immediate',
    triggerData: payload,
  };
}
