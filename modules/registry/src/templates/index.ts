import type { DetectionTemplate } from '@sentinel/shared/module';

export const templates: DetectionTemplate[] = [
  // ── Docker ──────────────────────────────────────────────────────────
  {
    slug: 'registry-docker-monitor',
    name: 'Docker Image Monitor',
    description:
      'Alert when a Docker image tag changes digest, a new tag appears, or a tag is removed. Baseline visibility into container image changes.',
    category: 'container-security',
    severity: 'medium',
    rules: [
      {
        ruleType: 'registry.digest_change',
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
    slug: 'registry-require-ci-attribution',
    name: 'Require CI Attribution',
    description:
      'Alert when a release artifact changes without verified CI attribution. Detects manual pushes and untracked changes that bypass your CI/CD pipeline.',
    category: 'supply-chain',
    severity: 'high',
    inputs: [
      {
        key: 'workflows',
        label: 'Allowed CI workflows',
        type: 'string-array',
        required: false,
        placeholder: 'build.yml\ndeploy.yml',
        help: 'Workflow file names that are allowed to push releases, one per line. Leave empty to allow all CI workflows.',
      },
      {
        key: 'actors',
        label: 'Allowed actors',
        type: 'string-array',
        required: false,
        placeholder: 'github-actions[bot]',
        help: 'GitHub usernames allowed to push releases, one per line. Leave empty to allow any CI actor.',
      },
      {
        key: 'branches',
        label: 'Allowed source branches',
        type: 'string-array',
        required: false,
        placeholder: 'main\nrelease/*',
        help: 'Branch patterns releases must originate from, one per line.',
      },
    ],
    rules: [
      {
        ruleType: 'registry.attribution',
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
        ruleType: 'registry.attribution',
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
    slug: 'registry-enforce-signatures',
    name: 'Enforce Signatures',
    description:
      'Alert when a Docker image lacks a cosign signature. Unsigned images may indicate a compromised build pipeline or a manual push that bypassed signing.',
    category: 'supply-chain',
    severity: 'critical',
    rules: [
      {
        ruleType: 'registry.security_policy',
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
    slug: 'registry-enforce-provenance',
    name: 'Enforce Provenance',
    description:
      'Alert when a release artifact lacks a SLSA provenance attestation. Provenance cryptographically proves which source repository and build system produced the artifact.',
    category: 'supply-chain',
    severity: 'critical',
    inputs: [
      {
        key: 'sourceRepo',
        label: 'Expected source repository',
        type: 'text',
        required: false,
        placeholder: 'github.com/org/repo',
        help: 'The repository that must appear in the provenance attestation. Leave empty to accept any repo.',
      },
    ],
    rules: [
      {
        ruleType: 'registry.security_policy',
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
        ruleType: 'registry.security_policy',
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
    slug: 'registry-npm-monitor',
    name: 'npm Package Monitor',
    description:
      'Alert on npm version changes, install script additions, major version jumps, and maintainer changes. Comprehensive visibility into npm package mutations.',
    category: 'package-security',
    severity: 'high',
    rules: [
      {
        ruleType: 'registry.npm_checks',
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
        ruleType: 'registry.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['maintainer_changed'],
        },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'registry.npm_checks',
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
    slug: 'registry-full-security',
    name: 'Full Registry Security',
    description:
      'Enable all registry security monitors in one detection. Covers Docker digest/tag changes, npm version and maintainer changes, signature and provenance enforcement, CI attribution checks, and anomaly detection.',
    category: 'comprehensive',
    severity: 'critical',
    rules: [
      // Docker baseline monitoring
      {
        ruleType: 'registry.digest_change',
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
        ruleType: 'registry.security_policy',
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
        ruleType: 'registry.attribution',
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
        ruleType: 'registry.npm_checks',
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
        ruleType: 'registry.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['maintainer_changed'],
        },
        action: 'alert',
        priority: 10,
      },
      // npm provenance enforcement
      {
        ruleType: 'registry.security_policy',
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
        ruleType: 'registry.attribution',
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
        ruleType: 'registry.anomaly_detection',
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
    inputs: [
      {
        key: 'allowedPusher',
        label: 'Allowed pusher',
        type: 'text',
        required: true,
        placeholder: 'github-actions[bot]',
        help: 'Username allowed to push images. Pushes from any other user will trigger an alert.',
      },
    ],
    rules: [
      {
        ruleType: 'registry.anomaly_detection',
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
    inputs: [
      {
        key: 'tag',
        label: 'Image tag to pin',
        type: 'text',
        required: true,
        placeholder: 'latest',
        help: 'The image tag to monitor (e.g. latest, v1.2.3).',
      },
      {
        key: 'expectedDigest',
        label: 'Expected digest',
        type: 'text',
        required: true,
        placeholder: 'sha256:abc123...',
        help: 'The sha256 digest this tag must always point to.',
      },
    ],
    rules: [
      {
        ruleType: 'registry.security_policy',
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
    inputs: [
      {
        key: 'startHour',
        label: 'Business hours start (0–23)',
        type: 'number',
        required: true,
        default: 9,
        min: 0,
        max: 23,
        help: 'Releases outside this window will trigger an alert.',
      },
      {
        key: 'endHour',
        label: 'Business hours end (0–23)',
        type: 'number',
        required: true,
        default: 18,
        min: 0,
        max: 23,
      },
      {
        key: 'timezone',
        label: 'Timezone',
        type: 'text',
        required: false,
        default: 'UTC',
        placeholder: 'UTC',
        help: 'IANA timezone name (e.g. America/New_York, Europe/London).',
      },
    ],
    rules: [
      {
        ruleType: 'registry.anomaly_detection',
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
        ruleType: 'registry.anomaly_detection',
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
        ruleType: 'registry.digest_change',
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
        ruleType: 'registry.digest_change',
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
        ruleType: 'registry.anomaly_detection',
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
        ruleType: 'registry.npm_checks',
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
        ruleType: 'registry.anomaly_detection',
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
        ruleType: 'registry.anomaly_detection',
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
    inputs: [
      {
        key: 'tag',
        label: 'npm dist-tag to pin',
        type: 'text',
        required: true,
        placeholder: 'latest',
        help: 'The dist-tag to monitor (e.g. latest, next).',
      },
      {
        key: 'expectedDigest',
        label: 'Expected tarball digest',
        type: 'text',
        required: true,
        placeholder: 'sha512-abc123...',
        help: 'The sha512 tarball digest this tag must always resolve to.',
      },
    ],
    rules: [
      {
        ruleType: 'registry.security_policy',
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
        ruleType: 'registry.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['dist_tag_removed'],
        },
        action: 'alert',
      },
    ],
  },

  // ── npm Maintainer Change ─────────────────────────────────────────
  {
    slug: 'rc-npm-maintainer-change',
    name: 'npm Maintainer Change',
    description:
      'Alert when maintainers are added or removed from a monitored npm package. Maintainer changes can indicate package takeover or ownership transfer.',
    category: 'package-security',
    severity: 'high',
    rules: [
      {
        ruleType: 'registry.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['maintainer_changed'],
        },
        action: 'alert',
      },
    ],
  },

  // ── npm Require Provenance ────────────────────────────────────────
  {
    slug: 'rc-npm-require-provenance',
    name: 'npm Require Provenance',
    description:
      'Alert when a published npm package version lacks a SLSA provenance attestation. Provenance proves which source and build system produced the artifact.',
    category: 'supply-chain',
    severity: 'critical',
    rules: [
      {
        ruleType: 'registry.security_policy',
        config: {
          artifactType: 'npm_package',
          tagPatterns: ['*'],
          changeTypes: ['version_published'],
          requireProvenance: true,
        },
        action: 'alert',
      },
    ],
  },

  // ── npm Tag Require CI ────────────────────────────────────────────
  {
    slug: 'rc-npm-tag-require-ci',
    name: 'npm Tag Require CI',
    description:
      'Alert when an npm dist-tag change or new tag is not attributed to a verified CI workflow. Catches manual publishes that bypass your CI/CD pipeline.',
    category: 'supply-chain',
    severity: 'high',
    rules: [
      {
        ruleType: 'registry.attribution',
        config: {
          artifactType: 'npm_package',
          tagPatterns: ['*'],
          changeTypes: ['digest_change', 'new_tag'],
          attributionCondition: 'must_match',
          workflows: [],
          actors: [],
          branches: [],
        },
        action: 'alert',
      },
    ],
  },

  // ── npm Tag Install Scripts ───────────────────────────────────────
  {
    slug: 'rc-npm-tag-install-scripts',
    name: 'npm Tag Install Scripts',
    description:
      'Alert when a dist-tag points to a version containing install scripts. Install scripts are a common supply chain attack vector.',
    category: 'package-security',
    severity: 'critical',
    rules: [
      {
        ruleType: 'registry.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['new_tag', 'digest_change'],
          checkInstallScripts: true,
        },
        action: 'alert',
      },
    ],
  },

  // ── npm Tag Require Provenance ────────────────────────────────────
  {
    slug: 'rc-npm-tag-require-provenance',
    name: 'npm Tag Require Provenance',
    description:
      'Alert when an npm dist-tag change points to a version without SLSA provenance. Ensures all tag movements reference provenance-attested builds.',
    category: 'supply-chain',
    severity: 'critical',
    rules: [
      {
        ruleType: 'registry.security_policy',
        config: {
          artifactType: 'npm_package',
          tagPatterns: ['*'],
          changeTypes: ['new_tag', 'digest_change', 'dist_tag_updated'],
          requireProvenance: true,
        },
        action: 'alert',
      },
    ],
  },

  // ── npm Tag Major Version Jump ────────────────────────────────────
  {
    slug: 'rc-npm-tag-major-jump',
    name: 'npm Tag Major Version Jump',
    description:
      'Alert when a dist-tag is moved to a version with a major semver increment. Unexpected major jumps on release channels can indicate breaking changes or package takeover.',
    category: 'package-security',
    severity: 'high',
    rules: [
      {
        ruleType: 'registry.npm_checks',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['new_tag', 'digest_change'],
          checkMajorVersionJump: true,
        },
        action: 'alert',
      },
    ],
  },

  // ── npm Tag Rapid Change ──────────────────────────────────────────
  {
    slug: 'rc-npm-tag-rapid-change',
    name: 'npm Tag Rapid Change',
    description:
      'Alert when npm dist-tags change faster than expected. Rapid tag movements may indicate a compromised automation pipeline or an attack in progress.',
    category: 'package-security',
    severity: 'high',
    rules: [
      {
        ruleType: 'registry.anomaly_detection',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['new_tag', 'digest_change', 'dist_tag_updated'],
          maxChanges: 3,
          windowMinutes: 30,
        },
        action: 'alert',
      },
    ],
  },

  // ── npm Tag Off-Hours ─────────────────────────────────────────────
  {
    slug: 'rc-npm-tag-off-hours',
    name: 'npm Tag Off-Hours',
    description:
      'Alert when npm dist-tags are changed outside of business hours. Off-hours tag movements may indicate unauthorized access or compromised credentials.',
    category: 'package-security',
    severity: 'high',
    inputs: [
      {
        key: 'startHour',
        label: 'Business hours start (HH:MM)',
        type: 'text',
        required: true,
        default: '09:00',
        placeholder: '09:00',
        help: 'Tag changes outside this window will trigger an alert.',
      },
      {
        key: 'endHour',
        label: 'Business hours end (HH:MM)',
        type: 'text',
        required: true,
        default: '18:00',
        placeholder: '18:00',
      },
      {
        key: 'timezone',
        label: 'Timezone',
        type: 'text',
        required: false,
        default: 'UTC',
        placeholder: 'UTC',
        help: 'IANA timezone name (e.g. America/New_York, Europe/London).',
      },
    ],
    rules: [
      {
        ruleType: 'registry.anomaly_detection',
        config: {
          tagPatterns: ['*'],
          changeTypes: ['new_tag', 'digest_change', 'dist_tag_updated'],
          allowedHoursStart: '{{startHour}}',
          allowedHoursEnd: '{{endHour}}',
          timezone: '{{timezone}}',
          allowedDays: [1, 2, 3, 4, 5],
        },
        action: 'alert',
      },
    ],
  },
];
