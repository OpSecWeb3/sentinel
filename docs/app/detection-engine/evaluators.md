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

### Platform evaluator (`moduleId: 'platform'`)

| ruleType | Source file | Description |
|---|---|---|
| `platform.compound` | `packages/shared/src/evaluators/compound.ts` | Combines multiple sub-rules with AND, OR, or N-of-M (threshold) logic. Resolves sub-evaluators from the shared registry and returns a single alert with the highest severity from matched sub-rules. |

## Complete evaluator reference

### GitHub module (`moduleId: 'github'`)

#### `github.repo_visibility`

**Source**: `modules/github/src/evaluators/repo-visibility.ts`

**Detects**: Repository visibility changes (public/private transitions). Fires on `github.repository.visibility_changed` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `alertOn` | `'publicized' \| 'privatized' \| 'any'` | `'publicized'` | Which direction of visibility change to alert on. |
| `excludeRepos` | `string[]` | `[]` | Glob patterns for repository names to ignore. |

**Example config**:

```json
{
  "alertOn": "publicized",
  "excludeRepos": ["org/archived-*", "org/public-*"]
}
```

**Alert trigger**: When a repository's `action` matches the configured direction and the repository name does not match any exclusion pattern. Severity: `critical`.

---

#### `github.branch_protection`

**Source**: `modules/github/src/evaluators/branch-protection.ts`

**Detects**: Branch protection rule modifications. Fires on events starting with `github.branch_protection.`.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `alertOnActions` | `('created' \| 'edited' \| 'deleted')[]` | `['edited', 'deleted']` | Which protection actions trigger the rule. |
| `watchBranches` | `string[]` | `[]` | Branch name glob patterns. Empty watches all branches. |

**Example config**:

```json
{
  "alertOnActions": ["edited", "deleted"],
  "watchBranches": ["main", "release/*"]
}
```

**Alert trigger**: When the action matches and the branch rule's pattern matches at least one watch pattern (via `minimatch`). Severity: `critical` for deletions, `high` for edits.

---

#### `github.member_change`

**Source**: `modules/github/src/evaluators/member-change.ts`

**Detects**: Membership changes in repositories and organizations. Fires on `github.member.*` and `github.organization.*` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `alertOnActions` | `string[]` | `['added', 'removed']` | Actions: `added`, `removed`, `edited`, `member_added`, `member_removed`, `member_invited`. |
| `watchRoles` | `string[]` | `[]` | Role filter. Empty watches all roles. |

**Alert trigger**: When the action matches and the member's role matches the watch list (if configured). Severity: `high`.

---

#### `github.deploy_key`

**Source**: `modules/github/src/evaluators/deploy-key.ts`

**Detects**: Deploy key lifecycle events. Fires on events starting with `github.deploy_key.`.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `alertOnActions` | `('created' \| 'deleted')[]` | `['created']` | Which key actions trigger the rule. |
| `alertOnWriteKeys` | `boolean` | `true` | When true, only alert on keys with write access (read_only = false). |

**Alert trigger**: When the action matches and the key's access level passes the write filter. Severity: `high` for write keys, `medium` for read-only.

---

#### `github.secret_scanning`

**Source**: `modules/github/src/evaluators/secret-scanning.ts`

**Detects**: GitHub secret scanning alerts. Fires on events starting with `github.secret_scanning.`.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `alertOnActions` | `('created' \| 'resolved' \| 'reopened')[]` | `['created']` | Which alert actions to monitor. |
| `secretTypes` | `string[]` | `[]` | Filter to specific secret types. Empty matches all types. |

**Alert trigger**: When the action matches and the secret type is in the watch list (if configured). Severity: `critical` for created, `medium` for resolved/reopened.

---

#### `github.force_push`

**Source**: `modules/github/src/evaluators/force-push.ts`

**Detects**: Force pushes to protected branches. Fires on `github.push` events where `payload.forced = true`.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `watchBranches` | `string[]` | `['main', 'master', 'release/*', 'production']` | Branch patterns to protect. |
| `alertOnAllForced` | `boolean` | `false` | Alert on force pushes to any branch. |

**Alert trigger**: When a push is forced, the ref is a branch (not a tag), and the branch matches at least one watch pattern. Severity: `critical`.

