import type { DetectionModule } from '@sentinel/shared/module';
import { releaseChainRouter } from './router.js';
import { digestChangeEvaluator } from './evaluators/digest-change.js';
import { attributionEvaluator } from './evaluators/attribution.js';
import { securityPolicyEvaluator } from './evaluators/security-policy.js';
import { npmChecksEvaluator } from './evaluators/npm-checks.js';
import { anomalyDetectionEvaluator } from './evaluators/anomaly-detection.js';
import { webhookProcessHandler, pollHandler, attributionHandler, ciNotifyHandler, verifyHandler, verifyAggregateHandler } from './handlers.js';
import { eventTypes } from './event-types.js';
import { templates } from './templates/index.js';

export const ReleaseChainModule: DetectionModule = {
  id: 'release-chain',
  name: 'Release Chain',
  router: releaseChainRouter,
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
};
