# Correlation Engine

This document explains what correlation rules are, why they are powerful for detecting sophisticated attacks, and how to interpret the three types of correlation patterns Sentinel supports.

## What Is Correlation?

A standard detection fires when a single event matches a rule. That works well for well-defined, self-contained incidents -- a repository is made public, a contract is upgraded. But sophisticated attacks rarely announce themselves with a single, obvious event. Instead, they unfold as a chain of individually plausible actions that only look suspicious in combination.

**Correlation** is Sentinel's ability to detect these multi-step attack patterns by tracking sequences of related events across multiple security domains within a defined time window. A correlation rule fires only when the full pattern is matched -- not on any individual event in the sequence.

Because correlation rules span multiple modules, they can detect attack chains that no single-domain security tool could recognize. A GitHub alert tool does not know what happened on-chain five minutes after a suspicious push. Sentinel does.

---

## An Example Attack Scenario

Consider a software supply chain attack targeting a DeFi protocol:

1. An attacker gains access to a GitHub account and pushes a commit to the smart contract repository that modifies the contract's upgrade logic.
2. Twenty minutes later, the contract's proxy is upgraded to a new implementation -- the malicious one.
3. Forty minutes later, a large unauthorized transaction drains funds from the contract.

Each of these events, in isolation, might not be alarming:

- Code pushes happen constantly.
- Contract upgrades are routine during development.
- Large transactions occur in normal protocol operations.

But when all three happen within one hour, involve the same repository and contract address, and are performed by the same actor (or a small related set of actors), the pattern strongly indicates a coordinated attack.

A Sentinel correlation rule can detect this pattern:

```
Step 1: GitHub push to contract repository
Step 2: Contract upgrade on the monitored address (within 60 minutes of Step 1)
Step 3: Large on-chain transaction to/from the contract (within 60 minutes of Step 2)
```

Sentinel emits a single **correlated alert** only when all three steps complete within the time window. The alert includes the full sequence of matched events, the actors involved, and the time span.

---

## Correlation Rule Types

Sentinel supports three types of correlation rules. You select the type when creating a new rule from the **correlations** page.

### Sequence

A sequence rule defines an ordered list of steps (minimum of two). Each step specifies:

- **Event filter** -- Which module, event type(s), and field conditions must be satisfied. A step can match multiple event types.
- **Per-step time constraint** (`withinMinutes`) -- Optional. How many minutes after the previous step this step must occur. This is more precise than the overall window and lets you model attack patterns where individual transitions happen quickly.
- **Cross-step match conditions** -- Optional. Conditions that link fields between events in the sequence (for example, "the actor on this step must equal the actor on Step 1"). These reference fields captured from previous steps using the syntax `steps.<StepName>.<fieldPath>`.

Events are tracked using a **correlation key** -- one or more fields shared across the events (such as a repository name, contract address, or actor login) that ties the sequence together.

A sequence alert fires when all steps are matched in order within the overall time window.

**Use for:** Ordered attack chains where each step follows from the previous one.

**Real-world example -- Branch protection bypass:**

A developer disables branch protection on a repository, force-pushes to the main branch, then re-enables branch protection -- all within 30 minutes. Individually, each action has legitimate uses. Together, they indicate someone bypassed code review protections.

```
Step 1: GitHub event — branch protection rule deleted
Step 2: GitHub event — push to protected branch (within 15 minutes of Step 1)
Step 3: GitHub event — branch protection rule created (within 30 minutes of Step 1)
Correlation key: repository.full_name
Window: 30 minutes
```

### Aggregation

An aggregation rule counts events matching a filter within a time window and fires when a threshold is exceeded. You can configure it in two modes:

- **Simple count** -- Count the total number of matching events. For example, "alert if more than 50 failed login events occur within 10 minutes."
- **Distinct count** -- Count the number of distinct values of a specific field. For example, "alert if failed logins come from more than 5 distinct IP addresses within 10 minutes." You specify the field to count distinct values of using the `countField` setting.

