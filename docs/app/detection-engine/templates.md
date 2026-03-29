# Detection Templates

A detection template is a pre-configured detection definition that a user can instantiate from the UI with minimal configuration. Templates encode expert knowledge about common security patterns -- the correct rule types, default config values, severity, and action -- so users do not need to understand the evaluator system to create effective detections.

**Source**: `packages/shared/src/module.ts` (interface), `modules/*/src/templates/index.ts` (per-module definitions)

## DetectionTemplate interface

```typescript
export interface DetectionTemplate {
  /** URL-safe slug, e.g. 'github-repo-visibility'. Unique per module. */
  slug: string;

  /** Human-readable name shown in the template picker. */
  name: string;

  description: string;

  /**
   * Category for UI grouping.
   * Examples: 'access-control', 'code-protection', 'secrets', 'organization', 'comprehensive'
   */
  category: string;

  /** Default severity applied to the detection. */
  severity: 'low' | 'medium' | 'high' | 'critical';

  /**
   * Rules this template creates when instantiated.
   * Each entry maps to one row in the rules table.
   */
  rules: Array<{
    ruleType: string;
    config: Record<string, unknown>;
    action: 'alert' | 'log' | 'suppress';
    priority?: number;
  }>;

  /**
   * User-configurable inputs rendered as a form before instantiation.
   * Values are merged into rule configs at instantiation time.
   */
  inputs?: TemplateInput[];
}
```

## Template inputs

The `inputs` array declares which fields the user must or may configure before creating a detection from the template. Each `TemplateInput` maps to exactly one key in the merged rule config. The frontend renders a form from these inputs using the same `renderInput()` renderer used by the evaluator `uiSchema`, so there is a single rendering path for all dynamic form fields in the system.

```typescript
// Example: GitHub branch protection template input
{
  key: 'watchBranches',
  label: 'Watch branches',
  type: 'string-array',
  required: false,
  placeholder: 'main\nrelease/*',
  help: 'Glob patterns, one per line. Leave empty to watch all branches.',
}
```

Supported `type` values: `text`, `number`, `boolean`, `select`, `string-array`, `address`, `contract`, `network`.

## Template instantiation

When a user creates a detection from a template, the API performs these steps:

1. Resolves the template by its `slug` from the module's registered templates.
2. Merges the user-provided input values into each rule's `config` object as top-level keys. User values override template defaults.
3. Creates one row in the `detections` table using the template's `severity`, `name`, and any notification channels the user specified.
4. Creates one row in the `rules` table for each entry in `template.rules`, with the merged config, the rule's `action`, and `priority` (defaulting to `50` when not specified).

```typescript
// Simplified instantiation logic
const mergedConfig = {
  ...templateRule.config,   // template defaults
  ...userInputValues,       // user values override
};

await db.insert(rules).values({
  detectionId: detection.id,
  orgId,
  moduleId: module.id,
  ruleType: templateRule.ruleType,
  config: mergedConfig,
  action: templateRule.action,
  priority: templateRule.priority ?? 50,
  status: 'active',
});
```

### Multi-rule templates

Templates that define multiple entries in their `rules` array create a detection with multiple rules. All rules share the same parent detection and are evaluated as a group in priority order. The `github-full-security` template uses this pattern to bundle seven rule types into a single detection:

```typescript
// Excerpt from github-full-security template
rules: [
  { ruleType: 'github.repo_visibility',   action: 'alert', priority: 10 },
  { ruleType: 'github.secret_scanning',   action: 'alert', priority: 10 },
  { ruleType: 'github.force_push',        action: 'alert', priority: 20 },
  { ruleType: 'github.branch_protection', action: 'alert', priority: 30 },
  { ruleType: 'github.deploy_key',        action: 'alert', priority: 30 },
  { ruleType: 'github.member_change',     action: 'alert', priority: 40 },
  { ruleType: 'github.org_settings',      action: 'alert', priority: 50 },
]
```

## Template discovery

Each `DetectionModule` declares its templates in a `templates` property:

```typescript
export interface DetectionModule {
  readonly templates: DetectionTemplate[];
  // ...
}
```

