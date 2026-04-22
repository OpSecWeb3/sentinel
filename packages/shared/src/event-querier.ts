import type { NormalizedEvent } from './rules.js';
import type { EventFilter } from './correlation-types.js';

/**
 * Retrospective event lookup used by the CorrelationEngine for absence rules
 * with a lookback window. Implementations must scope reads to the given org
 * and filter by `occurred_at` (not ingestion time) so replays don't shift
 * window boundaries unpredictably.
 */
export interface EventQuerier {
  findEvents(
    orgId: string,
    filter: EventFilter,
    windowStart: Date,
    windowEnd: Date,
    limit?: number,
  ): Promise<NormalizedEvent[]>;
}
