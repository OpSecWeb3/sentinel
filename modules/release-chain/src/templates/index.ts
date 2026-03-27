import type { DetectionTemplate } from '@sentinel/shared/module';

export const templates: DetectionTemplate[] = [
  // ── Docker ──────────────────────────────────────────────────────────
  {
    slug: 'release-chain-docker-monitor',
    name: 'Docker Image Monitor',
    description:
      'Alert when a Docker image tag changes digest, a new tag appears, or a tag is removed. Baseline visibility into container image changes.',
    category: 'container-security',
    severity: 'medium',
    rules: [
      {
        ruleType: 'release-chain.digest_change',
        config: {
          artifactType: 'docker_image',
          tagPatterns: ['*'],
          changeTypes: ['digest_change', 'new_tag', 'tag_removed'],
        },
        action: 'alert',
      },
    ],
  },

  // ── Attribution ─────────────────────────────────────────────────────
  {
    slug: 'release-chain-require-ci-attribution',
    name: 'Require CI Attribution',
    description:
      'Alert when a release artifact changes without verified CI attribution. Detects manual pushes and untracked changes that bypass your CI/CD pipeline.',
    category: 'supply-chain',
    severity: 'high',
    rules: [
      {
        ruleType: 'release-chain.attribution',
        config: {
          artifactType: 'docker_image',
          tagPatterns: ['*'],
          changeTypes: ['digest_change'],
          attributionCondition: 'must_match',
          workflows: [],
          actors: [],
          branches: [],
        },
        action: 'alert',
      },
      {
        ruleType: 'release-chain.attribution',
        config: {
          artifactType: 'npm_package',
          tagPatterns: ['*'],
          changeTypes: ['version_published'],
          attributionCondition: 'must_match',
          workflows: [],
          actors: [],
          branches: [],
        },
        action: 'alert',
      },
    ],
  },

  // ── Signatures ──────────────────────────────────────────────────────
  {
    slug: 'release-chain-enforce-signatures',
    name: 'Enforce Signatures',
    description:
      'Alert when a Docker image lacks a cosign signature. Unsigned images may indicate a compromised build pipeline or a manual push that bypassed signing.',
    category: 'supply-chain',
    severity: 'critical',
    rules: [
      {
        ruleType: 'release-chain.security_policy',
        config: {
          artifactType: 'docker_image',
          tagPatterns: ['*'],
          changeTypes: ['digest_change', 'new_tag'],
          requireSignature: true,
        },
        action: 'alert',
      },
    ],
  },

  // ── Provenance ──────────────────────────────────────────────────────
  {
    slug: 'release-chain-enforce-provenance',
    name: 'Enforce Provenance',
    description:
      'Alert when a release artifact lacks a SLSA provenance attestation. Provenance cryptographically proves which source repository and build system produced the artifact.',
    category: 'supply-chain',
    severity: 'critical',
    rules: [
      {
        ruleType: 'release-chain.security_policy',
        config: {
          artifactType: 'docker_image',
          tagPatterns: ['*'],
          changeTypes: ['digest_change', 'new_tag'],
          requireProvenance: true,
          sourceRepo: '',
        },
        action: 'alert',
      },
      {
        ruleType: 'release-chain.security_policy',
        config: {
          artifactType: 'npm_package',
          tagPatterns: ['*'],
          changeTypes: ['version_published'],
          requireProvenance: true,
          sourceRepo: '',
        },
        action: 'alert',
      },
    ],
  },

  // ── npm ─────────────────────────────────────────────────────────────
  {
    slug: 'release-chain-npm-monitor',
    name: 'npm Package Monitor',
    description:
      'Alert on npm version changes, install script additions, major version jumps, and maintainer changes. Comprehensive visibility into npm package mutations.',
    category: 'package-security',
    severity: 'high',
    rules: [
      {
        ruleType: 'release-chain.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['version_published'],
          checkInstallScripts: true,
          checkMajorVersionJump: true,
        },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'release-chain.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['maintainer_changed'],
        },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'release-chain.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['version_deprecated'],
        },
        action: 'alert',
        priority: 20,
      },
    ],
  },

  // ── Comprehensive ───────────────────────────────────────────────────
  {
    slug: 'release-chain-full-security',
    name: 'Full Release Chain Security',
    description:
      'Enable all release chain security monitors in one detection. Covers Docker digest/tag changes, npm version and maintainer changes, signature and provenance enforcement, CI attribution checks, and anomaly detection.',
    category: 'comprehensive',
    severity: 'critical',
    rules: [
      // Docker baseline monitoring
      {
        ruleType: 'release-chain.digest_change',
        config: {
          artifactType: 'docker_image',
          tagPatterns: ['*'],
          changeTypes: ['digest_change', 'new_tag', 'tag_removed'],
        },
        action: 'alert',
        priority: 50,
      },
      // Signature enforcement
      {
        ruleType: 'release-chain.security_policy',
        config: {
          artifactType: 'docker_image',
          tagPatterns: ['*'],
          changeTypes: ['digest_change', 'new_tag'],
          requireSignature: true,
          requireProvenance: true,
          sourceRepo: '',
        },
        action: 'alert',
        priority: 10,
      },
      // Docker CI attribution
      {
        ruleType: 'release-chain.attribution',
        config: {
          artifactType: 'docker_image',
          tagPatterns: ['*'],
          changeTypes: ['digest_change'],
          attributionCondition: 'must_match',
          workflows: [],
          actors: [],
          branches: [],
        },
        action: 'alert',
        priority: 20,
      },
      // npm version checks (install scripts, major jumps)
      {
        ruleType: 'release-chain.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['version_published'],
          checkInstallScripts: true,
          checkMajorVersionJump: true,
        },
        action: 'alert',
        priority: 10,
      },
      // npm maintainer changes
      {
        ruleType: 'release-chain.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['maintainer_changed'],
        },
        action: 'alert',
        priority: 10,
      },
      // npm provenance enforcement
      {
        ruleType: 'release-chain.security_policy',
        config: {
          artifactType: 'npm_package',
          tagPatterns: ['*'],
          changeTypes: ['version_published'],
          requireProvenance: true,
          sourceRepo: '',
        },
        action: 'alert',
        priority: 15,
      },
      // npm CI attribution
      {
        ruleType: 'release-chain.attribution',
        config: {
          artifactType: 'npm_package',
          tagPatterns: ['*'],
          changeTypes: ['version_published'],
          attributionCondition: 'must_match',
          workflows: [],
          actors: [],
          branches: [],
        },
        action: 'alert',
        priority: 20,
      },
      // Anomaly detection (rapid churn, off-hours)
      {
        ruleType: 'release-chain.anomaly_detection',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['digest_change', 'new_tag', 'version_published'],
          maxChanges: 5,
          windowMinutes: 60,
        },
        action: 'alert',
        priority: 30,
      },
    ],
  },

  // ── Manual Push Detection ─────────────────────────────────────────
  {
    slug: 'rc-detect-manual-push',
    name: 'Detect Manual Push',
    description:
      'Alert when an image is pushed by a user not on the approved pusher allowlist. Catches manual pushes that bypass CI/CD.',
    category: 'supply-chain',
    severity: 'high',
    rules: [
      {
        ruleType: 'release-chain.anomaly_detection',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['digest_change', 'new_tag'],
          pusherAllowlist: ['{{allowedPusher}}'],
        },
        action: 'alert',
      },
    ],
  },

  // ── Digest Pinning ────────────────────────────────────────────────
  {
    slug: 'rc-pin-digest',
    name: 'Pin Digest',
    description:
      'Alert when a Docker image digest changes from a pinned (expected) value. Detects image replacement or tag mutation attacks.',
    category: 'supply-chain',
    severity: 'critical',
    rules: [
      {
        ruleType: 'release-chain.security_policy',
        config: {
          artifactType: 'docker_image',
          tagPatterns: ['{{tag}}'],
          changeTypes: ['digest_change'],
          pinnedDigest: '{{expectedDigest}}',
        },
        action: 'alert',
      },
    ],
  },

  // ── Suspicious Activity ───────────────────────────────────────────
  {
    slug: 'rc-suspicious-activity',
    name: 'Suspicious Activity',
    description:
      'Alert on suspicious release patterns — rapid changes or off-hours activity. Configurable rate limit and time window.',
    category: 'supply-chain',
    severity: 'high',
    rules: [
      {
        ruleType: 'release-chain.anomaly_detection',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['digest_change', 'new_tag', 'version_published'],
          maxChanges: 5,
          windowMinutes: 60,
          allowedHoursStart: '{{startHour}}',
          allowedHoursEnd: '{{endHour}}',
          timezone: '{{timezone}}',
          allowedDays: [1, 2, 3, 4, 5],
        },
        action: 'alert',
      },
    ],
  },

  // ── Source Mismatch Detection ─────────────────────────────────────
  {
    slug: 'rc-detect-source-mismatch',
    name: 'Detect Source Mismatch',
    description:
      'Alert when an artifact change is detected by polling but was not preceded by a webhook notification. May indicate a direct registry push bypassing your CI pipeline.',
    category: 'supply-chain',
    severity: 'high',
    rules: [
      {
        ruleType: 'release-chain.anomaly_detection',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['digest_change', 'new_tag'],
          expectedSource: 'webhook',
        },
        action: 'alert',
      },
    ],
  },

  // ── Log All Releases ──────────────────────────────────────────────
  {
    slug: 'rc-log-releases',
    name: 'Log Releases',
    description:
      'Log all release artifact changes without alerting. Useful for audit trails and historical tracking of all Docker and npm changes.',
    category: 'supply-chain',
    severity: 'low',
    rules: [
      {
        ruleType: 'release-chain.digest_change',
        config: {
          tagPatterns: ['*'],
          changeTypes: [
            'digest_change',
            'new_tag',
            'tag_removed',
            'version_published',
            'version_unpublished',
          ],
        },
        action: 'log',
      },
    ],
  },

  // ── npm Log Releases ──────────────────────────────────────────────
  {
    slug: 'rc-npm-log-releases',
    name: 'npm Log Releases',
    description:
      'Log all npm package version changes without alerting. Provides a complete audit trail of npm publish and unpublish events.',
    category: 'package-security',
    severity: 'low',
    rules: [
      {
        ruleType: 'release-chain.digest_change',
        config: {
          artifactType: 'npm_package',
          tagPatterns: ['*'],
          changeTypes: [
            'version_published',
            'version_unpublished',
            'version_deprecated',
          ],
        },
        action: 'log',
      },
    ],
  },

  // ── npm Tag Audit ─────────────────────────────────────────────────
  {
    slug: 'rc-npm-tag-audit',
    name: 'npm Tag Audit',
    description:
      'Log npm dist-tag changes that match specific patterns. Useful for auditing tag movements on release channels like latest, next, and canary.',
    category: 'package-security',
    severity: 'medium',
    rules: [
      {
        ruleType: 'release-chain.anomaly_detection',
        config: {
          tagPatterns: ['latest', 'next', 'canary'],
          changeTypes: ['digest_change'],
        },
        action: 'log',
      },
    ],
  },

  // ── npm Unpublish Alert ───────────────────────────────────────────
  {
    slug: 'rc-npm-unpublish-alert',
    name: 'npm Unpublish Alert',
    description:
      'Alert when an npm package version is unpublished. Unpublishing can break downstream consumers and may indicate a supply chain attack or accidental removal.',
    category: 'package-security',
    severity: 'critical',
    rules: [
      {
        ruleType: 'release-chain.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['version_unpublished'],
        },
        action: 'alert',
      },
    ],
  },

  // ── npm Rapid Publish ─────────────────────────────────────────────
  {
    slug: 'rc-npm-rapid-publish',
    name: 'npm Rapid Publish',
    description:
      'Alert when npm versions are published faster than expected. Rapid successive publishes may indicate a compromised automation pipeline or accidental release.',
    category: 'package-security',
    severity: 'high',
    rules: [
      {
        ruleType: 'release-chain.anomaly_detection',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['version_published'],
          maxChanges: 3,
          windowMinutes: 30,
        },
        action: 'alert',
      },
    ],
  },

  // ── npm Off-Hours Publish ─────────────────────────────────────────
  {
    slug: 'rc-npm-off-hours',
    name: 'npm Off-Hours Publish',
    description:
      'Alert when npm packages are published outside of business hours. Off-hours publishes may indicate unauthorized access or compromised credentials.',
    category: 'package-security',
    severity: 'high',
    rules: [
      {
        ruleType: 'release-chain.anomaly_detection',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['version_published'],
          allowedHoursStart: '09:00',
          allowedHoursEnd: '18:00',
          timezone: 'UTC',
          allowedDays: [1, 2, 3, 4, 5],
        },
        action: 'alert',
      },
    ],
  },

  // ── npm Tag Pin Digest ────────────────────────────────────────────
  {
    slug: 'rc-npm-tag-pin-digest',
    name: 'npm Tag Pin Digest',
    description:
      'Alert when an npm package tarball digest changes from a pinned value. Detects unexpected package content mutations that could indicate a supply chain compromise.',
    category: 'package-security',
    severity: 'critical',
    rules: [
      {
        ruleType: 'release-chain.security_policy',
        config: {
          artifactType: 'npm_package',
          tagPatterns: ['{{tag}}'],
          changeTypes: ['version_published'],
          pinnedDigest: '{{expectedDigest}}',
        },
        action: 'alert',
      },
    ],
  },

  // ── npm Tag Removed ───────────────────────────────────────────────
  {
    slug: 'rc-npm-tag-removed',
    name: 'npm Tag Removed',
    description:
      'Alert when an npm dist-tag is removed. Tag removal can indicate package takeover attempts or breaking changes to release channels.',
    category: 'package-security',
    severity: 'high',
    rules: [
      {
        ruleType: 'release-chain.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['dist_tag_removed'],
        },
        action: 'alert',
      },
    ],
  },
];
