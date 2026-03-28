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

Templates are defined in `modules/chain/src/templates/index.ts`. They cover on-chain monitoring patterns including event matching, balance tracking, and windowed analysis.

### Infrastructure

Templates are defined in `modules/infra/src/templates/index.ts`. They cover TLS certificate monitoring, DNS change detection, security header auditing, and domain registration expiry.

### AWS

Templates are defined in `modules/aws/src/templates/index.ts`. They cover CloudTrail event monitoring, root account activity detection, authentication failure analysis, and Spot instance interruption alerts.

### Registry

Templates are defined in `modules/registry/src/templates/index.ts`. They cover Docker image digest monitoring, npm package integrity checks, supply chain attribution verification, and anomaly detection.