---

#### `github.org_settings`

**Source**: `modules/github/src/evaluators/org-settings.ts`

**Detects**: Organization and team events. Fires on `github.organization.*` and `github.team.*` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `watchActions` | `string[]` | `[]` | Actions to monitor. Empty watches all actions. |

**Alert trigger**: When the event action matches the watch list (if configured). Severity: `high` for member and team deletion events, `medium` for others.

---

### Chain module (`moduleId: 'chain'`)

#### `chain.event_match`

**Source**: `modules/chain/src/evaluators/event-match.ts`

**Detects**: On-chain log events matching a specific event signature. Handles two event types: `chain.event.matched` (pre-filtered by the block processor) and `chain.log` (raw log events matched by topic0).

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `eventSignature` | `string?` | -- | Solidity event signature (e.g., `Transfer(address,address,uint256)`). |
| `topic0` | `string?` | -- | Pre-computed keccak256 hash of the event signature. |
| `contractAddress` | `string?` | -- | Contract address filter (lowercase hex). |
| `conditions` | `Condition[]` | `[]` | Field-level conditions on decoded event arguments. |

**Example config**:

```json
{
  "eventSignature": "Transfer(address,address,uint256)",
  "contractAddress": "0x1234...abcd",
  "conditions": [
    { "field": "value", "operator": ">", "value": "1000000000000000000" }
  ]
}
```

**Alert trigger**: When the event signature (or topic0) matches, the contract address matches (if configured), and all field conditions pass. For `chain.event.matched` events, an additional guard verifies the event name matches the expected name derived from the signature. Severity: `high`. triggerType: `immediate`.

---

#### `chain.function_call_match`

**Source**: `modules/chain/src/evaluators/function-call-match.ts`

**Detects**: On-chain function calls by 4-byte selector matching. Fires on `chain.transaction` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `functionSignature` | `string` | -- | Function signature (e.g., `transfer(address,uint256)`). |
| `functionName` | `string?` | -- | Human-readable name for display. |
| `selector` | `string?` | -- | Pre-computed 4-byte selector. Derived from `functionSignature` if absent. |
| `contractAddress` | `string` | -- | Target contract address (lowercase hex). |
| `conditions` | `Condition[]` | `[]` | Conditions on decoded function arguments. |

**Alert trigger**: When the transaction's `to` address matches, the first 4 bytes of `input` match the selector, and all field conditions pass. Severity: `high`. triggerType: `immediate`.

---

#### `chain.windowed_count`

**Source**: `modules/chain/src/evaluators/windowed-count.ts`

**Detects**: High-frequency on-chain events within a sliding window. Fires on `chain.log` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `eventSignature` | `string?` | -- | Event signature to match. |
| `topic0` | `string?` | -- | Pre-computed topic0. |
| `contractAddress` | `string?` | -- | Optional contract address filter. |
| `windowMinutes` | `number` | `60` | Sliding window duration in minutes. |
| `threshold` | `number` | `5` | Alert when count reaches this value. |
| `groupByField` | `string?` | -- | Group counts by this decoded argument field. |

**Redis state**: Sorted set at `sentinel:wcount:{orgId}:{ruleId}[:{groupValue}]`. Members are event IDs; scores are wall-clock timestamps (Date.now()). Stale entries pruned on every evaluation via `ZREMRANGEBYSCORE`. TTL set to `windowMs` via `PEXPIRE`.

**Alert trigger**: When the count of events in the window reaches or exceeds the threshold. Severity: `high`. triggerType: `windowed`.

---

#### `chain.windowed_spike`

**Source**: `modules/chain/src/evaluators/windowed-spike.ts`

**Detects**: Rate spikes by comparing a short observation window against a longer baseline. Fires on `chain.log` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `eventSignature` | `string?` | -- | Event signature to match. |
| `topic0` | `string?` | -- | Pre-computed topic0. |
| `contractAddress` | `string?` | -- | Optional contract address filter. |
| `observationMinutes` | `number` | `5` | Recent window duration. |
| `baselineMinutes` | `number` | `60` | Historical baseline duration. |
| `increasePercent` | `number` | `200` | Minimum percentage increase to trigger. |
| `minBaselineCount` | `number` | `3` | Minimum events in baseline for valid comparison. |
| `groupByField` | `string?` | -- | Per-field spike detection. |

