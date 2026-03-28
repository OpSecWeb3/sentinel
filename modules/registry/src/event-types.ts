import type { EventTypeDefinition } from '@sentinel/shared/module';

export const eventTypes: EventTypeDefinition[] = [
  // ── Docker ──────────────────────────────────────────────────────────
  {
    type: 'registry.docker.digest_change',
    label: 'Docker image digest changed',
    description: 'A monitored Docker tag now points to a different image digest',
  },
  {
    type: 'registry.docker.new_tag',
    label: 'Docker tag added',
    description: 'A new tag appeared on a monitored Docker image repository',
  },
  {
    type: 'registry.docker.tag_removed',
    label: 'Docker tag removed',
    description: 'A tag was removed from a monitored Docker image repository',
  },

  // ── npm ─────────────────────────────────────────────────────────────
  {
    type: 'registry.npm.version_published',
    label: 'npm version published',
    description: 'A new version was published to a monitored npm package',
  },
  {
    type: 'registry.npm.version_deprecated',
    label: 'npm version deprecated',
    description: 'A version of a monitored npm package was deprecated',
  },
  {
    type: 'registry.npm.version_unpublished',
    label: 'npm version unpublished',
    description: 'A previously published npm version was unpublished (removed from the registry)',
  },
  {
    type: 'registry.npm.maintainer_changed',
    label: 'npm maintainer changed',
    description: 'Maintainers were added or removed from a monitored npm package',
  },
  {
    type: 'registry.npm.dist_tag_updated',
    label: 'npm dist-tag updated',
    description: 'A dist-tag (e.g. "latest") now points to a different version',
  },
  {
    type: 'registry.npm.new_tag',
    label: 'npm dist-tag added',
    description: 'A new dist-tag appeared on a monitored npm package',
  },
  {
    type: 'registry.npm.tag_removed',
    label: 'npm dist-tag removed',
    description: 'A dist-tag was removed from a monitored npm package',
  },

  // ── Verification ────────────────────────────────────────────────────
  {
    type: 'registry.verification.signature_missing',
    label: 'Cosign signature missing',
    description: 'A release artifact does not have a cosign signature',
  },
  {
    type: 'registry.verification.provenance_missing',
    label: 'SLSA provenance missing',
    description: 'A release artifact does not have a SLSA provenance attestation',
  },
  {
    type: 'registry.verification.signature_invalid',
    label: 'Cosign signature invalid',
    description: 'A release artifact has a cosign signature that failed verification',
  },
  {
    type: 'registry.verification.provenance_invalid',
    label: 'SLSA provenance invalid',
    description: 'A release artifact has a SLSA provenance attestation that failed verification',
  },

  // ── Attribution ─────────────────────────────────────────────────────
  {
    type: 'registry.attribution.unattributed_change',
    label: 'Unattributed change',
    description: 'A release artifact changed without any CI attribution metadata',
  },
  {
    type: 'registry.attribution.attribution_mismatch',
    label: 'Attribution mismatch',
    description: 'A release artifact has CI attribution that does not match the expected workflow, actor, or branch',
  },
];
