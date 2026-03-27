import type { DetectionModule } from '@sentinel/shared/module';
import { infraRouter } from './router.js';
import { certExpiryEvaluator } from './evaluators/cert-expiry.js';
import { certIssuesEvaluator } from './evaluators/cert-issues.js';
import { tlsWeaknessEvaluator } from './evaluators/tls-weakness.js';
import { dnsChangeEvaluator } from './evaluators/dns-change.js';
import { headerMissingEvaluator } from './evaluators/header-missing.js';
import { hostUnreachableEvaluator } from './evaluators/host-unreachable.js';
import { scoreDegradationEvaluator } from './evaluators/score-degradation.js';
import { newSubdomainEvaluator } from './evaluators/new-subdomain.js';
import { whoisExpiryEvaluator } from './evaluators/whois-expiry.js';
import { ctNewEntryEvaluator } from './evaluators/ct-new-entry.js';
import { scanHandler, probeHandler, scheduleLoaderHandler, scanAggregateHandler } from './handlers.js';
import { eventTypes } from './event-types.js';
import { templates } from './templates/index.js';

export const InfraModule: DetectionModule = {
  id: 'infra',
  name: 'Infrastructure',
  router: infraRouter,
  evaluators: [
    certExpiryEvaluator,
    certIssuesEvaluator,
    tlsWeaknessEvaluator,
    dnsChangeEvaluator,
    headerMissingEvaluator,
    hostUnreachableEvaluator,
    scoreDegradationEvaluator,
    newSubdomainEvaluator,
    whoisExpiryEvaluator,
    ctNewEntryEvaluator,
  ],
  jobHandlers: [scanHandler, probeHandler, scheduleLoaderHandler, scanAggregateHandler],
  eventTypes,
  templates,
};
