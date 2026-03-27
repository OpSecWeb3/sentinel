import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

const configSchema = z.object({
  /** Alert on legacy TLS versions (1.0 / 1.1) */
  alertOnLegacyVersions: z.boolean().default(true),
  /** Alert on weak cipher suites */
  alertOnWeakCiphers: z.boolean().default(true),
  /** Alert when TLS 1.3 is not supported */
  alertOnMissingTls13: z.boolean().default(false),
});

export const tlsWeaknessEvaluator: RuleEvaluator = {
  moduleId: 'infra',
  ruleType: 'infra.tls_weakness',
  configSchema,
  uiSchema: [
    { key: 'alertOnLegacyVersions', label: 'Alert on TLS 1.0 / 1.1', type: 'boolean', required: false, default: true },
    { key: 'alertOnWeakCiphers', label: 'Alert on weak cipher suites', type: 'boolean', required: false, default: true },
    { key: 'alertOnMissingTls13', label: 'Alert when TLS 1.3 not supported', type: 'boolean', required: false, default: false },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (event.eventType !== 'infra.tls.weakness') return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as {
      hostname: string;
      hasTls10: boolean;
      hasTls11: boolean;
      hasTls13: boolean;
      hasWeakCiphers: boolean;
      weakCipherList: string[];
      legacyVersions: string[];
    };

    const issues: string[] = [];

    if (config.alertOnLegacyVersions && payload.legacyVersions.length > 0) {
      issues.push(`Legacy TLS versions enabled: ${payload.legacyVersions.join(', ')}`);
    }

    if (config.alertOnWeakCiphers && payload.hasWeakCiphers) {
      const cipherText = payload.weakCipherList.length > 0
        ? payload.weakCipherList.join(', ')
        : 'detected';
      issues.push(`Weak cipher suites: ${cipherText}`);
    }

    if (config.alertOnMissingTls13 && !payload.hasTls13) {
      issues.push('TLS 1.3 not supported');
    }

    if (issues.length === 0) return null;

    // Legacy versions or weak ciphers are critical; missing TLS 1.3 alone is medium
    const severity =
      (config.alertOnLegacyVersions && payload.legacyVersions.length > 0) || payload.hasWeakCiphers
        ? 'critical'
        : 'medium';

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity,
      title: `TLS weakness detected on ${payload.hostname}`,
      description: issues.join('; '),
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
