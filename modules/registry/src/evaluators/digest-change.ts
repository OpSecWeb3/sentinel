import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Glob patterns for tags/versions to monitor. */
  tagPatterns: z.array(z.string()).default(['*']),
  /** Which change types trigger this rule. */
  changeTypes: z
    .array(
      z.enum([
        'digest_change',
        'new_tag',
        'tag_removed',
        'new_version',
        'version_unpublished',
        'maintainer_changed',
        'dist_tag_updated',
        'version_published',
      ]),
    )
    .default(['digest_change', 'new_tag', 'tag_removed']),
  /**
   * Optional: alert only when a new tag does NOT match this pattern.
   * Useful for catching unexpected tag names (e.g. "yolo" when only "v*" is expected).
   */
  expectedTagPattern: z.string().nullable().default(null),
});

// ---------------------------------------------------------------------------
// Event types this evaluator handles
// ---------------------------------------------------------------------------

const HANDLED_EVENT_TYPES = new Set([
  'registry.docker.digest_change',
  'registry.docker.new_tag',
  'registry.docker.tag_removed',
  'registry.npm.version_published',
  'registry.npm.version_unpublished',
  'registry.npm.maintainer_changed',
  'registry.npm.new_tag',
  'registry.npm.tag_removed',
  'registry.npm.dist_tag_updated',
]);

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

interface DigestChangePayload {
  artifact: string;
  tag: string;
  eventType: string;
  oldDigest: string | null;
  newDigest: string | null;
  source: string;
  pusher: string | null;
  maintainers?: { added: string[]; removed: string[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesTagPatterns(tag: string, patterns: string[]): boolean {
  return patterns.some((p) => minimatch(tag, p));
}

/**
 * Strips the module prefix and registry sub-namespace from event types.
 * e.g. 'registry.docker.digest_change' -> 'digest_change'
 *      'registry.npm.version_published' -> 'version_published'
 */
function stripModulePrefix(eventType: string): string {
  return eventType.replace(/^registry\.(?:docker|npm|verification|attribution)\./, '');
}

function severityForChangeType(changeType: string): string {
  switch (changeType) {
    case 'tag_removed':
    case 'version_unpublished':
    case 'maintainer_changed':
      return 'high';
    case 'digest_change':
      return 'medium';
    case 'new_tag':
    case 'new_version':
      return 'low';
    default:
      return 'medium';
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const digestChangeEvaluator: RuleEvaluator = {
  moduleId: 'registry',
  ruleType: 'registry.digest_change',
  configSchema,
  uiSchema: [
    { key: 'tagPatterns', label: 'Tag patterns to watch', type: 'string-array', required: false, placeholder: '*\nv*\nlatest', help: 'Glob patterns for artifact tags. Defaults to all tags.' },
    { key: 'changeTypes', label: 'Change types to alert on', type: 'string-array', required: false, placeholder: 'digest_change\nnew_tag\ntag_removed\nnew_version\nversion_unpublished', help: 'Leave empty for all change types.' },
    { key: 'expectedTagPattern', label: 'Expected tag pattern', type: 'text', required: false, placeholder: 'v[0-9]*.[0-9]*.[0-9]*', help: 'Alert if a new tag does not match this pattern.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (!HANDLED_EVENT_TYPES.has(event.eventType)) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as unknown as DigestChangePayload;
    const changeType = stripModulePrefix(event.eventType);

    // Must be a change type we care about
    if (!config.changeTypes.includes(changeType as (typeof config.changeTypes)[number])) {
      return null;
    }

    // Must match at least one tag pattern
    if (!matchesTagPatterns(payload.tag, config.tagPatterns)) {
      return null;
    }

    // Optional: expected tag pattern (alert if tag does NOT match)
    if (config.expectedTagPattern && changeType === 'new_tag') {
      if (minimatch(payload.tag, config.expectedTagPattern)) {
        // Tag matches expectations -- nothing to alert on
        return null;
      }
      return {
        orgId: event.orgId,
        detectionId: rule.detectionId,
        ruleId: rule.id,
        eventId: event.id,
        severity: 'medium',
        title: `Unexpected tag "${payload.tag}" on ${payload.artifact}`,
        description: `Tag "${payload.tag}" does not match expected pattern "${config.expectedTagPattern}"`,
        triggerType: 'immediate',
        triggerData: event.payload,
      };
    }

    // Build alert based on change type
    const { title, description } = buildMessage(changeType, payload);

    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: severityForChangeType(changeType),
      title,
      description,
      triggerType: 'immediate',
      triggerData: event.payload,
    };
  },
};

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

function buildMessage(
  changeType: string,
  payload: DigestChangePayload,
): { title: string; description: string } {
  const artifact = payload.artifact;
  const tag = payload.tag;

  switch (changeType) {
    case 'digest_change': {
      const short = (d: string | null) => (d ? d.slice(0, 16) : 'unknown');
      return {
        title: `Digest changed for ${artifact}:${tag}`,
        description: `Tag ${tag} now points to ${short(payload.newDigest)} (was ${short(payload.oldDigest)})`,
      };
    }
    case 'new_tag':
    case 'new_version':
      return {
        title: `New ${changeType === 'new_version' ? 'version' : 'tag'} ${tag} on ${artifact}`,
        description: `${changeType === 'new_version' ? 'Version' : 'Tag'} ${tag} appeared with digest ${payload.newDigest?.slice(0, 16) ?? 'unknown'}`,
      };
    case 'tag_removed':
    case 'version_unpublished':
      return {
        title: `${changeType === 'version_unpublished' ? 'Version' : 'Tag'} ${tag} removed from ${artifact}`,
        description: `${changeType === 'version_unpublished' ? 'Version' : 'Tag'} ${tag} was removed (last digest: ${payload.oldDigest?.slice(0, 16) ?? 'unknown'})`,
      };
    case 'maintainer_changed': {
      const added = payload.maintainers?.added ?? [];
      const removed = payload.maintainers?.removed ?? [];
      const parts: string[] = [];
      if (added.length > 0) parts.push(`added: ${added.join(', ')}`);
      if (removed.length > 0) parts.push(`removed: ${removed.join(', ')}`);
      return {
        title: `Maintainer change on ${artifact}`,
        description: `Maintainers changed (${parts.join('; ')})`,
      };
    }
    default:
      return {
        title: `Release chain event on ${artifact}:${tag}`,
        description: `Event type: ${changeType}`,
      };
  }
}