**Algorithm**: `baselineAvg = baselineCount / (baselineMs / observationMs)`, `spikePercent = ((currentCount - baselineAvg) / baselineAvg) * 100`. Triggers when `spikePercent >= increasePercent` and `baselineCount >= minBaselineCount`.

**Redis state**: Sorted set at `sentinel:wspike:{ruleId}[:{groupValue}]`. TTL set to `baselineMs`.

**Alert trigger**: When the observation window event rate exceeds the baseline average by the configured percentage. Severity: `critical`. triggerType: `windowed`.

---

#### `chain.windowed_sum`

**Source**: `modules/chain/src/evaluators/windowed-sum.ts`

**Detects**: Cumulative value thresholds across events in a sliding window. Fires on `chain.log` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `eventSignature` | `string?` | -- | Event signature to match. |
| `topic0` | `string?` | -- | Pre-computed topic0. |
| `contractAddress` | `string?` | -- | Optional contract address filter. |
| `sumField` | `string` | -- | Decoded argument field to sum (e.g., `value`). |
| `windowMinutes` | `number` | `60` | Sliding window duration. |
| `threshold` | `string` | -- | BigInt-compatible threshold string (e.g., `"1000000000000000000"`). |
| `operator` | `'gt' \| 'gte' \| 'lt' \| 'lte'` | `'gt'` | Comparison operator. |
| `groupByField` | `string?` | -- | Group sums by this field. |

**Redis state**: Sorted set at `sentinel:wsum:{orgId}:{ruleId}[:{groupValue}]`. Members are `{eventId}:{value}` strings; scores are wall-clock timestamps.

**Alert trigger**: When the sum of all values in the window satisfies the threshold condition. Severity: `high`. triggerType: `windowed`.

---

#### `chain.balance_track`

**Source**: `modules/chain/src/evaluators/balance-track.ts`

**Detects**: Balance changes on monitored accounts. Fires on `chain.balance_snapshot` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `conditionType` | `'percent_change' \| 'threshold_above' \| 'threshold_below'` | -- | Type of balance condition. |
| `value` | `string` | -- | Threshold: percentage (0-100) or absolute wei string. |
| `windowMs` | `number?` | -- | Rolling window for windowed percent_change comparisons. |
| `bidirectional` | `boolean` | `false` | When true, triggers on both drops and rises for percent_change. |

**Redis state**: Previous value at `sentinel:prev:{ruleId}`. Windowed snapshots in sorted set at `sentinel:balsnapshots:{ruleId}` (members are `{timestamp}:{value}` to avoid dedup of identical balances).

**Alert trigger**: When the balance condition is met. For `percent_change`, the default (bidirectional=false) triggers only on drops. Severity: `high`. triggerType: `immediate`.

---

#### `chain.state_poll`

**Source**: `modules/chain/src/evaluators/state-poll.ts`

**Detects**: EVM storage slot value changes. Fires on `chain.state_snapshot` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `conditionType` | `'changed' \| 'threshold_above' \| 'threshold_below' \| 'windowed_percent_change'` | -- | Type of state condition. |
| `value` | `string?` | -- | Threshold value (required for threshold conditions). |
| `percentThreshold` | `number?` | -- | Percent deviation threshold (for windowed_percent_change). |
| `windowSize` | `number` | `100` | Number of historical snapshots for rolling mean (1-500). |

**Redis state**: Previous value at `sentinel:state:prev:{ruleId}`. Recent values list at `sentinel:state:recent:{ruleId}` (capped at windowSize via LTRIM).

**Alert trigger**: When the state condition is met. For `windowed_percent_change`, computes rolling mean from previous values (excluding current) and triggers when deviation exceeds the threshold. Severity: `high`. triggerType: `deferred`.

---

#### `chain.view_call`

**Source**: `modules/chain/src/evaluators/view-call.ts`

