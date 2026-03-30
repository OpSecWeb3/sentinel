import type { DetectionModule } from '@sentinel/shared/module';
import { registryRouter } from './router.js';
import { digestChangeEvaluator } from './evaluators/digest-change.js';
import { attributionEvaluator } from './evaluators/attribution.js';
import { securityPolicyEvaluator } from './evaluators/security-policy.js';
import { npmChecksEvaluator } from './evaluators/npm-checks.js';
import { anomalyDetectionEvaluator } from './evaluators/anomaly-detection.js';
import { webhookProcessHandler, pollHandler, attributionHandler, ciNotifyHandler, verifyHandler, verifyAggregateHandler } from './handlers.js';
import { eventTypes } from './event-types.js';
import { templates } from './templates/index.js';
import { formatSlackBlocks } from './slack-formatter.js';

export { initVerification } from './verification.js';
export { setRegistryWebhookRateLimitRedis } from './router.js';

export const RegistryModule: DetectionModule = {
  id: 'registry',
  name: 'Registry',
  router: registryRouter,
  formatSlackBlocks,
  evaluators: [
    digestChangeEvaluator,
    attributionEvaluator,
    securityPolicyEvaluator,
    npmChecksEvaluator,
    anomalyDetectionEvaluator,
  ],
  jobHandlers: [webhookProcessHandler, pollHandler, attributionHandler, ciNotifyHandler, verifyHandler, verifyAggregateHandler],
  eventTypes,
  templates,
  retentionPolicies: [
    // CI build notifications: one row per CI workflow report. Low volume but
    // unbounded without a policy. 90 days matches infra scan step results.
    { table: 'rc_ci_notifications', timestampColumn: 'created_at', retentionDays: 90 },
  ],
};
