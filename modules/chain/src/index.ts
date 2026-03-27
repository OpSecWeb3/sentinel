import type { DetectionModule } from '@sentinel/shared/module';
import { chainRouter } from './router.js';
import { eventMatchEvaluator } from './evaluators/event-match.js';
import { functionCallMatchEvaluator } from './evaluators/function-call-match.js';
import { windowedCountEvaluator } from './evaluators/windowed-count.js';
import { windowedSpikeEvaluator } from './evaluators/windowed-spike.js';
import { balanceTrackEvaluator } from './evaluators/balance-track.js';
import { statePollEvaluator } from './evaluators/state-poll.js';
import { viewCallEvaluator } from './evaluators/view-call.js';
import { windowedSumEvaluator } from './evaluators/windowed-sum.js';
import { blockPollHandler, blockProcessHandler, statePollHandler, ruleSyncHandler, contractVerifyHandler, rpcUsageFlushHandler, blockAggregateHandler } from './handlers.js';
import { eventTypes } from './event-types.js';
import { templates } from './templates/index.js';

export const ChainModule: DetectionModule = {
  id: 'chain',
  name: 'Chain',
  router: chainRouter,
  evaluators: [
    eventMatchEvaluator,
    functionCallMatchEvaluator,
    windowedCountEvaluator,
    windowedSpikeEvaluator,
    balanceTrackEvaluator,
    statePollEvaluator,
    viewCallEvaluator,
    windowedSumEvaluator,
  ],
  jobHandlers: [blockPollHandler, blockProcessHandler, statePollHandler, ruleSyncHandler, contractVerifyHandler, rpcUsageFlushHandler, blockAggregateHandler],
  eventTypes,
  templates,
};
