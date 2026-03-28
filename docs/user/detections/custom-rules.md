# Custom detection rules

Use custom rules when the built-in templates do not match your specific monitoring requirements, or when you need to combine evaluators in ways that templates do not support.

## When to create custom rules vs. using templates

**Use a template** when one of the following applies:

- A pre-built template covers your exact use case.
- You need standard monitoring for a well-known pattern (large transfers, branch protection changes, certificate expiry).
- You want to deploy quickly and tune later.

**Create a custom rule** when:

- No template covers your scenario (for example, monitoring a proprietary contract function or a non-standard CloudTrail event).
- You need to combine multiple evaluators across different rule types in a single detection.
- You want full control over every rule parameter, condition, and action.
- You are building a detection that uses the `suppress` action alongside `alert` rules to implement allowlisting.

## Building a custom detection

1. Navigate to **Detections** in the sidebar.
2. Select **New Detection**.
3. Choose the module that matches your data source (**chain**, **github**, **registry**, **infra**, or **aws**).
4. Instead of selecting a template card, select the option to create a custom detection.
5. Enter a **Detection name** (required, 255 characters maximum) and an optional **Description** (1000 characters maximum).
6. Select a **Severity** level: `critical`, `high`, `medium`, or `low`.
7. Add one or more rules (see the following sections for details on choosing evaluators and configuring parameters).
8. Set a **Cooldown** period (0 to 1440 minutes) to control how frequently the detection can fire.
9. Assign **Notification channels** to receive alerts when the detection triggers.
10. Select **Create Detection**.

## Choosing the right evaluator

Each rule in a detection uses an evaluator. Evaluators are the functions that inspect incoming events and determine whether a condition is met. The evaluator you choose depends on the data source and the pattern you want to detect.

### Blockchain evaluators

| Evaluator | Rule type | Use case |
|---|---|---|
| Event Match | `chain.event_match` | Match on-chain events by Solidity signature with optional decoded parameter conditions. Also supports contract creation detection. |
| Function Call Match | `chain.function_call_match` | Match transactions by 4-byte function selector with optional argument filters. |
| Windowed Count | `chain.windowed_count` | Count event occurrences in a sliding time window, optionally grouped by a decoded field. Alert above a threshold. |
| Windowed Sum | `chain.windowed_sum` | Sum a numeric event field in a sliding window. Alert when the total exceeds a threshold. |
| Windowed Spike | `chain.windowed_spike` | Compare recent event rate to a baseline period. Alert when the rate increases by a configured percentage. |
| Balance Track | `chain.balance_track` | Poll native or ERC-20 balance and alert on minimum, maximum, percentage change, or threshold conditions. |
| State Poll | `chain.state_poll` | Read an EVM storage slot on a schedule and alert when the value changes or matches a condition. |
| View Call | `chain.view_call` | Call a read-only contract function on a schedule and evaluate the return value. |

### GitHub evaluators

| Evaluator | Rule type | Use case |
|---|---|---|
| Repository Visibility | `github.repo_visibility` | Detect when a repository is made public or private. |
| Member Change | `github.member_change` | Detect member additions, removals, and role changes. |
| Branch Protection | `github.branch_protection` | Detect edits or deletions of branch protection rules. |
| Force Push | `github.force_push` | Detect force pushes to specified branches. |
| Deploy Key | `github.deploy_key` | Detect deploy key creation and deletion. |
| Secret Scanning | `github.secret_scanning` | Detect new secret scanning alerts. |
| Organization Settings | `github.org_settings` | Detect organization and team setting changes. |

### Registry evaluators

| Evaluator | Rule type | Use case |
|---|---|---|
| Digest Change | `registry.digest_change` | Detect Docker image digest changes, new tags, and tag removals. |
| Attribution | `registry.attribution` | Verify that changes come from allowed CI workflows, actors, and branches. |
| Security Policy | `registry.security_policy` | Enforce signature, provenance, and digest pinning requirements. |
| npm Checks | `registry.npm_checks` | Detect install scripts, major version jumps, maintainer changes, and version events. |
| Anomaly Detection | `registry.anomaly_detection` | Detect rapid change rates, off-hours activity, and pusher allowlist violations. |

### Infrastructure evaluators

| Evaluator | Rule type | Use case |
|---|---|---|
| Certificate Expiry | `infra.cert_expiry` | Alert when a certificate expires within a threshold number of days. |
| Certificate Issues | `infra.cert_issues` | Detect chain errors, self-signed certificates, weak keys, and SHA-1 usage. |
| TLS Weakness | `infra.tls_weakness` | Detect legacy TLS versions and weak cipher suites. |
| Header Missing | `infra.header_missing` | Detect missing security response headers (HSTS, CSP, etc.). |
| DNS Change | `infra.dns_change` | Detect DNS record modifications. |
| New Subdomain | `infra.new_subdomain` | Detect newly discovered subdomains. |
| WHOIS Expiry | `infra.whois_expiry` | Alert when domain registration approaches expiry. |
| CT New Entry | `infra.ct_new_entry` | Detect new Certificate Transparency log entries. |
| Host Unreachable | `infra.host_unreachable` | Alert on host timeouts after consecutive probe failures. |
| Score Degradation | `infra.score_degradation` | Alert when a host's security score drops below a minimum or decreases sharply. |

### AWS evaluators

