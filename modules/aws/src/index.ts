import type { DetectionModule } from '@sentinel/shared/module';
import { awsRouter } from './router.js';
import { eventMatchEvaluator } from './evaluators/event-match.js';
import { rootActivityEvaluator } from './evaluators/root-activity.js';
import { authFailureEvaluator } from './evaluators/auth-failure.js';
import { spotEvictionEvaluator } from './evaluators/spot-eviction.js';
import { pollSweepHandler, sqsPollHandler, eventProcessHandler } from './handlers.js';
import { eventTypes } from './event-types.js';
import { templates } from './templates/index.js';

export const AwsModule: DetectionModule = {
  id: 'aws',
  name: 'AWS',
  router: awsRouter,
  evaluators: [
    eventMatchEvaluator,
    rootActivityEvaluator,
    authFailureEvaluator,
    spotEvictionEvaluator,
  ],
  jobHandlers: [pollSweepHandler, sqsPollHandler, eventProcessHandler],
  eventTypes,
  templates,
  retentionPolicies: [
    // Raw CloudTrail event buffer: 7-day retention (short, as per design intent).
    // Only events that triggered detections are promoted to the platform events table.
    { table: 'aws_raw_events', timestampColumn: 'received_at', retentionDays: 7 },
    // Platform-level events for this module: shorter than the 90-day default
    // because CloudTrail volumes can be very high. Alerts (365 days) still
    // retain the full incident context.
    { table: 'events', timestampColumn: 'received_at', retentionDays: 14, filter: "module_id = 'aws'" },
  ],
};
