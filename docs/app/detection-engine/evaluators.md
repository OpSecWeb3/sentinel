# Evaluators

An evaluator is the unit of detection logic in Sentinel. Each evaluator implements one specific detection pattern for one module. The rule engine resolves the correct evaluator for each rule by looking up `"moduleId:ruleType"` in its registry, then calls `evaluate(ctx)` with the current event.

**Source**: `packages/shared/src/rules.ts` (interface), `modules/*/src/evaluators/*.ts` (implementations)

## RuleEvaluator interface

Every evaluator implements the `RuleEvaluator` interface defined in `packages/shared/src/rules.ts`:

```typescript
export interface RuleEvaluator {
  /** Must match rules.moduleId. Examples: 'github', 'chain', 'infra', 'aws', 'registry' */
  readonly moduleId: string;

  /**
   * Must match rules.ruleType.
   * Convention: "{moduleId}.{snake_case_name}"
   * Examples: 'github.repo_visibility', 'chain.windowed_count'
   */
  readonly ruleType: string;

  /** Zod schema for validating rule.config before evaluation. */
  readonly configSchema: ZodSchema;

  /**
   * UI schema for rendering the rule config as a dynamic form in the frontend.
   * Uses the same TemplateInput[] shape as detection templates.
   * Optional: evaluators without a uiSchema fall back to a raw key-value editor.
   */
  readonly uiSchema?: TemplateInput[];

  /** Evaluate a single event against this rule. Return AlertCandidate if triggered, null otherwise. */
  evaluate(ctx: EvalContext): Promise<AlertCandidate | null>;
}
```

## configSchema

Every evaluator defines a Zod schema that describes the valid shape of `rule.config`. This schema serves two purposes:

1. **Server-side validation**: The rule engine calls `configSchema.safeParse(rule.config)` before invoking `evaluate()`. If parsing fails, the rule is skipped entirely. This prevents evaluators from receiving malformed configs due to API bugs or manual database edits.

2. **Rule creation validation**: The API validates incoming rule config against the evaluator's schema when a user creates or updates a rule, returning structured Zod errors to the frontend.

Inside `evaluate()`, evaluators call `configSchema.parse(rule.config)` directly (not `safeParse`) because the rule engine has already guaranteed the config is valid.

```typescript
// Example: cert-expiry evaluator
const configSchema = z.object({
  warningDays: z.coerce.number().default(30),
  criticalDays: z.coerce.number().default(7),
});

async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
  const config = configSchema.parse(ctx.rule.config); // safe: already validated
  // ...
}
```

## uiSchema

`uiSchema` is an array of `TemplateInput` objects that drive dynamic form rendering in the detection configuration UI. Each entry describes one field in the rule config:

```typescript
export interface TemplateInput {
  key: string;                   // Config key this input maps to
  label: string;                 // Human-readable label shown in the form
  type: TemplateInputType;       // Render type (see table below)
  required: boolean;
  default?: string | number | boolean | string[];
  placeholder?: string;
  help?: string;                 // Helper text shown below the field
  options?: Array<{ label: string; value: string }>;  // Required for 'select' type
  min?: number;
  max?: number;
  showIf?: string;               // Conditionally show when referenced key has a value
}
```

### Supported input types

| Type | Rendered as |
|---|---|
| `text` | Single-line text input |
| `number` | Numeric input with optional min/max bounds |
| `boolean` | Checkbox toggle |
| `select` | Dropdown with `options[]` |
| `string-array` | Multi-line textarea, one entry per line |
| `address` | Ethereum address input with checksum validation |
| `contract` | Contract picker (chain module) |
| `network` | Network selector (chain module) |

When `uiSchema` is present, the frontend renders one form field per entry instead of a generic key-value editor. This allows non-technical users to configure complex rules through a structured UI without understanding the underlying JSON structure.

## Implementing a new evaluator

Follow this pattern to add a new evaluator to an existing module:

### Step 1: Create the evaluator file

Create a new file in the module's `evaluators/` directory, for example `modules/github/src/evaluators/my-rule.ts`.

### Step 2: Define the config schema

```typescript
import { z } from 'zod';
import type { RuleEvaluator, EvalContext, AlertCandidate } from '@sentinel/shared/rules';

const configSchema = z.object({
  watchBranches: z.array(z.string()).default(['main']),
  alertOnActions: z.array(z.enum(['edited', 'deleted'])).default(['edited', 'deleted']),
});
```

### Step 3: Export the evaluator object

