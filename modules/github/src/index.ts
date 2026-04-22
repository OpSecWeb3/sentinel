import type { DetectionModule } from '@sentinel/shared/module';
import { githubRouter, setWebhookRateLimitRedis } from './router.js';
export { setWebhookRateLimitRedis };
import { repoVisibilityEvaluator } from './evaluators/repo-visibility.js';
import { branchProtectionEvaluator } from './evaluators/branch-protection.js';
import { memberChangeEvaluator } from './evaluators/member-change.js';
import { deployKeyEvaluator } from './evaluators/deploy-key.js';
import { secretScanningEvaluator } from './evaluators/secret-scanning.js';
import { forcePushEvaluator } from './evaluators/force-push.js';
import { orgSettingsEvaluator } from './evaluators/org-settings.js';
import { repositoryAdvisoryEvaluator } from './evaluators/repository-advisory.js';
import { webhookProcessHandler, repoSyncHandler } from './handlers.js';
import { eventTypes } from './event-types.js';
import { templates } from './templates/index.js';
import { formatSlackBlocks } from './slack-formatter.js';

export const GitHubModule: DetectionModule = {
  id: 'github',
  name: 'GitHub',
  router: githubRouter,
  formatSlackBlocks,
  evaluators: [
    repoVisibilityEvaluator,
    branchProtectionEvaluator,
    memberChangeEvaluator,
    deployKeyEvaluator,
    secretScanningEvaluator,
    forcePushEvaluator,
    orgSettingsEvaluator,
    repositoryAdvisoryEvaluator,
  ],
  jobHandlers: [webhookProcessHandler, repoSyncHandler],
  eventTypes,
  templates,
};
