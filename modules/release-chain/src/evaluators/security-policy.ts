import { z } from 'zod';
import { minimatch } from 'minimatch';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  /** Glob patterns for tags/versions to check. */
  tagPatterns: z.array(z.string()).default(['*']),
  /** Change types to check. */
  changeTypes: z
    .array(z.enum(['digest_change', 'new_tag', 'new_version']))
    .default(['digest_change', 'new_tag']),
  /** Require a cosign / Sigstore cryptographic signature. */
  requireSignature: z.boolean().default(false),
  /** Require SLSA provenance attestation. */
  requireProvenance: z.boolean().default(false),
  /**
   * When provenance is required, optionally enforce that the provenance
   * source repository matches this value (case-insensitive substring).
   */
  provenanceSourceRepo: z.string().nullable().default(null),
  /**
   * Pin a tag to an exact digest. If the tag moves away from this digest
   * the rule fires. Useful for immutable production tags.
   */
  pinnedDigest: z.string().nullable().default(null),
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

interface SecurityPayload {
  artifact: string;
  tag: string;
  newDigest: string | null;
  verification?: {
    signature?: {
      hasSignature: boolean;
    };
    provenance?: {
      hasProvenance: boolean;
      provenanceSourceRepo?: string;
    };
    rekor?: {
      hasRekorEntry: boolean;
    };
  };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export const securityPolicyEvaluator: RuleEvaluator = {
  moduleId: 'release-chain',
  ruleType: 'release-chain.security_policy',
  configSchema,

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;
    if (!HANDLED_EVENT_TYPES.has(event.eventType)) return null;

    const config = configSchema.parse(rule.config);
    const payload = event.payload as unknown as SecurityPayload;
    const changeType = stripModulePrefix(event.eventType);

    // Must be a change type we care about
    if (!config.changeTypes.includes(changeType as (typeof config.changeTypes)[number])) {
      return null;
    }

    // Must match at least one tag pattern
    if (!config.tagPatterns.some((p) => minimatch(payload.tag, p))) {
      return null;
    }

    // ── Pinned digest check ──────────────────────────────────────────────
    if (config.pinnedDigest && payload.newDigest) {
      if (payload.newDigest !== config.pinnedDigest) {
        return {
          orgId: event.orgId,
          detectionId: rule.detectionId,
          ruleId: rule.id,
          eventId: event.id,
          severity: 'critical',
          title: `Pinned digest violation for ${payload.artifact}:${payload.tag}`,
          description: `Digest "${payload.newDigest.slice(0, 24)}" does not match pinned "${config.pinnedDigest.slice(0, 24)}"`,
          triggerType: 'immediate',
          triggerData: event.payload,
        };
      }
    }

    // ── Signature check ──────────────────────────────────────────────────
    if (config.requireSignature) {
      const hasSignature = payload.verification?.signature?.hasSignature === true;
      if (!hasSignature) {
        return {
          orgId: event.orgId,
          detectionId: rule.detectionId,
          ruleId: rule.id,
          eventId: event.id,
          severity: 'high',
          title: `Missing signature on ${payload.artifact}:${payload.tag}`,
          description: `Version "${payload.tag}" has no cryptographic signature (cosign/Sigstore). Unsigned artifacts may indicate a compromised build pipeline or manual push.`,
          triggerType: 'immediate',
          triggerData: event.payload,
        };
      }
    }

    // ── Provenance check ─────────────────────────────────────────────────
    if (config.requireProvenance) {
      const provenance = payload.verification?.provenance;
      const hasProvenance = provenance?.hasProvenance === true;

      if (!hasProvenance) {
        return {
          orgId: event.orgId,
          detectionId: rule.detectionId,
          ruleId: rule.id,
          eventId: event.id,
          severity: 'high',
          title: `Missing SLSA provenance on ${payload.artifact}:${payload.tag}`,
          description: `Version "${payload.tag}" has no SLSA provenance attestation. Provenance cryptographically proves which source and build system produced the artifact.`,
          triggerType: 'immediate',
          triggerData: event.payload,
        };
      }

      // If provenance exists but source repo doesn't match
      if (config.provenanceSourceRepo && provenance?.provenanceSourceRepo) {
        const expected = config.provenanceSourceRepo.toLowerCase();
        const actual = provenance.provenanceSourceRepo.toLowerCase();
        if (!actual.includes(expected)) {
          return {
            orgId: event.orgId,
            detectionId: rule.detectionId,
            ruleId: rule.id,
            eventId: event.id,
            severity: 'high',
            title: `Provenance source mismatch on ${payload.artifact}:${payload.tag}`,
            description: `Provenance source repo "${provenance.provenanceSourceRepo}" does not match expected "${config.provenanceSourceRepo}"`,
            triggerType: 'immediate',
            triggerData: event.payload,
          };
        }
      }
    }

    // All security checks passed
    return null;
  },
};
