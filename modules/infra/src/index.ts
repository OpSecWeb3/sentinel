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
  retentionPolicies: [
    // Reachability probes fire every few minutes per host — highest volume.
    { table: 'infra_reachability_checks', timestampColumn: 'checked_at', retentionDays: 30 },
    // Infrastructure snapshots: one per scan per host (IP, geo, ports).
    { table: 'infra_snapshots', timestampColumn: 'created_at', retentionDays: 90 },
    // Per-step scan results: tied to scan events, moderate volume.
    { table: 'infra_scan_step_results', timestampColumn: 'created_at', retentionDays: 90 },
    // Score history: useful for long-term trend analysis.
    { table: 'infra_score_history', timestampColumn: 'recorded_at', retentionDays: 180 },
  ],
};
