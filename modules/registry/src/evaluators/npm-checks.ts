import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';
import type { TemplateInput } from '@sentinel/shared/module';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Glob patterns for versions/dist-tags to check. */
  tagPatterns: z.array(z.string()).default(['*']),
  /** Change types to check. */
  changeTypes: z
    .array(z.enum(['digest_change', 'new_tag', 'tag_removed', 'version_published', 'dist_tag_updated', 'maintainer_changed']))
    .default(['version_published']),
  /**
   * Alert when a version contains preinstall, install, or postinstall scripts.
   * These are a common supply chain attack vector in npm packages.
   */
  checkInstallScripts: z.boolean().default(false),
  /**
   * Alert when a new version represents a major semver increment.
   * Unexpected major bumps can indicate breaking changes or package takeover.
   */
  checkMajorVersionJump: z.boolean().default(false),
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

interface NpmPayload {
  artifact: string;
  tag: string;
  newDigest: string | null;
  metadata?: {
    hasInstallScripts?: boolean;
    installScripts?: string[];
    isMajorVersionJump?: boolean;
    previousVersion?: string;
  };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const npmChecksEvaluator: RuleEvaluator = {
  moduleId: 'registry',
  ruleType: 'registry.npm_checks',
  configSchema,
  uiSchema: [
    { key: 'tagPatterns', label: 'Tag / dist-tag patterns', type: 'string-array', required: false, placeholder: '*\nlatest\nnext' },
    { key: 'changeTypes', label: 'Change types to check', type: 'string-array', required: false, placeholder: 'new_version\ndigest_change' },
    { key: 'checkInstallScripts', label: 'Alert on install scripts', type: 'boolean', required: false, default: false, help: 'Alert when the package has preinstall / postinstall scripts.' },
    { key: 'checkMajorVersionJump', label: 'Alert on major version jump', type: 'boolean', required: false, default: false, help: 'Alert when a new version jumps more than one major version.' },
  ] as TemplateInput[],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (!HANDLED_EVENT_TYPES.has(event.eventType)) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as unknown as NpmPayload;
    const changeType = stripModulePrefix(event.eventType);

    // Must be a change type we care about
    if (!config.changeTypes.includes(changeType as (typeof config.changeTypes)[number])) {
      return null;
    }

    // Must match at least one tag pattern
    if (!config.tagPatterns.some((p) => minimatch(payload.tag, p))) {
      return null;
    }

    const meta = payload.metadata;

    // ── Install scripts detection ────────────────────────────────────────
    if (config.checkInstallScripts && meta?.hasInstallScripts) {
      const scripts = meta.installScripts ?? [];
      return {
        orgId: event.orgId,
        detectionId: rule.detectionId,
        ruleId: rule.id,
        eventId: event.id,
        severity: 'critical',
        title: `Install scripts detected in ${payload.artifact}@${payload.tag}`,
        description: `Version "${payload.tag}" contains lifecycle scripts that run on install: ${scripts.length > 0 ? scripts.join(', ') : 'preinstall/install/postinstall'}. This is a common supply chain attack vector.`,
        triggerType: 'immediate',
        triggerData: event.payload,
      };
    }

    // ── Major version jump detection ─────────────────────────────────────
    if (config.checkMajorVersionJump && meta?.isMajorVersionJump) {
      const prev = meta.previousVersion ?? 'unknown';
      return {
        orgId: event.orgId,
        detectionId: rule.detectionId,
        ruleId: rule.id,
        eventId: event.id,
        severity: 'high',
        title: `Major version jump on ${payload.artifact}: ${prev} -> ${payload.tag}`,
        description: `Unexpected major semver increment from ${prev} to ${payload.tag}. This may indicate breaking changes or package takeover.`,
        triggerType: 'immediate',
        triggerData: event.payload,
      };
    }

    // Neither npm-specific check triggered
    return null;
  },
};