```typescript
export const myRuleEvaluator: RuleEvaluator = {
  moduleId: 'github',
  ruleType: 'github.my_rule',
  configSchema,

  uiSchema: [
    {
      key: 'watchBranches',
      label: 'Watch branches',
      type: 'string-array',
      required: false,
      placeholder: 'main\nrelease/*',
      help: 'Glob patterns, one per line.',
    },
  ],

  async evaluate(ctx: EvalContext): Promise<AlertCandidate | null> {
    const { event, rule } = ctx;

    // Guard on event type -- return null for irrelevant events
    if (event.eventType !== 'github.branch_protection.deleted') return null;

    // Parse config -- safe because the engine pre-validated it
    const config = configSchema.parse(rule.config);

    // Apply detection logic
    const payload = event.payload as { branch: string; sender: { login: string } };
    if (!config.watchBranches.includes(payload.branch)) return null;

    // Return AlertCandidate on match
    return {
      orgId: event.orgId,
      detectionId: rule.detectionId,
      ruleId: rule.id,
      eventId: event.id,
      severity: 'high',           // Overwritten by detection.severity at engine level
      title: `Branch protection deleted on ${payload.branch}`,
      description: `${payload.sender.login} deleted branch protection for ${payload.branch}`,
      triggerType: 'immediate',
      triggerData: payload,
    };
  },
};
```

### Step 4: Register the evaluator in the module

Add the evaluator to the module's `evaluators` array in its `DetectionModule` export. The worker process iterates this array at startup and registers each evaluator into the global `Map<string, RuleEvaluator>`.

### Common evaluator patterns

**Event type guard**: Most evaluators begin by checking `event.eventType` and returning `null` immediately for irrelevant events. This is the cheapest filter.

**Payload type assertion**: Evaluators cast `event.payload` to a module-specific type after the event-type guard ensures the correct shape.

**Redis windowed state**: Chain module evaluators (`windowed_count`, `windowed_spike`, `windowed_sum`) use the `ctx.redis` client to maintain sorted sets that track events over time windows. See [Windowed Evaluators](../correlation-engine/windowing.md) for details.

**Condition evaluation**: Evaluators that support field-level conditions use the shared `evaluateConditions()` function from `packages/shared/src/conditions.ts`, which resolves dotted field paths and applies comparison operators.

### triggerType values

| Value | Meaning |
|---|---|
| `immediate` | The event itself is the trigger. Used for exact-match rules. |
| `windowed` | The trigger condition spans multiple events in a time window. Used by windowed-count, windowed-spike, and windowed-sum evaluators. |
| `deferred` | Reserved for rules that require polling or scheduled checks. |

## Evaluator registry

At worker startup, all modules are collected into a single `Map<string, RuleEvaluator>`. The map key is `"{moduleId}:{ruleType}"`:

```typescript
const evaluators = new Map<string, RuleEvaluator>();
for (const mod of modules) {
  for (const ev of mod.evaluators) {
    evaluators.set(`${ev.moduleId}:${ev.ruleType}`, ev);
  }
}
```

The rule engine resolves the evaluator for each rule using:

```typescript
const key = `${rule.moduleId}:${rule.ruleType}`;
const evaluator = this.evaluators.get(key);
if (!evaluator) continue; // unknown ruleType -- skip silently
```

If a rule references a `ruleType` that no registered evaluator handles, the rule is silently skipped. This allows modules to be removed without breaking the engine for other modules.

## Built-in evaluators by module

### GitHub module (`moduleId: 'github'`)

| ruleType | Source file | Description |
|---|---|---|
| `github.repo_visibility` | `repo-visibility.ts` | Fires when a repository visibility changes (publicized, privatized, or either). Supports glob exclusion patterns for repository names. |
| `github.branch_protection` | `branch-protection.ts` | Fires when a branch protection rule is edited or deleted. Supports glob patterns on branch names. |
| `github.member_change` | `member-change.ts` | Fires when a collaborator is added or removed from a repository or organization. Filterable by role. |
| `github.deploy_key` | `deploy-key.ts` | Fires when a deploy key is created or deleted. Can restrict to write-access keys only. |
| `github.secret_scanning` | `secret-scanning.ts` | Fires when GitHub's secret scanning creates a new alert. Filterable by secret type. |
| `github.force_push` | `force-push.ts` | Fires on force pushes to protected branches. Supports glob patterns on branch names. |
| `github.org_settings` | `org-settings.ts` | Fires on organization-level changes including team membership, installations, and org-level events. |

### Chain module (`moduleId: 'chain'`)