**Detects**: Contract view function return value conditions. Fires on `chain.view_call_result` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `contractAddress` | `string` | -- | Contract address to call. |
| `functionSignature` | `string` | -- | View function signature. |
| `functionName` | `string?` | -- | Human-readable name for display. |
| `conditions` | `Condition[]` | `[]` | Conditions on return values. |
| `resultField` | `string` | `'result'` | Field name for single-return-value functions. |

**Alert trigger**: When the contract address matches and all conditions pass against the return values. Severity: `high`. triggerType: `deferred`.

---

### Infrastructure module (`moduleId: 'infra'`)

#### `infra.cert_expiry`

**Source**: `modules/infra/src/evaluators/cert-expiry.ts`

**Detects**: TLS certificates approaching expiry. Fires on `infra.cert.expiring` and `infra.cert.expired` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `thresholdDays` | `number` | `30` | Alert when certificate expires within this many days. |

**Severity tiers**: <=7 days: `critical`, <=14 days: `high`, <=30 days: `medium`.

---

#### `infra.cert_issues`

**Source**: `modules/infra/src/evaluators/cert-issues.ts`

**Detects**: Certificate validity issues. Fires on `infra.cert.issue` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `issueTypes` | `string[]` | `[]` | Issue types to alert on: `chain_error`, `self_signed`, `weak_key`, `sha1_signature`, `revoked`. Empty matches all. |

**Severity map**: `revoked`/`chain_error`: `critical`, `self_signed`/`weak_key`: `high`, `sha1_signature`: `medium`.

---

#### `infra.tls_weakness`

**Source**: `modules/infra/src/evaluators/tls-weakness.ts`

**Detects**: Weak TLS configurations. Fires on `infra.tls.weakness` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `alertOnLegacyVersions` | `boolean` | `true` | Alert on TLS 1.0/1.1. |
| `alertOnWeakCiphers` | `boolean` | `true` | Alert on weak cipher suites. |
| `alertOnMissingTls13` | `boolean` | `false` | Alert when TLS 1.3 is not supported. |

---

#### `infra.dns_change`

**Source**: `modules/infra/src/evaluators/dns-change.ts`

**Detects**: DNS record changes. Fires on `infra.dns.change` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `watchRecordTypes` | `string[]` | `[]` | DNS record types to watch (A, AAAA, MX, NS, TXT). Empty watches all. |
| `watchChangeTypes` | `('added' \| 'modified' \| 'removed')[]` | `[]` | Change types to alert on. Empty matches all. |

**Alert trigger**: Filters the event's `changes` array by configured record types and change types. NS record changes or critical-flagged changes elevate severity to `critical`.

---

#### `infra.header_missing`

**Source**: `modules/infra/src/evaluators/header-missing.ts`

**Detects**: Missing HTTP security headers. Fires on `infra.header.missing` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `requiredHeaders` | `string[]` | `[]` | Headers to require. Empty checks all known: HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy. |

---

#### `infra.host_unreachable`

**Source**: `modules/infra/src/evaluators/host-unreachable.ts`

**Detects**: Host availability issues. Fires on `infra.host.unreachable` and `infra.host.slow` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `thresholdMs` | `number` | `5000` | Response time threshold for slow-response alerts. |
| `consecutiveFailures` | `number` | `2` | Consecutive failures before unreachable alert. |

---

#### `infra.new_subdomain`

**Source**: `modules/infra/src/evaluators/new-subdomain.ts`

**Detects**: Newly discovered subdomains. Fires on `infra.subdomain.discovered` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `ignorePatterns` | `string[]` | `[]` | Subdomain patterns to ignore. Simple glob (leading/trailing wildcards). |

---

#### `infra.ct_new_entry`

**Source**: `modules/infra/src/evaluators/ct-new-entry.ts`

**Detects**: New Certificate Transparency log entries. Fires on `infra.ct.new_entry` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `ignorePatterns` | `string[]` | `[]` | Issuer name patterns to ignore. Simple glob. |

---

#### `infra.whois_expiry`

**Source**: `modules/infra/src/evaluators/whois-expiry.ts`

**Detects**: Domain registration approaching expiry. Fires on `infra.whois.expiring` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `thresholdDays` | `number` | `30` | Alert when domain expires within this many days. |

**Severity tiers**: <=7 days: `critical`, <=14 days: `high`, <=30 days: `medium`.

---

#### `infra.score_degradation`

