import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Glob patterns for tags/versions to check. */
  tagPatterns: z.array(z.string()).default(['*']),
  /** Change types to gate on attribution. */
  changeTypes: z
    .array(z.enum(['digest_change', 'new_tag', 'new_version']))
    .default(['digest_change']),
  /**
   * 'must_match'     -- alert if attribution does NOT match the allowed set.
   * 'must_not_match' -- alert if attribution DOES match (detects specific CI pushing when it shouldn't).
   */
  attributionCondition: z.enum(['must_match', 'must_not_match']),
  /** Allowed CI workflow file names (e.g. ["deploy.yml", "release.yml"]). */
  workflows: z.array(z.string()).default([]),
  /** Allowed actor logins (e.g. ["deploy-bot", "github-actions[bot]"]). */
  actors: z.array(z.string()).default([]),
  /** Allowed branch names / globs (e.g. ["main", "release/*"]). */
  branches: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Event types this evaluator handles
// ---------------------------------------------------------------------------

const HANDLED_EVENT_TYPES = new Set([
  'release-chain.docker.digest_change',
  'release-chain.docker.new_tag',
  'release-chain.npm.version_published',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strips the module prefix and registry sub-namespace from event types.
 * e.g. 'release-chain.docker.digest_change' -> 'digest_change'
 *      'release-chain.npm.version_published' -> 'version_published'
 */
function stripModulePrefix(eventType: string): string {
  return eventType.replace(/^release-chain\.(?:docker|npm|verification|attribution)\./, '');
}

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

interface AttributionPayload {
  artifact: string;
  tag: string;
  eventType: string;
  newDigest: string | null;
  source: string;
  attribution: {
    status: 'verified' | 'inferred' | 'pending' | 'unattributed' | null;
    workflow: string | null;
    actor: string | null;
    branch: string | null;
    runId: number | null;
    commit: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const attributionEvaluator: RuleEvaluator = {
  moduleId: 'release-chain',
  ruleType: 'release-chain.attribution',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (!HANDLED_EVENT_TYPES.has(event.eventType)) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as unknown as AttributionPayload;
    const changeType = stripModulePrefix(event.eventType);

    // Must be a change type we care about
    if (!config.changeTypes.includes(changeType as (typeof config.changeTypes)[number])) {
      return null;
    }

    // Must match at least one tag pattern
    if (!config.tagPatterns.some((p) => minimatch(payload.tag, p))) {
      return null;
    }

    const attribution = payload.attribution;
    const isAttributed =
      attribution?.status === 'verified' || attribution?.status === 'inferred';

    // Check each dimension: workflow, actor, branch
    const workflowOk =
      config.workflows.length === 0 ||
      config.workflows.some(
        (w) => attribution?.workflow != null && attribution.workflow.endsWith(w),
      );

    const actorOk =
      config.actors.length === 0 ||
      config.actors.includes(attribution?.actor ?? '');

    const branchOk =
      config.branches.length === 0 ||
      config.branches.some((b) =>
        minimatch(attribution?.branch ?? '', b),
      );

    const fullyMatches = isAttributed && workflowOk && actorOk && branchOk;

    // ── must_match: alert when attribution is absent or does not match ──
    if (config.attributionCondition === 'must_match') {
      if (fullyMatches) return null;

      // If attribution is still pending, use deferred trigger so the platform
      // can re-evaluate once CI metadata arrives.
      if (attribution?.status === 'pending') {
        return {
          orgId: event.orgId,
          detectionId: rule.detectionId,
          ruleId: rule.id,
          eventId: event.id,
          severity: 'high',
          title: `Awaiting CI attribution for ${payload.artifact}:${payload.tag}`,
          description: 'Attribution is still pending; will re-evaluate after grace period',
          triggerType: 'deferred',
          triggerData: event.payload,
        };
      }

      const reasons = buildMismatchReasons(isAttributed, workflowOk, actorOk, branchOk, attribution, config);

      return {
        orgId: event.orgId,
        detectionId: rule.detectionId,
        ruleId: rule.id,
        eventId: event.id,
        severity: 'critical',
        title: `Unattributed change to ${payload.artifact}:${payload.tag}`,
        description: `Attribution does not match policy: ${reasons}`,
        triggerType: 'immediate',
        triggerData: event.payload,
      };
    }

    // ── must_not_match: alert when attribution DOES match the criteria ──
    if (config.attributionCondition === 'must_not_match') {
      if (!fullyMatches) return null;

      return {
        orgId: event.orgId,
        detectionId: rule.detectionId,
        ruleId: rule.id,
        eventId: event.id,
        severity: 'high',
        title: `Unexpected CI attribution for ${payload.artifact}:${payload.tag}`,
        description: `Attributed to workflow="${attribution?.workflow}", actor="${attribution?.actor}" which matches blocked criteria`,
        triggerType: 'immediate',
        triggerData: event.payload,
      };
    }

    return null;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMismatchReasons(
  isAttributed: boolean,
  workflowOk: boolean,
  actorOk: boolean,
  branchOk: boolean,
  attribution: AttributionPayload['attribution'],
  config: z.infer<typeof configSchema>,
): string {
  const parts: string[] = [];

  if (!isAttributed) {
    parts.push(`status=${attribution?.status ?? 'unknown'}`);
  }
  if (!workflowOk) {
    parts.push(
      `workflow="${attribution?.workflow ?? ''}" not in [${config.workflows.join(', ')}]`,
    );
  }
  if (!actorOk) {
    parts.push(
      `actor="${attribution?.actor ?? ''}" not in [${config.actors.join(', ')}]`,
    );
  }
  if (!branchOk) {
    parts.push(
      `branch="${attribution?.branch ?? ''}" not in [${config.branches.join(', ')}]`,
    );
  }

  return parts.join('; ');
}