| ruleType | Source file | Description |
|---|---|---|
| `chain.event_match` | `event-match.ts` | Matches on-chain log events by `topic0` (keccak256 of event signature) and optional contract address. Supports field-level conditions on decoded event arguments. |
| `chain.function_call_match` | `function-call-match.ts` | Matches on-chain function calls by 4-byte selector. Evaluates conditions on decoded call arguments. |
| `chain.windowed_count` | `windowed-count.ts` | Counts matching on-chain log events within a sliding time window using a Redis sorted set. Triggers when count reaches threshold. Supports optional `groupByField`. |
| `chain.windowed_spike` | `windowed-spike.ts` | Detects rate spikes by comparing a short observation window against a longer baseline. Triggers when the percentage increase exceeds `increasePercent`. |
| `chain.windowed_sum` | `windowed-sum.ts` | Sums a numeric decoded argument field across events within a sliding window. Supports BigInt-scale values (e.g., wei amounts). |
| `chain.balance_track` | `balance-track.ts` | Monitors an account's on-chain balance and fires when it crosses a configured threshold. |
| `chain.state_poll` | `state-poll.ts` | Periodically calls a contract view function and fires when the returned value matches a configured condition. |
| `chain.view_call` | `view-call.ts` | Evaluates a contract view function call result against field-level conditions on demand. |

### Infrastructure module (`moduleId: 'infra'`)

| ruleType | Source file | Description |
|---|---|---|
| `infra.cert_expiry` | `cert-expiry.ts` | Fires when a TLS certificate will expire within a configurable number of days. |
| `infra.cert_issues` | `cert-issues.ts` | Fires when a TLS certificate has validity issues such as invalid CN, self-signed, or chain errors. |
| `infra.tls_weakness` | `tls-weakness.ts` | Fires when a host exposes weak TLS configurations including deprecated protocol versions or weak cipher suites. |
| `infra.dns_change` | `dns-change.ts` | Fires when DNS records for a monitored host change from their baseline. |
| `infra.header_missing` | `header-missing.ts` | Fires when a required HTTP security header is absent from a scanned endpoint. |
| `infra.host_unreachable` | `host-unreachable.ts` | Fires when a monitored host fails TCP or HTTP reachability probes. |
| `infra.score_degradation` | `score-degradation.ts` | Fires when a host's aggregate security score drops by more than a configured percentage. |
| `infra.new_subdomain` | `new-subdomain.ts` | Fires when certificate transparency logs reveal a new subdomain under a monitored apex domain. |
| `infra.whois_expiry` | `whois-expiry.ts` | Fires when a domain registration will expire within a configurable number of days. |
| `infra.ct_new_entry` | `ct-new-entry.ts` | Fires when a new certificate is issued for a monitored domain as reported by CT logs. |

### AWS module (`moduleId: 'aws'`)

| ruleType | Source file | Description |
|---|---|---|
| `aws.event_match` | `event-match.ts` | Matches AWS CloudTrail events by event name, source service, and optional field-level conditions. |
| `aws.root_activity` | `root-activity.ts` | Fires when any CloudTrail event is attributed to the root account. |
| `aws.auth_failure` | `auth-failure.ts` | Fires when AWS authentication failures exceed a configurable threshold. |
| `aws.spot_eviction` | `spot-eviction.ts` | Fires when an EC2 Spot instance receives an interruption notice. |

### Registry module (`moduleId: 'registry'`)

| ruleType | Source file | Description |
|---|---|---|
| `registry.digest_change` | `digest-change.ts` | Fires when a monitored container image or package digest changes unexpectedly. |
| `registry.attribution` | `attribution.ts` | Fires when a package publish cannot be attributed to a known author or expected CI workflow. |
| `registry.security_policy` | `security-policy.ts` | Fires when a package violates configured security policy rules such as missing provenance or unsigned releases. |
| `registry.npm_checks` | `npm-checks.ts` | Fires when an npm package fails integrity or metadata checks (install scripts, suspicious maintainer changes). |
| `registry.anomaly_detection` | `anomaly-detection.ts` | Fires when package publish patterns deviate from historical baselines (unusual timing, frequency, or size). |

## Condition evaluation

Many evaluators delegate field-level condition checking to the shared `evaluateConditions()` function in `packages/shared/src/conditions.ts`. This function resolves dotted field paths from the event payload and applies comparison operators.

### Supported operators

| Operator | Behavior |
|---|---|
| `==` | Equality comparison |
| `!=` | Inequality comparison |
| `>` | Greater than |
| `<` | Less than |
| `>=` | Greater than or equal |
| `<=` | Less than or equal |

### Type coercion rules

The `compare()` function applies type coercion in the following order:

1. **BigInt**: Both operands are finite integers, converted to BigInt for exact comparison.
2. **Number**: Both operands are finite numbers (handles floats).
3. **Numeric strings**: Decimal numeric strings are parsed to Number. Hex strings (e.g., `0x...`) are excluded from numeric coercion to prevent nonsensical comparisons with blockchain addresses or git SHAs.
4. **ISO 8601 timestamps**: Strings matching the ISO 8601 pattern are parsed via `Date.parse()` for chronological ordering.
5. **Lexicographic**: All other values fall through to string comparison.

All conditions in a set must pass (AND logic). If the target field is `undefined` or `null`, the condition fails.
