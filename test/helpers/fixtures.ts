/**
 * Shared test fixtures for the Sentinel security monitoring platform.
 *
 * These are static data objects used across test files. They are intentionally
 * deterministic (no randomness) so assertions can match exact values.
 *
 * For fixtures that require database insertion, see the helpers in setup.ts.
 */

// ---------------------------------------------------------------------------
// Test user data
// ---------------------------------------------------------------------------

export const TEST_USERS = {
  admin: {
    username: 'admin',
    email: 'admin@test.sentinel.dev',
    password: 'TestPass123!',
  },
  editor: {
    username: 'editor',
    email: 'editor@test.sentinel.dev',
    password: 'TestPass456!',
  },
  viewer: {
    username: 'viewer',
    email: 'viewer@test.sentinel.dev',
    password: 'TestPass789!',
  },
} as const;

// ---------------------------------------------------------------------------
// Test organization data
// ---------------------------------------------------------------------------

export const TEST_ORGS = {
  primary: {
    name: 'Sentinel Security',
    slug: 'sentinel-security',
  },
  secondary: {
    name: 'Acme Corp',
    slug: 'acme-corp',
  },
} as const;

// ---------------------------------------------------------------------------
// Detection & rule fixtures
// ---------------------------------------------------------------------------

export const TEST_DETECTIONS = {
  repoVisibility: {
    moduleId: 'github',
    templateId: 'github-repo-visibility',
    name: 'Repository made public',
    description: 'Alert when a repository changes visibility to public',
    severity: 'critical' as const,
    status: 'active' as const,
    config: {},
  },
  branchProtection: {
    moduleId: 'github',
    templateId: 'github-branch-protection-removed',
    name: 'Branch protection removed',
    description: 'Alert when branch protection rules are deleted',
    severity: 'high' as const,
    status: 'active' as const,
    config: {},
  },
  dockerDigestChange: {
    moduleId: 'registry',
    templateId: 'rc-docker-digest-change',
    name: 'Docker image digest changed',
    description: 'Alert when a monitored Docker tag points to a different digest',
    severity: 'high' as const,
    status: 'active' as const,
    config: {},
  },
  npmVersionPublished: {
    moduleId: 'registry',
    templateId: 'rc-npm-version-published',
    name: 'npm version published',
    description: 'Alert on new npm package versions',
    severity: 'medium' as const,
    status: 'active' as const,
    config: {},
  },
  secretScanning: {
    moduleId: 'github',
    templateId: 'github-secret-scanning',
    name: 'Secret scanning alert',
    description: 'Alert when a secret is detected in a repository',
    severity: 'critical' as const,
    status: 'active' as const,
    config: {},
  },
  disabledDetection: {
    moduleId: 'github',
    templateId: 'github-force-push',
    name: 'Force push to protected branch (disabled)',
    severity: 'medium' as const,
    status: 'disabled' as const,
    config: {},
  },
} as const;

export const TEST_RULES = {
  repoVisibilityPublic: {
    moduleId: 'github',
    ruleType: 'github.repo_visibility',
    config: { visibility: 'public' },
    action: 'alert' as const,
    priority: 100,
    status: 'active' as const,
  },
  branchProtectionDeleted: {
    moduleId: 'github',
    ruleType: 'github.branch_protection',
    config: { action: 'deleted', branches: ['main', 'master'] },
    action: 'alert' as const,
    priority: 90,
    status: 'active' as const,
  },
  digestChange: {
    moduleId: 'registry',
    ruleType: 'registry.docker.digest_change',
    config: { tags: ['latest', 'stable'] },
    action: 'alert' as const,
    priority: 80,
    status: 'active' as const,
  },
  npmNewVersion: {
    moduleId: 'registry',
    ruleType: 'registry.npm.version_published',
    config: {},
    action: 'alert' as const,
    priority: 50,
    status: 'active' as const,
  },
  secretScanningCreated: {
    moduleId: 'github',
    ruleType: 'github.secret_scanning',
    config: { alertState: 'open' },
    action: 'alert' as const,
    priority: 100,
    status: 'active' as const,
  },
  logOnly: {
    moduleId: 'github',
    ruleType: 'github.push',
    config: {},
    action: 'log' as const,
    priority: 10,
    status: 'active' as const,
  },
} as const;

// ---------------------------------------------------------------------------
// GitHub webhook payload fixtures
// ---------------------------------------------------------------------------

