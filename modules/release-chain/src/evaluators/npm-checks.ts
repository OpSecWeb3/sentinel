import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Glob patterns for versions/dist-tags to check. */
  tagPatterns: z.array(z.string()).default(['*']),
  /** Change types to check. */
  changeTypes: z
    .array(z.enum(['digest_change', 'new_tag', 'new_version']))
    .default(['new_version']),
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
  moduleId: 'release-chain',
  ruleType: 'release-chain.npm_checks',
  configSchema,

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
