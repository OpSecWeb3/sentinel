import type { DetectionModule } from '@sentinel/shared/module';
import { awsRouter } from './router.js';
import { eventMatchEvaluator } from './evaluators/event-match.js';
import { rootActivityEvaluator } from './evaluators/root-activity.js';
import { authFailureEvaluator } from './evaluators/auth-failure.js';
import { spotEvictionEvaluator } from './evaluators/spot-eviction.js';
import { pollSweepHandler, sqsPollHandler, eventProcessHandler } from './handlers.js';
import { eventTypes } from './event-types.js';
import { templates } from './templates/index.js';
import { formatSlackBlocks } from './slack-formatter.js';

export const AwsModule: DetectionModule = {
  id: 'aws',
  name: 'AWS',
  router: awsRouter,
  formatSlackBlocks,
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
    // Raw CloudTrail event buffer: 7-day hot buffer. Every incoming CloudTrail
    // event lives here so that new detections can backfill across the last week.
    { table: 'aws_raw_events', timestampColumn: 'received_at', retentionDays: 7 },
    // Platform events for AWS: value-driven retention. The floor TTL is 1 day
    // for high-volume CloudTrail noise, but we preserve two classes of rows
    // indefinitely (within the broader 365-day alerts retention):
    //   1. Events that produced an alert (referenced_by alerts.event_id) so
    //      that the full incident context survives as long as the alert does.
    //   2. Events still inside the active correlation rules' lookback window,
    //      so absence / sequence / aggregation evaluators always see their
    //      substrate regardless of whether any single event matched a rule.
    {
      table: 'events',
      timestampColumn: 'received_at',
      retentionDays: 1,
      filter: "module_id = 'aws'",
      preserveIf: [
        { kind: 'referenced_by', table: 'alerts', column: 'event_id' },
        { kind: 'within_correlation_window' },
      ],
    },
  ],
};