Templates are loaded from module source at application startup. The API server collects templates from all registered modules and exposes them through the detections API. The frontend fetches this list to populate the template picker in the new-detection flow. Templates are grouped by module and by `category` within each module.

## Default templates

Modules can declare `defaultTemplates` -- an array of template slugs to auto-instantiate whenever a new monitored resource is created for that module:

```typescript
export interface DetectionModule {
  readonly defaultTemplates?: string[];
}
```

When a user connects a new GitHub organization or adds a new monitored contract, the API automatically creates detections from each slug in `defaultTemplates`. This ensures new resources have baseline coverage immediately without requiring manual detection setup. Auto-instantiated detections use the template's default config values; no user input is solicited. Users can later edit the detection to adjust thresholds or exclusion lists.

## Modules metadata API

The `/modules/metadata` endpoint (`GET /api/modules/metadata`) returns a serialized view of all registered modules including their event type definitions:

```json
{
  "data": [
    {
      "id": "github",
      "name": "GitHub",
      "eventTypes": [
        { "type": "github.repository.visibility_changed", "label": "Repository visibility changed", "description": "..." }
      ]
    }
  ]
}
```

A companion endpoint `GET /api/modules/metadata/sample-fields?moduleId=&eventType=` queries the most recent event of a given type from the org's event history and recursively extracts all payload field paths with their value types and sample values. The correlation rule builder uses this endpoint to populate field-path autocomplete dropdowns.

## Available templates by module

### GitHub