**Source**: `modules/infra/src/evaluators/score-degradation.ts`

**Detects**: Security score drops. Fires on `infra.score.degraded` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `minScore` | `number` | `70` | Alert when score falls below this. |
| `minDrop` | `number` | `10` | Alert when score drops by this many points. |
| `mode` | `'score' \| 'drop' \| 'both'` | `'both'` | Which condition(s) to apply (OR logic for `both`). |

---

### AWS module (`moduleId: 'aws'`)

#### `aws.event_match`

**Source**: `modules/aws/src/evaluators/event-match.ts`

**Detects**: CloudTrail events matching configurable field filters. Fires on any event with type starting with `aws.`.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `eventNames` | `string[]` | `[]` | CloudTrail event name patterns (glob via minimatch). Empty matches all. |
| `eventSources` | `string[]` | `[]` | Event sources (e.g., `iam.amazonaws.com`). |
| `userTypes` | `string[]` | `[]` | CloudTrail `userIdentity.type` values (Root, IAMUser, AssumedRole). |
| `principalArnPatterns` | `string[]` | `[]` | ARN patterns for the caller (glob + substring). |
| `errorEventsOnly` | `boolean` | `false` | Only match events with an error code. |
| `errorCodes` | `string[]` | `[]` | Specific CloudTrail error codes to match. |
| `regions` | `string[]` | `[]` | AWS regions to watch. Empty matches all. |
| `alertTitle` | `string` | `'AWS CloudTrail: {{eventName}} by {{principalId}}'` | Template supporting `{{eventName}}`, `{{principalId}}`, `{{awsRegion}}`, `{{accountId}}`. |

---

#### `aws.root_activity`

**Source**: `modules/aws/src/evaluators/root-activity.ts`

**Detects**: Any API action by the AWS root account. Fires on any event with type starting with `aws.` where `userIdentity.type === 'Root'`.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `excludeEventNames` | `string[]` | `[]` | Event names to suppress (e.g., billing console actions). |
| `includeFailedActions` | `boolean` | `true` | Include root events that resulted in errors. |

**Alert trigger**: Always fires for root account actions unless excluded. Severity: `critical`.

---

#### `aws.auth_failure`

**Source**: `modules/aws/src/evaluators/auth-failure.ts`

**Detects**: Console login failures, root logins, and MFA-less logins. Fires on `aws.signin.ConsoleLogin` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `alertOnLoginFailure` | `boolean` | `true` | Alert on failed console logins. |
| `alertOnRootLogin` | `boolean` | `true` | Alert on successful root console logins. |
| `alertOnNoMfa` | `boolean` | `false` | Alert on logins without MFA. |

**Alert trigger**: Checks `responseElements.ConsoleLogin` for failure, `userIdentity.type` for root, and `additionalEventData.MFAUsed` for MFA status. Severity: `critical` for root failures, `high` for non-root failures, `medium` for no-MFA.

---

#### `aws.spot_eviction`

**Source**: `modules/aws/src/evaluators/spot-eviction.ts`

**Detects**: EC2 Spot instance interruption notices. Fires on `aws.ec2.SpotInstanceInterruption` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `watchInstanceIds` | `string[]` | `[]` | Specific instance IDs. Empty watches all. |
| `regions` | `string[]` | `[]` | AWS regions. Empty watches all. |
| `severity` | `'low' \| 'medium' \| 'high' \| 'critical'` | `'medium'` | Configurable alert severity. |

---

### Registry module (`moduleId: 'registry'`)

#### `registry.digest_change`

**Source**: `modules/registry/src/evaluators/digest-change.ts`

**Detects**: Docker image and npm package changes. Handles 10 event types across `registry.docker.*` and `registry.npm.*`.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `tagPatterns` | `string[]` | `['*']` | Glob patterns for tags/versions to monitor. |
| `changeTypes` | `string[]` | `['digest_change', 'new_tag', 'tag_removed']` | Which change types trigger this rule: `digest_change`, `new_tag`, `tag_removed`, `new_version`, `version_unpublished`, `maintainer_changed`, `dist_tag_updated`, `version_published`. |
| `expectedTagPattern` | `string?` | `null` | Alert when a new tag does NOT match this pattern. |

