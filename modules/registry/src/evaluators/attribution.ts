import { z } from 'zod';
import { minimatch } from 'minimatch';
import path from 'node:path';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Glob patterns for tags/versions to check. */
  tagPatterns: z.array(z.string()).default(['*']),
  /** Change types to gate on attribution. */
  changeTypes: z
    .array(z.enum(['digest_change', 'new_tag', 'new_version', 'dist_tag_updated', 'tag_removed']))
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
  'registry.docker.digest_change',
  'registry.docker.new_tag',
  'registry.npm.version_published',
  'registry.npm.new_tag',
  'registry.npm.tag_removed',
  'registry.npm.dist_tag_updated',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strips the module prefix and registry sub-namespace from event types.
 * e.g. 'registry.docker.digest_change' -> 'digest_change'
 *      'registry.npm.version_published' -> 'version_published'
 */
function stripModulePrefix(eventType: string): string {
  return eventType.replace(/^registry\.(?:docker|npm|verification|attribution)\./, '');
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
  moduleId: 'registry',
  ruleType: 'registry.attribution',
  configSchema,
  uiSchema: [
    { key: 'tagPatterns', label: 'Tag patterns to watch', type: 'string-array', required: false, placeholder: '*', help: 'Artifact tags to check for CI attribution.' },
    { key: 'changeTypes', label: 'Change types to check', type: 'string-array', required: false, placeholder: 'digest_change\nnew_tag\nnew_version' },
    { key: 'attributionCondition', label: 'Attribution rule', type: 'select', required: false, options: [{ value: 'must_match', label: 'Must have valid CI attribution' }, { value: 'must_not_match', label: 'Must NOT have CI attribution' }] },
    { key: 'workflows', label: 'Allowed CI workflows', type: 'string-array', required: false, placeholder: 'build.yml\ndeploy.yml', help: 'Workflow filenames that are allowed to produce this artifact.' },
    { key: 'actors', label: 'Allowed actors', type: 'string-array', required: false, placeholder: 'github-actions[bot]', help: 'GitHub usernames permitted to push.' },
    { key: 'branches', label: 'Allowed source branches', type: 'string-array', required: false, placeholder: 'main\nrelease/*' },
  ] as TemplateInput[],

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
    //
    // `attribution.workflow` is the full path supplied by GitHub Actions, e.g.
    // ".github/workflows/deploy.yml".  The allowlist stores bare filenames
    // (e.g. "deploy.yml").  We extract the basename before comparing so that
    // a workflow named "evil-deploy.yml" cannot bypass a "deploy.yml" entry
    // (which the previous `endsWith` check permitted).
    const workflowBasename =
      attribution?.workflow != null ? path.basename(attribution.workflow) : null;
    const workflowOk =
      config.workflows.length === 0 ||
      (workflowBasename != null && config.workflows.includes(workflowBasename));

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