You can optionally set a `groupByField` to track counts independently per group. For example, group by `targetUser` to detect brute-force attacks against any single user, not just a global threshold.

Aggregation counters are managed atomically in Redis using Lua scripts to prevent race conditions when multiple workers process events concurrently. When the threshold is reached, the counter is reset and the alert fires exactly once.

**Use for:** Brute-force detection, rate-based anomaly detection, or any scenario where the volume of an event type is itself suspicious.

**Real-world example -- AWS credential stuffing:**

An attacker tries to log into multiple AWS accounts from different IP addresses in rapid succession. No single failed login is suspicious, but 20 failures across 8 distinct source IPs in 10 minutes signals a credential stuffing attack.

```
Event filter: AWS module, event type "ConsoleLogin", condition "errorMessage exists"
Threshold: 20 events
Count field (distinct): sourceIPAddress
Group by: targetUser
Window: 10 minutes
```

### Absence

An absence rule fires when an expected event does **not** arrive within a grace period after a trigger event. It has two components:

- **Trigger** -- An event filter that starts the timer. When a matching event arrives, Sentinel records it and starts a countdown of `graceMinutes`.
- **Expected** -- An event filter for the event that should follow. If an event matching this filter arrives within the grace period and satisfies any match conditions (linking fields between the trigger and expected events), the timer is cancelled.

If the grace period expires without the expected event arriving, Sentinel fires an alert.

Trigger-to-expected linking uses **match conditions** that compare fields on the expected event against fields captured from the trigger event. For example, "the deployment ID on the expected audit log must equal the deployment ID on the trigger deployment event."

**Use for:** Detecting when a required follow-up action (such as a post-deployment security scan, a two-party approval, or an audit log confirmation) fails to occur.

**Real-world example -- Missing post-deployment scan:**

Your organization requires a security scan after every production deployment. If a deployment occurs but no scan result is recorded within 30 minutes, someone either skipped the scan or the scanner is down. Either way, you want to know.

```
Trigger: GitHub module, event type "deployment.created", condition "environment = production"
Expected: Infra module, event type "security_scan.completed"
Match condition: expected.deploymentId = trigger.payload.deployment.id
Grace period: 30 minutes
```

---

## How the Correlation Engine Tracks State

### Sequence State

When the first event in a sequence matches Step 1, Sentinel starts an **instance** of that rule for the specific correlation key value (for example, the specific repository name). This instance is stored in Redis with a TTL equal to the overall time window.

As subsequent events arrive, the engine checks whether they advance the in-flight instance to the next step. The engine uses an atomic compare-and-swap operation in Redis to prevent race conditions: if two workers try to advance the same instance concurrently, only one succeeds and the other is safely rejected.

The instance expires automatically if the time window elapses before the sequence completes. Multiple concurrent instances can exist for the same rule when the same pattern is being tracked for different correlation key values simultaneously.

```
GitHub Module: push to contract-repo (actor: alice)
    --> Correlation Engine: Step 1 matched, start instance (key: contract-repo)

Chain Module: contract upgrade on 0xABCD (30 min later)
    --> Correlation Engine: Step 2 matched, advance instance

Chain Module: large transaction from 0xABCD (25 min later)
    --> Correlation Engine: Step 3 matched, sequence COMPLETE
    --> Write correlated alert, dispatch notification
```

### Aggregation State

Aggregation counters are stored in Redis. For simple counts, an integer counter is incremented atomically. For distinct counts, a Redis set tracks unique values. Both are managed via Lua scripts that check the threshold and reset the counter in a single atomic operation, preventing double-firing.

### Absence State

Absence timers are stored as Redis keys with a TTL slightly longer than the grace period. An index (Redis sorted set) tracks all active absence timers by their expiration timestamp. A periodic expiry handler scans the index for expired timers and creates alerts for any that were not cancelled.

---

## The Correlation Key

The correlation key is the anchor that connects events across steps. It tells the engine which events "belong together." For example, if your correlation key is `repository.full_name`, then all events in the sequence must have the same value for that field. This prevents the engine from matching a GitHub push to repository A with a contract upgrade related to repository B.