---

#### `registry.npm_checks`

**Source**: `modules/registry/src/evaluators/npm-checks.ts`

**Detects**: npm-specific security concerns. Handles `registry.docker.digest_change`, `registry.docker.new_tag`, and several `registry.npm.*` events.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `tagPatterns` | `string[]` | `['*']` | Tag patterns to check. |
| `changeTypes` | `string[]` | `['version_published']` | Change types to check. |
| `checkInstallScripts` | `boolean` | `false` | Alert on preinstall/install/postinstall scripts. |
| `checkMajorVersionJump` | `boolean` | `false` | Alert on unexpected major semver increments. |

**Alert trigger**: Fires when install scripts are detected (`critical`) or a major version jump occurs (`high`). Returns null if neither npm-specific check triggers.

---

#### `registry.attribution`

**Source**: `modules/registry/src/evaluators/attribution.ts`

**Detects**: CI/CD attribution policy violations. Checks workflow, actor, and branch against allowlists.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `tagPatterns` | `string[]` | `['*']` | Tags to check. |
| `changeTypes` | `string[]` | `['digest_change']` | Change types to gate on. |
| `attributionCondition` | `'must_match' \| 'must_not_match'` | -- | Whether attribution must be present or absent. |
| `workflows` | `string[]` | `[]` | Allowed CI workflow filenames. |
| `actors` | `string[]` | `[]` | Allowed actor logins. |
| `branches` | `string[]` | `[]` | Allowed branch patterns (glob). |

**Alert trigger**: For `must_match`, fires when attribution is absent or does not match the allowed sets. For `must_not_match`, fires when attribution matches the criteria. Pending attribution produces a `deferred` trigger type. Severity: `critical` for unattributed changes, `high` for unexpected attribution.

---

#### `registry.security_policy`

**Source**: `modules/registry/src/evaluators/security-policy.ts`

**Detects**: Missing signatures, provenance, and digest pinning violations.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `tagPatterns` | `string[]` | `['*']` | Tags to enforce. |
| `changeTypes` | `string[]` | `['digest_change', 'new_tag']` | Change types to check. |
| `requireSignature` | `boolean` | `false` | Require cosign/Sigstore signature. |
| `requireProvenance` | `boolean` | `false` | Require SLSA provenance attestation. |
| `provenanceSourceRepo` | `string?` | `null` | Expected source repo in provenance (case-insensitive substring). |
| `pinnedDigest` | `string?` | `null` | Exact digest the artifact must match. |

**Alert trigger**: Fires on the first failed check (pinned digest, then signature, then provenance). Returns null if all configured checks pass.

---

#### `registry.anomaly_detection`

**Source**: `modules/registry/src/evaluators/anomaly-detection.ts`

**Detects**: Anomalous release patterns including unauthorized pushers, source mismatches, off-hours activity, and rapid changes.

**Config schema**:

| Field | Type | Default | Description |
|---|---|---|---|
| `tagPatterns` | `string[]` | `['*']` | Tags to monitor. |
| `changeTypes` | `string[]` | `['digest_change', 'new_tag', 'tag_removed']` | Change types to check. |
| `pusherAllowlist` | `string[]` | `[]` | Allowed pusher usernames. |
| `expectedSource` | `string?` | `null` | Expected detection source (e.g., `'webhook'`). |
| `maxChanges` | `number?` | `null` | Rate limit: max changes per window. |
| `windowMinutes` | `number` | `60` | Rate limit window size. |
| `allowedHoursStart` | `string?` | `null` | Allowed window start (HH:MM format). |
| `allowedHoursEnd` | `string?` | `null` | Allowed window end (HH:MM format). |
| `timezone` | `string` | `'UTC'` | IANA timezone for the time window. |
| `allowedDays` | `number[]` | `[1,2,3,4,5]` | ISO day-of-week numbers (1=Mon..7=Sun). |

**Alert trigger**: Checks are applied in order: pusher allowlist, source mismatch, time window, rate limit. The first violation produces an alert. Supports midnight-crossing time windows (e.g., 22:00-06:00). Rate limiting uses a Redis sorted set at `sentinel:registry:rate:{keyPrefix}:{ruleId}`.

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
