# Detection Engine

This document explains what a detection is, how detection rules work, how templates simplify rule creation, and how to choose the right severity and cooldown settings for your rules.

## What Is a Detection?

A **detection** is a named, configurable rule that tells Sentinel what security condition to watch for within a specific module. When Sentinel receives an event that matches a detection's conditions, it creates an alert.

Think of a detection as a standing security question: "Does this event represent a repository being made public?" or "Has this contract address received a transaction over 10 ETH from an unknown sender?" Sentinel evaluates that question continuously against every event that arrives from the relevant module.

A detection is not a one-time check. It remains active until you pause or archive it, evaluating every new event from its module in real time.

---

## Detection Components

Every detection has the following properties:

| Property | Description |
|---|---|
| **Name** | A human-readable label that appears in alert titles and the detections list. Maximum 255 characters. |
| **Module** | The security domain this detection monitors: `github`, `chain`, `infra`, `registry`, or `aws`. |
| **Severity** | The criticality level assigned to alerts this detection produces: `critical`, `high`, `medium`, or `low`. |
| **Status** | The current state of the detection: `active`, `paused`, `error`, or `disabled` (archived). |
| **Notification channels** | The channels to notify when an alert fires. A detection can be linked to zero or more channels. |
| **Cooldown (minutes)** | The minimum number of minutes that must elapse before this detection fires again. Configurable from 0 (no cooldown) to 1,440 (24 hours). |
| **Rules** | One or more rule objects that define the specific conditions to evaluate. See below. |
| **Template** | If the detection was created from a template, the template slug is recorded for reference. |
| **Configuration** | A JSON object holding template inputs and detection-level overrides (such as host scope for infrastructure detections or artifact name for registry detections). |

---

## Rules: The Conditions That Trigger Alerts

Each detection contains one or more **rules**. A rule specifies:

- **Rule type** -- The specific evaluator to run (for example, `github.repo_visibility`, `chain.large_transaction`, `registry.digest_change`). Each module defines its own set of rule types.
- **Configuration** -- Rule-type-specific settings that narrow the match (for example, `alertOn: "publicized"` to fire only when repositories are made public, not private).
- **Action** -- What to do when the rule matches:
  - `alert` -- Create an alert and dispatch notifications. This is the default.
  - `log` -- Record the match but do not create an alert. Useful for baselining a new rule before turning it on.
  - `suppress` -- If this rule matches, stop evaluating all remaining rules for this event. Use this to create explicit exceptions (for example, "ignore visibility changes on the `public-docs` repository").
- **Priority** -- A number from 0 to 100 that controls evaluation order. Rules with lower priority numbers are evaluated first. Default is 50.
- **Resource filter** -- An optional include/exclude filter using glob patterns (via minimatch syntax) that scopes the rule to specific resources. For example, you can include only `*.prod.*` hostnames or exclude `test-*` repositories.

### Evaluation Order and Short-Circuit Behavior

When an event arrives, Sentinel loads all active rules for your organization and the event's module, ordered by priority (lowest number first). Rules are evaluated sequentially:

1. If a rule with action `suppress` matches, evaluation stops immediately. No alert is created for this event, regardless of what other rules might match.
2. If a rule with action `alert` matches, an alert candidate is produced. Evaluation continues to check remaining rules.
3. If a rule with action `log` matches, the event is recorded but no alert candidate is produced.

This ordering means you can place a suppress rule at a low priority number (evaluated first) to create exceptions that take precedence over alert rules.

### Resource Filters

Resource filters let you scope a rule to specific resources without creating separate detections. A resource filter has two optional fields:

- **include** -- A list of glob patterns. The event's resource ID must match at least one pattern.
- **exclude** -- A list of glob patterns. If the event's resource ID matches any pattern, the rule is skipped. Exclude takes precedence over include.

For example, to monitor only production servers:

- Include: `*.prod.*`
- Exclude: `staging-*`

At the detection level, you can also set a **host scope** (for infrastructure detections) that applies to all rules in the detection. Host scope uses the same glob matching.

---

## Templates: Pre-Built Detections

Templates are the fastest way to add a detection. Each template encodes a security best practice for a specific module and event type. A template defines:

- The module and one or more rule types
- Sensible default configuration values with `{{placeholder}}` tokens for user-provided inputs
- An input form so you can customize the rule without knowing the underlying rule schema
- A recommended severity level
- A category for organizational grouping

When you create a detection from a template, Sentinel interpolates your form inputs into the rule configurations. Placeholder tokens like `{{threshold}}` are replaced with your values. If a placeholder is the entire value, it is replaced with the typed value (number, boolean, array). If it is embedded in a larger string, it is replaced as a string.

### Available Template Categories

Templates are organized by module and category. The GitHub module includes categories such as:

- **access-control** -- Member changes, team permissions, repository visibility
- **code-protection** -- Branch protection, secret scanning
- **secrets** -- Secret exposure detection
- **organization** -- Organization-level settings changes
- **comprehensive** -- Multi-rule templates covering broad attack surfaces

The AWS module includes categories such as:

- **identity** -- IAM changes and privilege escalation
- **defense-evasion** -- CloudTrail disabling, log deletion
- **network** -- Security group and VPC changes
- **data** -- S3 and data store access changes
- **compute** -- EC2 and Lambda changes
- **reconnaissance** -- Enumeration and discovery activity
- **comprehensive** -- Broad AWS security coverage

Other modules (chain, infra, registry) derive their categories dynamically from the available templates. The chain module also supports keyword search across templates.

### Template Input Types

Templates define typed inputs that map to specific form controls:

| Input Type | Form Control | Example Use |
|---|---|---|
| `text` | Single-line text field | Repository name, label |
| `number` | Numeric field with optional min/max | Threshold value, timeout |
| `boolean` | True/false toggle | Enable/disable a feature |
| `select` | Dropdown | Choose from predefined options |
| `string-array` | Multi-line textarea | List of addresses, patterns |
| `address` | Text field (monospace) | Blockchain address |
| `contract` | Dropdown of registered contracts | Contract selector |
| `network` | Dropdown of registered networks | Network selector |

Some inputs are conditionally visible -- they appear only after a related input is filled in. Required inputs are marked with a red asterisk.

### Creating a Detection from a Template

1. Navigate to **detections** in the sidebar.
2. Click **+ New Detection**.
3. Select the module tab (**[github]**, **[infra]**, **[chain]**, **[registry]**, or **[aws]**).
4. Optionally, filter by category or search (chain module only).
5. Click a template card to select it.
6. Fill in the required inputs and adjust the detection name, severity, and cooldown as needed.
7. Click **Create Detection**.

The detection is created in the `active` state and begins evaluating events immediately.

---

## Detection Lifecycle

A detection moves through the following states:

**Active** -- The detection is running and evaluating incoming events. All of its rules are active. Shown as **[active]** in green in the detection list.

**Paused** -- An admin or editor manually paused the detection. No events are evaluated while paused. All rules under the detection are also paused. When you resume a paused detection, both the detection and its rules return to active. Shown as **[paused]** in yellow. Pausing is useful when you know a maintenance window will cause many expected alerts that you want to silence temporarily.

**Error** -- The detection's rule encountered a processing error. Check the detection's details for more information and update the configuration to resolve it. Shown as **[error]** in red.

**Disabled (archived)** -- An admin has archived the detection. Archived detections cannot be updated or reactivated through the standard controls -- only a **[view]** link is available. All rules under an archived detection are also disabled. Archiving is a soft delete -- the detection and its alert history remain in the database for audit purposes. Shown as **[archived]** in grey.

### Managing Detections

The **Detections** page provides the following controls for each detection:

- **[pause]** / **[resume]** -- Toggle a detection between active and paused states.
- **[edit]** -- Navigate to the detection edit page to modify its configuration.
- **[archive]** -- Soft-delete the detection. Sentinel asks for confirmation before archiving.

You can filter the detection list by **status** (active, paused, archived), **severity** (critical, high, medium, low), and **module** (chain, github, infra, registry). A search bar lets you find detections by name.

---

## Severity Levels

Every alert inherits its severity from the detection that produced it. The detection's severity overrides any default from the evaluator. Use these definitions to calibrate your detections:

### Critical

**Use when:** The event represents an imminent, high-impact threat that requires immediate human response -- something that should wake someone up at night if it happens.

Examples:
- A repository is made public (potential code exposure)
- A smart contract's ownership is transferred to an unknown address
- An admin account is added to the GitHub organization by an unknown actor
- CloudTrail logging is disabled in an AWS account

### High

**Use when:** The event is likely a security issue or a significant deviation from expected behavior, but the blast radius or immediacy is lower than critical. Should be reviewed the same day.

Examples:
- Branch protection rules are disabled
- A Docker image tag changes to an unexpected digest
- An IAM policy is attached to a user
- A high-value transaction occurs on a monitored contract

### Medium

**Use when:** The event is worth knowing about and investigating, but it may have a legitimate explanation. Should be triaged within a day or two.

Examples:
- A new npm package version is published from an unrecognized machine
- A new Docker tag appears on a monitored image
- A team member's repository access level changes
- An SSL certificate is approaching expiry

### Low

**Use when:** The event is informational -- useful for audit trails and compliance, but not necessarily a sign of a security incident.

Examples:
- A team member joins or leaves a repository
- A routine CI deployment is recorded
- A secret scanning alert is resolved

---

## Cooldown: Preventing Alert Fatigue

A **cooldown** is a configurable suppression window on a detection. When a detection fires, Sentinel starts a cooldown timer. If the same detection matches another event before the timer expires, the match is suppressed and no new alert is created. Once the cooldown period elapses, the detection can fire again.

### How Cooldown Works

Cooldown is enforced per detection per rule per resource. This means:

- If a detection has multiple rules, each rule tracks its own cooldown independently.
- If events carry different resource IDs (for example, different contract addresses or hostnames), cooldowns are tracked independently per resource. A cooldown on `contract-A` does not suppress an alert for `contract-B`.

Technically, cooldown is implemented using Redis `SET NX PX` (atomic set-if-not-exists with a millisecond TTL). If Redis is unavailable, the engine falls back to a database-level timestamp check on the rule's `lastTriggeredAt` column.

### When to Use Cooldown

- Set a non-zero cooldown (5-30 minutes) for detections that monitor high-frequency events, such as a Docker image tag change detection on a busy CI/CD pipeline.
- Leave the cooldown at 0 for detections on rare, high-severity events where every instance matters (for example, a repository visibility change or a contract ownership transfer).
- For windowed correlation rules, cooldown prevents repeated correlated alerts if the same pattern recurs rapidly.

### Cooldown Example

A detection with a 30-minute cooldown fires at 14:00. A second matching event arrives at 14:15. The second event is still stored as a raw event record, but no alert is created. If a third matching event arrives at 14:35 (35 minutes after the first alert), a new alert is created because the cooldown has elapsed.

---

## Dry-Run Testing

You can test whether a detection would fire against a specific event without creating a real alert. Use the test endpoint on a detection:

- Submit an existing event ID from your event history, or provide a synthetic event with an event type and payload.
- The response includes whether the detection would trigger, whether any suppress rules fired, and how many rules were evaluated.

Dry-run testing skips cooldown checks, so you always get an accurate evaluation result regardless of whether the detection recently fired.
