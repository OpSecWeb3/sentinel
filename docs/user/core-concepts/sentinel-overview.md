# Sentinel Overview

This document explains what Sentinel monitors, why a unified approach matters for modern security teams, and how the platform processes events from source to alert.

## What Sentinel Monitors

Sentinel watches five security domains simultaneously. Each domain is implemented as a **module**:

### GitHub Module

Monitors your GitHub organization for security-relevant events including:

- Repository visibility changes (public/private)
- Member additions and removals
- Branch protection rule changes
- Secret scanning alerts
- Code push and deployment events
- GitHub App installation changes

The GitHub module connects via a GitHub App installation, which grants fine-grained, organization-scoped access. In the sidebar, expand the **github** section to manage installations and view monitored repositories.

### Chain Module (EVM Blockchain)

Monitors smart contracts deployed on EVM-compatible blockchain networks. It watches for:

- Contract upgrades (proxy implementation changes)
- High-value transactions above configurable thresholds
- Ownership transfers
- Balance changes and state transitions
- Function call patterns matching custom conditions
- Windowed anomaly detection (spikes in transaction volume or value)

The Chain module connects to blockchain nodes via RPC endpoints and can use Etherscan-compatible APIs. Manage monitored contracts under **chain** > **contracts** in the sidebar.

### Infrastructure Module

Monitors your servers, domains, and cloud hosts for:

- SSL/TLS certificate expiry
- Domain WHOIS expiry
- Security score degradation (e.g., from SSL Labs or Observatory)
- Host additions, removals, and configuration drift

Navigate to **infra** > **hosts** and **infra** > **changes** to manage monitored infrastructure.

### Registry Module (Supply Chain)

Monitors Docker image registries and npm package registries for:

- Image digest changes (an existing tag pointing to a new image)
- New tag appearances and tag removals
- npm package version anomalies
- Releases pushed without CI attribution (detecting manual, out-of-band pushes)

Navigate to **registry** > **docker images** and **registry** > **npm packages** to manage monitored artifacts.

### AWS Module

Monitors your AWS environment via CloudTrail for:

- IAM policy and role changes
- Security group modifications
- S3 bucket policy changes
- Network configuration changes
- Compute instance lifecycle events
- Login activity and unusual access patterns

Navigate to **aws** > **integrations** and **aws** > **events** to manage your AWS monitoring.

---

## The Value of a Unified View

Security threats in modern organizations do not happen in a single domain. An attacker who compromises your CI/CD pipeline may push malicious code to GitHub, trigger a smart contract upgrade, and then drain funds -- all within minutes. If your GitHub alerts go to one Slack channel, your blockchain monitor sends emails to a different team, and your infrastructure monitoring is handled by a third tool, correlating those events manually is slow and error-prone.

Sentinel ingests all of these event streams into one platform and evaluates them against a shared set of rules. You get:

- **One place to look** for alerts across all five security domains
- **Cross-domain correlation** to detect multi-step attack patterns that no single-domain tool can see
- **Consistent severity levels** across domains so you can prioritize effectively
- **Unified notification routing** so the right team member is alerted regardless of which domain the threat originated in

---

## How Sentinel Works

Sentinel processes security events through a four-stage pipeline:

```
Event Source --> Sentinel Ingestion --> Detection Engine --> Alert --> Notification
                                    \                    /
                                     --> Correlation Engine --/
```

**Stage 1 -- Event ingestion.** External systems (GitHub, blockchain nodes, infrastructure agents, registries, AWS) send events to Sentinel via webhooks or polling. Sentinel normalizes each event into a standard format containing a module ID, event type, payload, and timestamps, then stores it in the database.

**Stage 2 -- Detection evaluation.** Every active detection rule for your organization and the event's module is loaded in priority order and evaluated against the incoming event. A detection rule specifies the event type and conditions that must be true for an alert to fire. The engine checks resource filters (host scope, include/exclude patterns) and cooldown state before producing alert candidates. If a rule with action `suppress` fires, it stops evaluation of all remaining rules for that event.

**Stage 3 -- Correlation evaluation.** Simultaneously, the correlation engine checks whether the event matches any step of an active correlation rule for your organization. If the event starts a new sequence, advances an in-flight sequence, reaches an aggregation threshold, or satisfies an absence trigger, the engine manages the in-flight state in Redis and potentially produces a correlated alert candidate.

**Stage 4 -- Alert creation and notification dispatch.** Alert candidates that pass cooldown and deduplication checks are written to the database as alerts. A background worker then dispatches notifications to every channel attached to the triggering detection or correlation rule. Each delivery attempt is recorded individually for audit and retry purposes.

---

## Multi-Tenancy

Sentinel is designed for multi-tenant operation. Your organization's data -- events, detections, alerts, channels, integrations, and correlation rules -- is completely isolated from every other organization on the same Sentinel instance. Authentication and API authorization enforce this boundary at every request. Every database query is scoped to your organization ID.

This means you can safely run Sentinel as a shared service across multiple teams or business units, each with their own detection configuration and alert history.

---

## Navigation Reference

The Sentinel web UI sidebar is organized into three sections:

**Main navigation:**

| Item | Description |
|---|---|
| **dashboard** | Organization-wide summary statistics and alert trends. |
| **detections** | List, create, and manage detection rules. |
| **correlations** | List, create, and manage correlation rules. |

**Modules:**

| Item | Sub-items |
|---|---|
| **github** | installations, repositories |
| **registry** | docker images, npm packages |
| **chain** | contracts |
| **infra** | hosts, changes |
| **aws** | integrations, events |

**System:**

| Item | Description |
|---|---|
| **settings** | Organization settings, members, channels, API keys. |

---

## Key Terms

| Term | Definition |
|---|---|
| **Module** | A security domain that Sentinel monitors: `github`, `chain`, `infra`, `registry`, `aws`. |
| **Event** | A normalized record of something that happened in an external system (for example, a GitHub repository was made public). |
| **Detection** | A named rule that monitors for a specific security condition. When conditions match, it produces an alert. |
| **Template** | A pre-built detection that you can activate and optionally customize. Templates define default rules, inputs, and severity. |
| **Rule** | A specific evaluator configuration within a detection. A detection can have one or more rules. |
| **Alert** | A record created when a detection rule fires. It carries severity, title, description, and links to the originating event. |
| **Correlation rule** | A rule that detects a pattern of events across one or more modules within a time window. Supports sequences, aggregations, and absence detection. |
| **Channel** | A destination for alert notifications: Slack, email, or a custom webhook. |
| **Cooldown** | A configurable suppression window after a detection fires to prevent duplicate alerts for the same condition. |
| **Resource filter** | A glob-pattern-based include/exclude filter that scopes a rule to specific resources (hostnames, repository names, contract addresses). |