export const GITHUB_WEBHOOKS = {
  /**
   * Repository visibility changed from private to public.
   */
  repositoryPublicized: {
    action: 'publicized',
    repository: {
      id: 123456789,
      node_id: 'R_kgDOAbCdEf',
      name: 'secret-project',
      full_name: 'test-org/secret-project',
      private: false,
      visibility: 'public',
      owner: {
        login: 'test-org',
        id: 987654,
        type: 'Organization',
      },
      html_url: 'https://github.com/test-org/secret-project',
      default_branch: 'main',
    },
    organization: {
      login: 'test-org',
      id: 987654,
    },
    sender: {
      login: 'admin-user',
      id: 111222,
    },
    installation: {
      id: 44556677,
    },
  },

  /**
   * Repository visibility changed from public to private.
   */
  repositoryPrivatized: {
    action: 'privatized',
    repository: {
      id: 123456789,
      node_id: 'R_kgDOAbCdEf',
      name: 'open-project',
      full_name: 'test-org/open-project',
      private: true,
      visibility: 'private',
      owner: {
        login: 'test-org',
        id: 987654,
        type: 'Organization',
      },
      html_url: 'https://github.com/test-org/open-project',
      default_branch: 'main',
    },
    organization: {
      login: 'test-org',
      id: 987654,
    },
    sender: {
      login: 'admin-user',
      id: 111222,
    },
    installation: {
      id: 44556677,
    },
  },

  /**
   * Branch protection rule deleted.
   */
  branchProtectionDeleted: {
    action: 'deleted',
    rule: {
      id: 555666,
      name: 'main',
      admin_enforced: true,
      required_status_checks: {
        strict: true,
        contexts: ['ci/build'],
      },
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
      },
    },
    repository: {
      id: 123456789,
      name: 'core-api',
      full_name: 'test-org/core-api',
      private: true,
      owner: {
        login: 'test-org',
        id: 987654,
        type: 'Organization',
      },
    },
    organization: {
      login: 'test-org',
      id: 987654,
    },
    sender: {
      login: 'rogue-dev',
      id: 333444,
    },
    installation: {
      id: 44556677,
    },
  },

  /**
   * New member added to repository.
   */
  memberAdded: {
    action: 'added',
    member: {
      login: 'new-contractor',
      id: 444555,
      type: 'User',
    },
    repository: {
      id: 123456789,
      name: 'core-api',
      full_name: 'test-org/core-api',
      private: true,
      owner: {
        login: 'test-org',
        id: 987654,
        type: 'Organization',
      },
    },
    organization: {
      login: 'test-org',
      id: 987654,
    },
    sender: {
      login: 'admin-user',
      id: 111222,
    },
    installation: {
      id: 44556677,
    },
  },

  /**
   * Organization member added.
   */
  orgMemberAdded: {
    action: 'member_added',
    membership: {
      user: {
        login: 'new-hire',
        id: 555666,
        type: 'User',
      },
      role: 'member',
      state: 'active',
      organization_url: 'https://api.github.com/orgs/test-org',
    },
    organization: {
      login: 'test-org',
      id: 987654,
    },
    sender: {
      login: 'admin-user',
      id: 111222,
    },
    installation: {
      id: 44556677,
    },
  },

  /**
   * Deploy key created.
   */
  deployKeyCreated: {
    action: 'created',
    key: {
      id: 777888,
      key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG...',
      title: 'CI Deploy Key',
      read_only: false,
      created_at: '2026-03-15T10:00:00Z',
    },
    repository: {
      id: 123456789,
      name: 'core-api',
      full_name: 'test-org/core-api',
      private: true,
      owner: {
        login: 'test-org',
        id: 987654,
        type: 'Organization',
      },
    },
    organization: {
      login: 'test-org',
      id: 987654,
    },
    sender: {
      login: 'admin-user',
      id: 111222,
    },
    installation: {
      id: 44556677,
    },
  },

  /**
   * Secret scanning alert created.
   */
  secretScanningCreated: {
    action: 'created',
    alert: {
      number: 42,
      secret_type: 'github_personal_access_token',
      secret_type_display_name: 'GitHub Personal Access Token',
      state: 'open',
      resolution: null,
      html_url: 'https://github.com/test-org/core-api/security/secret-scanning/42',
      created_at: '2026-03-15T12:00:00Z',
      push_protection_bypassed: false,
    },
    repository: {
      id: 123456789,
      name: 'core-api',
      full_name: 'test-org/core-api',
      private: true,
      owner: {
        login: 'test-org',
        id: 987654,
        type: 'Organization',
      },
    },
    organization: {
      login: 'test-org',
      id: 987654,
    },
    sender: {
      login: 'github-advanced-security[bot]',
      id: 12345678,
    },
    installation: {
      id: 44556677,
    },
  },

  /**
   * Force push to a branch.
   */
  forcePush: {
    ref: 'refs/heads/main',
    before: 'aaa111bbb222ccc333ddd444eee555fff6667778',
    after: 'fff666eee555ddd444ccc333bbb222aaa111000999',
    forced: true,
    pusher: {
      name: 'rogue-dev',
      email: 'rogue@example.com',
    },
    repository: {
      id: 123456789,
      name: 'core-api',
      full_name: 'test-org/core-api',
      private: true,
      owner: {
        login: 'test-org',
        id: 987654,
        type: 'Organization',
      },
    },
    organization: {
      login: 'test-org',
      id: 987654,
    },
    sender: {
      login: 'rogue-dev',
      id: 333444,
    },
    installation: {
      id: 44556677,
    },
  },

  /**
   * GitHub App installation created.
   */
  installationCreated: {
    action: 'created',
    installation: {
      id: 44556677,
      app_id: 123,
      app_slug: 'sentinel-security',
      target_type: 'Organization',
      account: {
        login: 'test-org',
        id: 987654,
        type: 'Organization',
      },
      permissions: {
        metadata: 'read',
        administration: 'read',
        members: 'read',
        organization_administration: 'read',
        organization_hooks: 'read',
        secret_scanning_alerts: 'read',
      },
      events: [
        'repository',
        'member',
        'organization',
        'branch_protection_rule',
        'deploy_key',
        'secret_scanning_alert',
        'push',
      ],
    },
    repositories: [
      { id: 123456789, name: 'core-api', full_name: 'test-org/core-api', private: true },
      { id: 123456790, name: 'frontend', full_name: 'test-org/frontend', private: true },
    ],
    sender: {
      login: 'admin-user',
      id: 111222,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Docker Hub webhook payload fixtures
// ---------------------------------------------------------------------------

export const DOCKER_HUB_WEBHOOKS = {
  /**
   * Docker Hub webhook for a new tag push.
   */
  tagPush: {
    push_data: {
      pusher: 'cibot',
      tag: 'v2.1.0',
      pushed_at: 1710936000, // 2026-03-20T12:00:00Z
      images: [],
    },
    repository: {
      repo_name: 'sentinel/core-api',
      name: 'core-api',
      namespace: 'sentinel',
      status: 'Active',
      star_count: 0,
      repo_url: 'https://hub.docker.com/r/sentinel/core-api',
    },
    callback_url: 'https://registry.hub.docker.com/u/sentinel/core-api/hook/test',
  },

  /**
   * Docker Hub webhook for a latest tag push.
   */
  latestPush: {
    push_data: {
      pusher: 'deploy-bot',
      tag: 'latest',
      pushed_at: 1710943200, // 2026-03-20T14:00:00Z
      images: [],
    },
    repository: {
      repo_name: 'sentinel/core-api',
      name: 'core-api',
      namespace: 'sentinel',
      status: 'Active',
      star_count: 0,
      repo_url: 'https://hub.docker.com/r/sentinel/core-api',
    },
    callback_url: 'https://registry.hub.docker.com/u/sentinel/core-api/hook/test',
  },

  /**
   * Docker Hub webhook from an unknown pusher.
   */
  suspiciousPush: {
    push_data: {
      pusher: 'unknown-user',
      tag: 'latest',
      pushed_at: 1710950400, // 2026-03-20T16:00:00Z
      images: [],
    },
    repository: {
      repo_name: 'sentinel/core-api',
      name: 'core-api',
      namespace: 'sentinel',
      status: 'Active',
      star_count: 0,
      repo_url: 'https://hub.docker.com/r/sentinel/core-api',
    },
    callback_url: 'https://registry.hub.docker.com/u/sentinel/core-api/hook/test',
  },
} as const;

// ---------------------------------------------------------------------------
// Docker registry API fixtures (for polling)
// ---------------------------------------------------------------------------

export const DOCKER_REGISTRY = {
  /**
   * Docker Hub tags list API response (v2).
   */
  tagsPage1: {
    count: 3,
    next: null,
    results: [
      {
        name: 'latest',
        last_updated: '2026-03-20T10:00:00Z',
        images: [
          { architecture: 'amd64', os: 'linux', digest: 'sha256:aaa111bbb222ccc333ddd444eee555fff666' },
          { architecture: 'arm64', os: 'linux', digest: 'sha256:111aaa222bbb333ccc444ddd555eee666fff' },
        ],
      },
      {
        name: 'v2.0.0',
        last_updated: '2026-03-18T09:00:00Z',
        images: [
          { architecture: 'amd64', os: 'linux', digest: 'sha256:v200amd64digest000111222333444555666' },
        ],
      },
      {
        name: 'v1.9.0',
        last_updated: '2026-03-15T10:00:00Z',
        images: [
          { architecture: 'amd64', os: 'linux', digest: 'sha256:v190amd64digest000111222333444555666' },
        ],
      },
    ],
  },

  /**
   * Tags page with a digest change on latest.
   */
  tagsDigestChanged: {
    count: 3,
    next: null,
    results: [
      {
        name: 'latest',
        last_updated: '2026-03-20T14:00:00Z',
        images: [
          { architecture: 'amd64', os: 'linux', digest: 'sha256:newdigestabc000111222333444555666777' },
          { architecture: 'arm64', os: 'linux', digest: 'sha256:newdigestdef888999000111222333444555' },
        ],
      },
      {
        name: 'v2.0.0',
        last_updated: '2026-03-18T09:00:00Z',
        images: [
          { architecture: 'amd64', os: 'linux', digest: 'sha256:v200amd64digest000111222333444555666' },
        ],
      },
      {
        name: 'v1.9.0',
        last_updated: '2026-03-15T10:00:00Z',
        images: [
          { architecture: 'amd64', os: 'linux', digest: 'sha256:v190amd64digest000111222333444555666' },
        ],
      },
    ],
  },

  /**
   * Tags page with a new tag added.
   */
  tagsWithNewTag: {
    count: 4,
    next: null,
    results: [
      {
        name: 'v2.1.0',
        last_updated: '2026-03-20T12:00:00Z',
        images: [
          { architecture: 'amd64', os: 'linux', digest: 'sha256:v210amd64digest000111222333444555666' },
        ],
      },
      {
        name: 'latest',
        last_updated: '2026-03-20T10:00:00Z',
        images: [
          { architecture: 'amd64', os: 'linux', digest: 'sha256:aaa111bbb222ccc333ddd444eee555fff666' },
        ],
      },
      {
        name: 'v2.0.0',
        last_updated: '2026-03-18T09:00:00Z',
        images: [
          { architecture: 'amd64', os: 'linux', digest: 'sha256:v200amd64digest000111222333444555666' },
        ],
      },
      {
        name: 'v1.9.0',
        last_updated: '2026-03-15T10:00:00Z',
        images: [
          { architecture: 'amd64', os: 'linux', digest: 'sha256:v190amd64digest000111222333444555666' },
        ],
      },
    ],
  },

  /**
   * Tags page with a tag removed.
   */
  tagsWithRemoval: {
    count: 2,
    next: null,
    results: [
      {
        name: 'latest',
        last_updated: '2026-03-20T10:00:00Z',
        images: [
          { architecture: 'amd64', os: 'linux', digest: 'sha256:aaa111bbb222ccc333ddd444eee555fff666' },
        ],
      },
      {
        name: 'v2.0.0',
        last_updated: '2026-03-18T09:00:00Z',
        images: [
          { architecture: 'amd64', os: 'linux', digest: 'sha256:v200amd64digest000111222333444555666' },
        ],
      },
    ],
  },

  /**
   * Auth token response.
   */
  authToken: {
    token: 'test-docker-registry-token-abc123',
  },
} as const;

// ---------------------------------------------------------------------------
// npm registry fixtures
// ---------------------------------------------------------------------------

export const NPM_REGISTRY = {
  /**
   * npm packument (full package metadata).
   */
  packument: {
    name: '@sentinel/shared',
    'dist-tags': {
      latest: '2.1.0',
      next: '3.0.0-beta.1',
    },
    versions: {
      '2.0.0': {
        name: '@sentinel/shared',
        version: '2.0.0',
        dist: {
          tarball: 'https://registry.npmjs.org/@sentinel/shared/-/shared-2.0.0.tgz',
          shasum: 'abc123def456abc123def456abc123def456abc1',
          integrity: 'sha512-oldintegrityhash000111222333444555',
        },
        scripts: {},
        maintainers: [
          { name: 'sentinel-bot', email: 'bot@sentinel.dev' },
        ],
      },
      '2.1.0': {
        name: '@sentinel/shared',
        version: '2.1.0',
        dist: {
          tarball: 'https://registry.npmjs.org/@sentinel/shared/-/shared-2.1.0.tgz',
          shasum: 'def456abc123def456abc123def456abc123def4',
          integrity: 'sha512-newintegrityhash000111222333444555',
        },
        scripts: {},
        maintainers: [
          { name: 'sentinel-bot', email: 'bot@sentinel.dev' },
        ],
      },
      '3.0.0-beta.1': {
        name: '@sentinel/shared',
        version: '3.0.0-beta.1',
        dist: {
          tarball: 'https://registry.npmjs.org/@sentinel/shared/-/shared-3.0.0-beta.1.tgz',
          shasum: '111222333444555666777888999000aaabbbcccdd',
          integrity: 'sha512-betaintegrityhash000111222333444555',
        },
        scripts: { postinstall: 'echo "hello"' },
        maintainers: [
          { name: 'sentinel-bot', email: 'bot@sentinel.dev' },
        ],
      },
    },
    time: {
      created: '2026-01-01T00:00:00Z',
      modified: '2026-03-20T12:00:00Z',
      '2.0.0': '2026-02-15T10:00:00Z',
      '2.1.0': '2026-03-20T12:00:00Z',
      '3.0.0-beta.1': '2026-03-25T08:00:00Z',
    },
    maintainers: [
      { name: 'sentinel-bot', email: 'bot@sentinel.dev' },
    ],
  },

  /**
   * npm packument with a suspicious maintainer change.
   */
  packumentMaintainerChanged: {
    name: '@sentinel/shared',
    'dist-tags': {
      latest: '2.1.1',
    },
    versions: {
      '2.1.1': {
        name: '@sentinel/shared',
        version: '2.1.1',
        dist: {
          tarball: 'https://registry.npmjs.org/@sentinel/shared/-/shared-2.1.1.tgz',
          shasum: 'aaa111bbb222ccc333ddd444eee555fff666777',
          integrity: 'sha512-suspiciousintegrityhash000111222333',
        },
        scripts: {},
        maintainers: [
          { name: 'sentinel-bot', email: 'bot@sentinel.dev' },
          { name: 'unknown-actor', email: 'unknown@evil.com' },
        ],
      },
    },
    maintainers: [
      { name: 'sentinel-bot', email: 'bot@sentinel.dev' },
      { name: 'unknown-actor', email: 'unknown@evil.com' },
    ],
  },

  /**
   * npm attestation response (SLSA provenance present).
   */
  attestationWithProvenance: {
    attestations: [
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        bundle: {
          mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.1',
          verificationMaterial: {
            tlogEntries: [
              {
                logIndex: '34567890',
                logId: { keyId: 'wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0=' },
              },
            ],
          },
          dsseEnvelope: {
            payloadType: 'application/vnd.in-toto+json',
            payload: btoa(JSON.stringify({
              _type: 'https://in-toto.io/Statement/v1',
              predicateType: 'https://slsa.dev/provenance/v1',
              predicate: {
                buildDefinition: {
                  buildType: 'https://slsa.dev/provenance/v1',
                  externalParameters: {
                    workflow: {
                      ref: 'refs/heads/main',
                      repository: 'https://github.com/sentinel-security/sentinel',
                    },
                  },
                },
                runDetails: {
                  builder: {
                    id: 'https://github.com/actions/runner',
                  },
                  metadata: {
                    invocationId: 'https://github.com/sentinel-security/sentinel/actions/runs/12345',
                  },
                },
              },
            })),
          },
        },
      },
    ],
  },

  /**
   * npm attestation response (no provenance).
   */
  attestationEmpty: {
    attestations: [],
  },
} as const;

// ---------------------------------------------------------------------------
// CI notification fixtures (sent by instrumented CI workflows)
// ---------------------------------------------------------------------------

export const CI_NOTIFICATIONS = {
  /**
   * A Docker image build notification from GitHub Actions.
   */
  dockerBuild: {
    artifact_name: 'sentinel/core-api',
    artifact_type: 'docker_image',
    version: 'v2.1.0',
    digest: 'sha256:v210amd64digest000111222333444555666',
    github_run_id: 12345,
    github_commit: 'abc123def456789012345678901234567890abcd',
    github_actor: 'deploy-bot',
    github_workflow: '.github/workflows/release.yml',
    github_repo: 'sentinel-security/sentinel',
  },

  /**
   * An npm package publish notification from GitHub Actions.
   */
  npmPublish: {
    artifact_name: '@sentinel/shared',
    artifact_type: 'npm_package',
    version: '2.1.0',
    digest: 'sha512-newintegrityhash000111222333444555',
    github_run_id: 12346,
    github_commit: 'def456789012345678901234567890abcdabc123',
    github_actor: 'sentinel-bot',
    github_workflow: '.github/workflows/publish.yml',
    github_repo: 'sentinel-security/sentinel',
  },

  /**
   * A CI notification with a mismatched commit (for attribution testing).
   */
  mismatchedCommit: {
    artifact_name: 'sentinel/core-api',
    artifact_type: 'docker_image',
    version: 'v2.1.0',
    digest: 'sha256:v210amd64digest000111222333444555666',
    github_run_id: 99999,
    github_commit: 'wrong999commit888hash777666555444333222111',
    github_actor: 'unknown-user',
    github_workflow: '.github/workflows/unknown.yml',
    github_repo: 'fork-org/sentinel',
  },
} as const;

// ---------------------------------------------------------------------------
// GitHub Actions API fixtures (for attribution verification)
// ---------------------------------------------------------------------------

export const GITHUB_ACTIONS = {
  /**
   * Successful workflow run matching CI notification.
   */
  workflowRun: {
    id: 12345,
    name: 'Release',
    head_sha: 'abc123def456789012345678901234567890abcd',
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    actor: { login: 'deploy-bot' },
    triggering_actor: { login: 'developer' },
    html_url: 'https://github.com/sentinel-security/sentinel/actions/runs/12345',
    path: '.github/workflows/release.yml',
    created_at: '2026-03-20T11:55:00Z',
    updated_at: '2026-03-20T12:00:00Z',
    run_started_at: '2026-03-20T11:55:00Z',
  },

  /**
   * Workflow run on a non-main branch.
   */
  workflowRunDevelop: {
    id: 12346,
    name: 'Release',
    head_sha: 'abc123def456789012345678901234567890abcd',
    head_branch: 'develop',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    actor: { login: 'deploy-bot' },
    triggering_actor: { login: 'developer' },
    html_url: 'https://github.com/sentinel-security/sentinel/actions/runs/12346',
    path: '.github/workflows/release.yml',
    created_at: '2026-03-20T11:55:00Z',
    updated_at: '2026-03-20T12:00:00Z',
    run_started_at: '2026-03-20T11:55:00Z',
  },

  /**
   * Workflow run that failed.
   */
  workflowRunFailed: {
    id: 12347,
    name: 'Release',
    head_sha: 'abc123def456789012345678901234567890abcd',
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    actor: { login: 'deploy-bot' },
    triggering_actor: { login: 'developer' },
    html_url: 'https://github.com/sentinel-security/sentinel/actions/runs/12347',
    path: '.github/workflows/release.yml',
    created_at: '2026-03-20T11:55:00Z',
    updated_at: '2026-03-20T12:00:00Z',
    run_started_at: '2026-03-20T11:55:00Z',
  },

  /**
   * Workflow runs list response (single match).
   */
  workflowRunsList: {
    total_count: 1,
    workflow_runs: [
      {
        id: 12345,
        name: 'Release',
        head_sha: 'abc123def456789012345678901234567890abcd',
        head_branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        actor: { login: 'deploy-bot' },
        triggering_actor: { login: 'developer' },
        html_url: 'https://github.com/sentinel-security/sentinel/actions/runs/12345',
        path: '.github/workflows/release.yml',
        created_at: '2026-03-20T11:55:00Z',
        updated_at: '2026-03-20T12:00:00Z',
        run_started_at: '2026-03-20T11:55:00Z',
      },
    ],
  },

  /**
   * Empty workflow runs list.
   */
  workflowRunsEmpty: {
    total_count: 0,
    workflow_runs: [],
  },
} as const;

// ---------------------------------------------------------------------------
// Normalized event fixtures (post-processing, used by rule evaluators)
// ---------------------------------------------------------------------------

export const NORMALIZED_EVENTS = {
  repoPublicized: {
    moduleId: 'github',
    eventType: 'github.repository.visibility_changed',
    externalId: 'delivery-abc-123',
    payload: {
      action: 'publicized',
      repository: 'test-org/secret-project',
      visibility: 'public',
      previousVisibility: 'private',
      actor: 'admin-user',
    },
    occurredAt: new Date('2026-03-20T10:00:00Z'),
  },

  branchProtectionDeleted: {
    moduleId: 'github',
    eventType: 'github.branch_protection.deleted',
    externalId: 'delivery-def-456',
    payload: {
      action: 'deleted',
      repository: 'test-org/core-api',
      branch: 'main',
      actor: 'rogue-dev',
      previousProtection: {
        requiredReviewers: 2,
        dismissStaleReviews: true,
        requireStatusChecks: true,
      },
    },
    occurredAt: new Date('2026-03-20T11:00:00Z'),
  },

  dockerDigestChange: {
    moduleId: 'registry',
    eventType: 'registry.docker.digest_change',
    externalId: null,
    payload: {
      artifactName: 'sentinel/core-api',
      tag: 'latest',
      oldDigest: 'sha256:aaa111bbb222ccc333ddd444eee555fff666',
      newDigest: 'sha256:newdigestabc000111222333444555666777',
      registry: 'docker_hub',
    },
    occurredAt: new Date('2026-03-20T14:00:00Z'),
  },

  npmVersionPublished: {
    moduleId: 'registry',
    eventType: 'registry.npm.version_published',
    externalId: null,
    payload: {
      packageName: '@sentinel/shared',
      version: '2.1.0',
      digest: 'sha512-newintegrityhash000111222333444555',
      registry: 'npmjs',
      hasInstallScripts: false,
    },
    occurredAt: new Date('2026-03-20T12:00:00Z'),
  },

  secretScanningAlert: {
    moduleId: 'github',
    eventType: 'github.secret_scanning.created',
    externalId: 'delivery-ghi-789',
    payload: {
      alertNumber: 42,
      secretType: 'github_personal_access_token',
      repository: 'test-org/core-api',
      actor: 'github-advanced-security[bot]',
      state: 'open',
    },
    occurredAt: new Date('2026-03-20T12:00:00Z'),
  },

  forcePush: {
    moduleId: 'github',
    eventType: 'github.push',
    externalId: 'delivery-jkl-012',
    payload: {
      ref: 'refs/heads/main',
      forced: true,
      beforeSha: 'aaa111bbb222ccc333ddd444eee555fff6667778',
      afterSha: 'fff666eee555ddd444ccc333bbb222aaa111000999',
      repository: 'test-org/core-api',
      pusher: 'rogue-dev',
    },
    occurredAt: new Date('2026-03-20T15:00:00Z'),
  },
} as const;

// ---------------------------------------------------------------------------
// Alert candidate fixtures (output of rule evaluation)
// ---------------------------------------------------------------------------

export const ALERT_CANDIDATES = {
  repoPublicized: {
    severity: 'critical',
    title: 'Repository test-org/secret-project was made public',
    description: 'The repository was changed from private to public visibility by admin-user.',
    triggerType: 'immediate' as const,
    triggerData: {
      repository: 'test-org/secret-project',
      visibility: 'public',
      actor: 'admin-user',
    },
  },

  branchProtectionDeleted: {
    severity: 'high',
    title: 'Branch protection deleted on test-org/core-api (main)',
    description: 'Branch protection rules were removed from the main branch by rogue-dev.',
    triggerType: 'immediate' as const,
    triggerData: {
      repository: 'test-org/core-api',
      branch: 'main',
      actor: 'rogue-dev',
    },
  },

  dockerDigestChange: {
    severity: 'high',
    title: 'Docker image digest changed: sentinel/core-api:latest',
    description: 'The latest tag now points to a different image digest.',
    triggerType: 'immediate' as const,
    triggerData: {
      artifactName: 'sentinel/core-api',
      tag: 'latest',
      oldDigest: 'sha256:aaa111bbb222ccc333ddd444eee555fff666',
      newDigest: 'sha256:newdigestabc000111222333444555666777',
    },
  },
} as const;