You can define multiple key fields. All of them must match for events to be considered part of the same sequence. The engine computes a SHA-256 hash of the concatenated key values to index instances in Redis.

If any key field is missing from an event's payload, the event is skipped for that correlation rule. This prevents unrelated events from collapsing into a shared bucket and producing false positives.

---

## Cross-Domain Correlation: Why It Matters

Traditional security tools are domain-specific. Your GitHub security tool knows about pushes and pull requests. Your blockchain monitor knows about transactions and upgrades. Your SIEM may receive logs from both, but correlating events across them in real time requires significant custom engineering.

Sentinel's correlation engine was designed to do this natively. A single correlation rule can reference events from the `github` module, the `chain` module, the `registry` module, and the `aws` module in the same sequence. The engine maintains in-flight state for each sequence across all event sources, so the time window operates on real wall-clock time regardless of which module each event comes from.

This means you can express security rules that reflect how real attackers operate -- moving laterally across your stack -- rather than being constrained to the event vocabulary of any single tool.

---

## Managing Correlation Rules

Navigate to **correlations** in the sidebar to view all correlation rules for your organization. The list shows each rule's name, type (sequence, aggregation, or absence), status, severity, time window, and last alert timestamp.

### Creating a Correlation Rule

Click **+ New Rule** to create a correlation rule. The form asks for:

- **Name and description** -- A human-readable identifier for the rule.
- **Severity** -- The severity of the alert that fires when the pattern is matched: `critical`, `high`, `medium`, or `low`.
- **Rule type** -- `sequence`, `aggregation`, or `absence`.
- **Correlation key** -- One or more field paths whose values must be shared across all events in the pattern (for example, `repository.full_name`). You can assign an alias to each key field for readability.
- **Time window (minutes)** -- The total duration within which the entire pattern must complete.
- **Steps** (for sequence rules) -- An ordered list of event filters, each specifying the module, event type, optional field conditions, optional per-step time constraint, and optional cross-step match conditions.
- **Aggregation settings** (for aggregation rules) -- The event filter, threshold, optional count field (for distinct counting), and optional group-by field.
- **Absence settings** (for absence rules) -- The trigger event filter, the expected event filter, match conditions linking trigger to expected event fields, and the grace period in minutes.
- **Notification channels** -- Where to send the correlated alert.
- **Cooldown** -- The minimum time in minutes between repeated fires of this rule.

### Managing Existing Rules

For each correlation rule in the list, you can:

- **[pause]** / **[resume]** -- Toggle the rule between active and paused states.
- **[edit]** -- Navigate to the edit page to modify the rule's configuration.
- **[delete]** -- Permanently delete the rule. Sentinel asks for confirmation. Deleted rules cannot be recovered.

You can filter the list by **status** (active, paused), **type** (sequence, aggregation, absence), and **severity** (critical, high, medium, low). A search bar lets you find rules by name.

---

## Correlated Alert Contents

When a correlation rule fires, the alert contains:

| Field | Description |
|---|---|
| **Title** | The type of correlation and the rule name (for example, `Correlated: Supply Chain Attack Detected` or `Aggregation: Brute Force Login`). |
| **Description** | A summary of what was detected, including the correlation key values, the time window, and specifics of the match. |
| **Correlation type** | `sequence`, `aggregation`, or `absence`. |
| **Matched steps** | For sequences: the full list of matched steps, including event type, timestamp, and actor for each step. |
| **Actors** | The actors involved across all steps, and whether the same actor performed every step. |
| **Time span** | The time from the first matched event to the last. |
| **Modules** | The modules that contributed events to the match. |
| **Correlation key values** | The field values that tied the events together. |

This context significantly reduces triage time compared to receiving three separate alerts with no linking information.

---

## Rule Caching

The correlation engine caches loaded rules per organization for up to 30 seconds to reduce database load. When you create, update, or delete a correlation rule, the cache is invalidated immediately for your organization. In normal operation, a new or modified rule takes effect within 30 seconds across all workers.