| Evaluator | Rule type | Use case |
|---|---|---|
| Root Activity | `aws.root_activity` | Detect any API call made by the root account. |
| Auth Failure | `aws.auth_failure` | Detect console login failures and root logins. |
| Event Match | `aws.event_match` | Match CloudTrail events by event name and source. Supports error-only filtering. |
| Spot Eviction | `aws.spot_eviction` | Detect spot instance interruption warnings. |

## Configuring rule parameters

Every rule requires a `ruleType` and a `config` object. The config structure depends on the evaluator.

**Common parameters across evaluators:**

- **action** -- Determines what happens when the rule matches. Options: `alert` (create an alert and notify), `log` (record the match without alerting), `suppress` (prevent the detection from firing even if other rules match).
- **priority** -- An integer from 0 to 100. Rules with lower priority numbers are evaluated first. Default is 50.

**Blockchain-specific parameters:**

- `eventSignature` -- The full Solidity event signature (for example, `Transfer(address,address,uint256)`).
- `conditions` -- An array of field/operator/value objects applied to decoded event parameters.
- `windowMinutes` -- The size of the sliding time window for windowed evaluators.
- `threshold` -- The count or sum value that triggers the rule.
- `groupByField` -- A decoded field name used to partition counts or sums per unique value.
- `slot` -- The hex-encoded EVM storage slot for state poll evaluators.
- `pollIntervalMs` -- Polling frequency in milliseconds (minimum 10,000).

**Registry-specific parameters:**

- `tagPatterns` -- Glob patterns for image tags or npm dist-tags (for example, `["latest", "v*"]`).
- `changeTypes` -- The types of changes to watch (for example, `digest_change`, `new_tag`, `version_published`).
- `attributionCondition` -- Set to `must_match` to require CI attribution.
- `maxChanges` and `windowMinutes` -- Rate limiting parameters for anomaly detection.
- `allowedHoursStart` / `allowedHoursEnd` / `timezone` -- Business hours boundaries for off-hours detection.

**AWS-specific parameters:**

- `eventNames` -- An array of CloudTrail event names to match (for example, `["CreateUser", "DeleteUser"]`).
- `eventSources` -- An array of AWS service event sources (for example, `["iam.amazonaws.com"]`).
- `errorEventsOnly` -- Set to `true` to match only events with error codes.
- `errorCodes` -- An array of specific error codes to match (for example, `["AccessDenied"]`).
- `alertTitle` -- A template string for the alert title. Supports `{{eventName}}`, `{{principalId}}`, and `{{awsRegion}}` placeholders.

## Setting severity and cooldowns

**Severity** is set at the detection level and applies to all alerts generated by the detection. Choose the level that matches your operational response expectations:

| Level | Meaning | Recommended response |
|---|---|---|
| Critical | Immediate security threat or active exploitation. | Page on-call; respond within minutes. |
| High | Significant risk that needs prompt attention. | Investigate within the hour. |
| Medium | Moderate risk or informational findings that warrant review. | Review within the business day. |
| Low | Low-risk informational events for audit trails. | Review in next triage cycle. |

**Cooldown** prevents alert fatigue by suppressing duplicate alerts from the same detection for a configurable period. Set the cooldown in minutes (0 to 1440):

- **0 minutes** -- No cooldown; the detection fires on every matching event.
- **5 minutes** (default for template-based detections) -- Appropriate for most monitoring scenarios.
- **60 minutes** -- Useful for high-volume detections where you want at most one alert per hour.
- **1440 minutes** (24 hours) -- Maximum value; use for daily summary-style detections.

## Testing custom rules

Before deploying a custom detection to production, validate it using the dry-run test endpoint.

1. Navigate to the detection detail page.
2. Select **Test Detection**.
3. Provide a test event in one of two ways:
   - **By event ID**: Enter the UUID of an existing event in your organization. Sentinel loads the event payload and evaluates it against the detection rules.
   - **By inline event**: Provide an event type and a JSON payload object. Sentinel constructs a synthetic event and evaluates it.
4. Review the test results, which indicate:
   - Whether the detection **would trigger** an alert.
   - Whether the event was **suppressed** by a suppress rule.
   - The list of **candidate** rules that matched.
   - The number of **rules evaluated**.

Testing does not create actual alerts or send notifications.

## Best practices for rule management

**Start with templates, customize later.** Deploy a template-based detection first. After observing its behavior for a period, edit the detection to adjust thresholds and add custom rules.

**Use descriptive names.** Name detections after the specific threat or scenario they address, not after the evaluator type. For example, use "Treasury contract drainage alert" instead of "Windowed count rule."

**Layer rules by priority.** Within a detection, use priority values to control evaluation order. Place suppress rules at low priority numbers (higher precedence) so they can prevent false-positive alerts before alert rules execute.

**Set appropriate cooldowns.** High-frequency detections (such as transfer monitors on busy contracts) benefit from cooldowns of 15 to 60 minutes. Low-frequency detections (such as proxy upgrade monitors) can use a cooldown of 0 because they fire rarely.

**Keep detections focused.** Each detection should address a single threat scenario or a closely related group of checks. Avoid bundling unrelated rules into a single detection, because it makes triage harder and cooldowns apply to the entire detection.

**Archive instead of deleting.** When you no longer need a detection, archive it (soft delete) rather than deleting rule data. Archiving preserves the alert history for audit purposes.

**Review periodically.** Schedule regular reviews of your detection library. Disable or tune detections that consistently produce false positives, and add new detections as your attack surface changes.
