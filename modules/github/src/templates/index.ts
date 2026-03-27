import type { DetectionTemplate } from '@sentinel/shared/module';

export const templates: DetectionTemplate[] = [
  // ── Access Control ──────────────────────────────────────────────────
  {
    slug: 'github-repo-visibility',
    name: 'Repository Visibility Monitor',
    description: 'Alert when a repository is made public. Critical for preventing accidental exposure of private code.',
    category: 'access-control',
    severity: 'critical',
    inputs: [
      {
        key: 'alertOn',
        label: 'Alert when',
        type: 'select',
        required: true,
        default: 'publicized',
        options: [
          { value: 'publicized', label: 'Repository is made public' },
          { value: 'privatized', label: 'Repository is made private' },
          { value: 'any', label: 'Any visibility change' },
        ],
      },
      {
        key: 'excludeRepos',
        label: 'Exclude repositories',
        type: 'string-array',
        required: false,
        placeholder: 'org/repo-name',
        help: 'Glob patterns, one per line (e.g. org/archived-*). Matching repos will be ignored.',
      },
    ],
    rules: [
      {
        ruleType: 'github.repo_visibility',
        config: { alertOn: 'publicized', excludeRepos: [] },
        action: 'alert',
      },
    ],
  },
  {
    slug: 'github-member-changes',
    name: 'Member Access Monitor',
    description: 'Alert on member additions and removals. Track who has access to your repositories and organization.',
    category: 'access-control',
    severity: 'high',
    inputs: [
      {
        key: 'watchRoles',
        label: 'Watch roles',
        type: 'string-array',
        required: false,
        placeholder: 'owner, member',
        help: 'Leave empty to watch all role changes. One role per line.',
      },
    ],
    rules: [
      {
        ruleType: 'github.member_change',
        config: { alertOnActions: ['added', 'removed'], watchRoles: [] },
        action: 'alert',
      },
    ],
  },
  {
    slug: 'github-deploy-keys',
    name: 'Deploy Key Monitor',
    description: 'Alert when deploy keys are added to repositories. Write-access keys are a common attack vector for supply chain compromises.',
    category: 'access-control',
    severity: 'high',
    inputs: [
      {
        key: 'alertOnWriteKeys',
        label: 'Alert only on write-access keys',
        type: 'boolean',
        required: false,
        default: true,
        help: 'Write-access deploy keys are more dangerous — they can push code. Disable to alert on all keys.',
      },
    ],
    rules: [
      {
        ruleType: 'github.deploy_key',
        config: { alertOnActions: ['created', 'deleted'], alertOnWriteKeys: true },
        action: 'alert',
      },
    ],
  },

  // ── Code Protection ─────────────────────────────────────────────────
  {
    slug: 'github-branch-protection',
    name: 'Branch Protection Changes',
    description: 'Alert when branch protection rules are modified or removed. Detects weakening of code review requirements.',
    category: 'code-protection',
    severity: 'high',
    inputs: [
      {
        key: 'watchBranches',
        label: 'Watch branches',
        type: 'string-array',
        required: false,
        placeholder: 'main\nrelease/*',
        help: 'Glob patterns, one per line. Leave empty to watch all branches.',
      },
    ],
    rules: [
      {
        ruleType: 'github.branch_protection',
        config: { alertOnActions: ['edited', 'deleted'], watchBranches: [] },
        action: 'alert',
      },
    ],
  },
  {
    slug: 'github-force-push-protection',
    name: 'Force Push Detection',
    description: 'Alert on force pushes to critical branches. Force pushes can rewrite history and bypass code review.',
    category: 'code-protection',
    severity: 'critical',
    inputs: [
      {
        key: 'watchBranches',
        label: 'Watch branches',
        type: 'string-array',
        required: false,
        default: ['main', 'master', 'release/*', 'production'],
        placeholder: 'main\nmaster\nrelease/*',
        help: 'Glob patterns, one per line. Defaults to main, master, release/*, production.',
      },
    ],
    rules: [
      {
        ruleType: 'github.force_push',
        config: {
          watchBranches: ['main', 'master', 'release/*', 'production'],
          alertOnAllForced: false,
        },
        action: 'alert',
      },
    ],
  },

  // ── Secrets ─────────────────────────────────────────────────────────
  {
    slug: 'github-secret-scanning',
    name: 'Secret Scanning Alerts',
    description: 'Alert when GitHub detects exposed secrets in your repositories. Immediate action required to rotate compromised credentials.',
    category: 'secrets',
    severity: 'critical',
    rules: [
      {
        ruleType: 'github.secret_scanning',
        config: { alertOnActions: ['created'], secretTypes: [] },
        action: 'alert',
      },
    ],
  },

  // ── Organization ────────────────────────────────────────────────────
  {
    slug: 'github-org-changes',
    name: 'Organization Settings Monitor',
    description: 'Alert on organization and team changes. Tracks membership, team permissions, and org-level events.',
    category: 'organization',
    severity: 'high',
    rules: [
      {
        ruleType: 'github.org_settings',
        config: { watchActions: [] },
        action: 'alert',
      },
    ],
  },

  // ── Comprehensive ───────────────────────────────────────────────────
  {
    slug: 'github-full-security',
    name: 'Full GitHub Security Suite',
    description: 'Enable all GitHub security monitors in one detection. Covers visibility, access, branch protection, force pushes, secrets, and org changes.',
    category: 'comprehensive',
    severity: 'critical',
    inputs: [
      {
        key: 'watchBranches',
        label: 'Watch branches (force push & branch protection)',
        type: 'string-array',
        required: false,
        default: ['main', 'master', 'release/*', 'production'],
        placeholder: 'main\nmaster\nrelease/*',
        help: 'Glob patterns applied to force push and branch protection rules.',
      },
      {
        key: 'excludeRepos',
        label: 'Exclude repositories',
        type: 'string-array',
        required: false,
        placeholder: 'org/archived-repo',
        help: 'Repos to exclude from visibility monitoring. Glob patterns, one per line.',
      },
    ],
    rules: [
      {
        ruleType: 'github.repo_visibility',
        config: { alertOn: 'publicized', excludeRepos: [] },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'github.secret_scanning',
        config: { alertOnActions: ['created'], secretTypes: [] },
        action: 'alert',
        priority: 10,
      },
      {
        ruleType: 'github.force_push',
        config: { watchBranches: ['main', 'master', 'release/*', 'production'], alertOnAllForced: false },
        action: 'alert',
        priority: 20,
      },
      {
        ruleType: 'github.branch_protection',
        config: { alertOnActions: ['edited', 'deleted'], watchBranches: [] },
        action: 'alert',
        priority: 30,
      },
      {
        ruleType: 'github.deploy_key',
        config: { alertOnActions: ['created'], alertOnWriteKeys: true },
        action: 'alert',
        priority: 30,
      },
      {
        ruleType: 'github.member_change',
        config: { alertOnActions: ['added', 'removed'], watchRoles: [] },
        action: 'alert',
        priority: 40,
      },
      {
        ruleType: 'github.org_settings',
        config: { watchActions: [] },
        action: 'alert',
        priority: 50,
      },
    ],
  },
];