| Slug | Category | Severity | Rules | Description |
|---|---|---|---|---|
| `github-repo-visibility` | access-control | critical | 1 | Alerts on repository visibility changes. Configurable direction (publicized/privatized/any). Supports glob-based repo exclusion. |
| `github-member-changes` | access-control | high | 1 | Alerts on collaborator additions and removals. Optional role filter. |
| `github-deploy-keys` | access-control | high | 1 | Alerts on deploy key creation/deletion. Can restrict to write-access keys. |
| `github-branch-protection` | code-protection | high | 1 | Alerts on branch protection edits or deletions. Supports branch glob filter. |
| `github-force-push-protection` | code-protection | critical | 1 | Alerts on force pushes. Default watch: main, master, release/*, production. |
| `github-secret-scanning` | secrets | critical | 1 | Alerts on new GitHub secret scanning findings. |
| `github-org-changes` | organization | high | 1 | Alerts on organization-level membership, team, and settings changes. |
| `github-full-security` | comprehensive | critical | 7 | Bundles all GitHub security monitors into a single detection with priority ordering. |

### Chain

Source: `modules/chain/src/templates/index.ts`

| Slug | Category | Severity | Rules | Description |
|---|---|---|---|---|
| `chain-large-transfer` | token-activity | high | 1 | Alert on ERC-20 transfers exceeding a configurable amount. |
| `chain-fund-drainage` | balance | critical | 2 | Detect balance drainage via windowed transfer count + balance percent change. |
| `chain-ownership-monitor` | governance | critical | 2 | Alert on OwnershipTransferred and OwnershipTransferStarted events. |
| `chain-storage-anomaly` | governance | high | 1 | Monitor an EVM storage slot for unexpected changes or threshold crossings. |
| `chain-contract-creation` | contract-activity | high | 1 | Alert when a monitored address deploys a new contract. |
| `chain-balance-low` | balance | medium | 1 | Alert when balance falls below a minimum threshold. |
| `chain-custom-function-call` | custom | high | 1 | Monitor a specific function call by 4-byte selector. Configurable conditions. |
| `chain-custom-event` | custom | medium | 1 | Watch for any on-chain event by Solidity signature with optional field filters. |
| `chain-balance-tracker` | balance | medium | 1 | Full balance tracker: threshold_below, threshold_above, or percent_change with optional bidirectional. |
| `chain-activity-spike` | custom | high | 1 | Alert when event rate increases dramatically vs. a baseline period. |
| `chain-role-change` | governance | high | 2 | Alert on AccessControl RoleGranted and RoleRevoked events. |
| `chain-proxy-upgrade` | governance | critical | 1 | Alert on ERC-1967 Upgraded events. |
| `chain-proxy-upgrade-slot` | governance | critical | 1 | Poll the ERC-1967 implementation storage slot for changes. |
| `chain-multisig-signer` | governance | high | 2 | Alert on Safe AddedOwner and RemovedOwner events. |
| `chain-pause-state` | governance | high | 2 | Alert on Paused and Unpaused events. |
| `chain-repeated-transfer` | token-activity | high | 1 | Alert when the same recipient receives many transfers in a window. |
| `chain-native-balance-anomaly` | balance | high | 1 | Alert on native balance drops by a configurable percentage. |
| `chain-custom-storage-slot` | custom | medium | 1 | Poll an arbitrary storage slot and alert on user-defined conditions. |
| `chain-custom-view-function` | custom | medium | 1 | Call a view function on a schedule and alert on return value conditions. |
| `chain-custom-windowed-count` | custom | medium | 1 | Count any event type within a sliding window with optional grouping. |
| `chain-transfer-volume` | token-activity | high | 1 | Alert when total transferred volume exceeds a threshold in a window. |

### Infrastructure

Source: `modules/infra/src/templates/index.ts`

| Slug | Category | Severity | Rules | Description |
|---|---|---|---|---|
| `infra-cert-monitor` | certificate | critical | 2 | Certificate expiry + certificate issues (chain errors, self-signed, weak key, revocation). |
| `infra-tls-security` | tls | high | 2 | TLS weakness detection + missing security headers. |
| `infra-dns-change-monitor` | dns | high | 2 | DNS record changes + new subdomain discovery. |
| `infra-host-uptime` | availability | critical | 1 | Host unreachable and slow response alerting. |
| `infra-domain-expiry` | dns | high | 1 | Domain registration expiry monitoring. |
| `infra-ct-monitor` | dns | medium | 1 | Certificate Transparency log monitoring. |
| `infra-full-audit` | comprehensive | critical | 10 | All infrastructure monitors bundled into a single detection. |

### AWS

Source: `modules/aws/src/templates/index.ts`

| Slug | Category | Severity | Rules | Description |
|---|---|---|---|---|
| `aws-root-account-usage` | identity | critical | 1 | Root account activity monitoring. |
| `aws-console-login-anomaly` | identity | high | 1 | Console login failures, root logins, and MFA-less logins. |
| `aws-iam-user-changes` | identity | high | 1 | IAM user CRUD and access key operations. |
| `aws-iam-privilege-escalation` | identity | critical | 1 | Policy attachments and privilege modifications. |
| `aws-federated-identity-abuse` | identity | high | 1 | Role assumptions via OIDC/SAML. |
| `aws-mfa-deactivated` | identity | high | 1 | MFA device deactivation. |
| `aws-cloudtrail-disabled` | defense-evasion | critical | 1 | CloudTrail logging stopped, trail deleted, or event selectors modified. |
| `aws-config-evasion` | defense-evasion | critical | 1 | AWS Config recorder stopped or compliance rules deleted. |
| `aws-security-group-opened` | network | high | 1 | Security group ingress rules added. |
| `aws-ec2-ssh-access` | network | high | 1 | SSH key pair creation or import. |
| `aws-ec2-unusual-launch` | compute | medium | 2 | EC2 instance launches and attribute modifications. |
| `aws-spot-eviction` | compute | medium | 1 | Spot instance interruption notices. |
| `aws-s3-public-access` | data | critical | 1 | S3 bucket ACL, policy, encryption, and public access changes. |
| `aws-kms-key-action` | data | critical | 2 | KMS key deletion, disable, and grant operations. |
| `aws-secrets-access` | data | high | 2 | Secrets Manager reads and deletions. |
| `aws-access-denied` | reconnaissance | medium | 1 | Access denied errors (credential enumeration indicator). |
| `aws-full-security` | comprehensive | critical | 10 | Full AWS security suite covering all Tier 1 monitors. |

### Registry

Source: `modules/registry/src/templates/index.ts`

| Slug | Category | Severity | Rules | Description |
|---|---|---|---|---|
| `registry-docker-monitor` | container-security | medium | 1 | Docker image digest/tag change baseline monitoring. |
| `registry-require-ci-attribution` | supply-chain | high | 2 | Require CI attribution for Docker and npm releases. |
| `registry-enforce-signatures` | supply-chain | critical | 1 | Require cosign signatures on Docker images. |
| `registry-enforce-provenance` | supply-chain | critical | 2 | Require SLSA provenance on Docker and npm artifacts. |
| `registry-npm-monitor` | package-security | high | 3 | npm version changes, install scripts, major jumps, maintainer changes. |
| `registry-full-security` | comprehensive | critical | 7 | All registry monitors: Docker + npm + signatures + provenance + attribution + anomaly. |
| `rc-detect-manual-push` | supply-chain | high | 1 | Alert on pushes from users not on the approved pusher list. |
| `rc-pin-digest` | supply-chain | critical | 1 | Alert when Docker image digest changes from a pinned value. |
| `rc-suspicious-activity` | supply-chain | high | 1 | Rate limiting + off-hours deployment detection. |
| `rc-detect-source-mismatch` | supply-chain | high | 1 | Alert when changes are detected via polling but not webhook. |
| `rc-log-releases` | supply-chain | low | 1 | Log all release artifact changes (no alerting). |
| `rc-npm-log-releases` | package-security | low | 1 | Log all npm version changes (no alerting). |
| `rc-npm-tag-audit` | package-security | medium | 1 | Log dist-tag changes on latest, next, canary. |
| `rc-npm-unpublish-alert` | package-security | critical | 1 | Alert on npm version unpublish. |
| `rc-npm-rapid-publish` | package-security | high | 1 | Alert on rapid successive npm publishes. |
| `rc-npm-off-hours` | package-security | high | 1 | Alert on npm publishes outside business hours. |
| `rc-npm-tag-pin-digest` | package-security | critical | 1 | Alert when npm tarball digest changes from a pinned value. |
| `rc-npm-tag-removed` | package-security | high | 1 | Alert on npm dist-tag removal. |
| `rc-npm-maintainer-change` | package-security | high | 1 | Alert on npm maintainer additions or removals. |
| `rc-npm-require-provenance` | supply-chain | critical | 1 | Require SLSA provenance on npm versions. |
| `rc-npm-tag-require-ci` | supply-chain | high | 1 | Require CI attribution for npm tag changes. |
| `rc-npm-tag-install-scripts` | package-security | critical | 1 | Alert when dist-tags point to versions with install scripts. |
| `rc-npm-tag-require-provenance` | supply-chain | critical | 1 | Require provenance for npm dist-tag movements. |
| `rc-npm-tag-major-jump` | package-security | high | 1 | Alert on major semver jumps for dist-tags. |
| `rc-npm-tag-rapid-change` | package-security | high | 1 | Alert on rapid npm dist-tag changes. |
| `rc-npm-tag-off-hours` | package-security | high | 1 | Alert on npm dist-tag changes outside business hours. |

## AutoRules mechanism

Source: `packages/shared/src/auto-rules.ts`

When a monitored resource is first registered (e.g., a GitHub organization is connected, a contract is added), Sentinel can automatically create detections from a module's default templates. This ensures new resources have baseline security coverage immediately without manual setup.

### How it works

1. Each module declares a `defaultTemplates` array of template slugs:

   ```typescript
   readonly defaultTemplates?: string[];
   ```

2. When the API registers a new resource, it calls `autoCreateDetections()` with the module, org ID, and a human-readable resource label.

3. For each slug in `defaultTemplates`:
   - The function looks up the template in the module's `templates` array.
   - It creates a detection row using the template's name (suffixed with the resource label), description, severity, and empty channel IDs.
   - It creates one rule row per entry in `template.rules`, using the template's default config values, action, and priority (defaulting to 50).
   - Both inserts run in a single database transaction per template.

4. Errors are logged but never thrown -- auto-rule creation is fire-and-forget to prevent resource registration from failing due to template issues.

### Default cooldown

Auto-created detections use a hardcoded cooldown of 5 minutes. Users can adjust this after creation.

### Template input values

Auto-created detections use template default config values only. No user input is solicited. The detection name includes the resource label (e.g., "Repository Visibility Monitor -- acme/api") for identification.
