# Severity levels and triage

Sentinel uses severity levels to communicate the urgency of each alert.
Understanding severity definitions and establishing a triage workflow helps your
team respond to threats effectively and avoid alert fatigue.

## Severity levels: critical, high, medium, low, info

Every alert inherits its severity from the detection that generated it. Sentinel
defines the following severity levels.

### Critical

**Definition:** An active or imminent security threat requiring immediate
response.

**Examples:**

- Root account API activity in AWS.
- CloudTrail or AWS Config tampering.
- Proxy upgrade on a production smart contract.
- Contract ownership transferred to an unknown address.
- Docker image pushed without a cosign signature.
- npm package version unpublished.
- Certificate expired or contains critical chain errors.
- S3 bucket made public.
- KMS key disabled or scheduled for deletion.

**Expected response:** Page the on-call responder. Begin investigation within
minutes. Assume active exploitation until proven otherwise.

### High

**Definition:** A significant security risk that requires prompt attention but may
not indicate active exploitation.

**Examples:**

- IAM user creation or privilege escalation in AWS.
- Branch protection rules weakened or deleted in GitHub.
- Large token transfers exceeding configured thresholds.
- Deploy keys with write access added to a repository.
- npm maintainer changed on a monitored package.
- Security group ingress rules opened to 0.0.0.0/0.
- TLS weaknesses detected on a production host.
- Force pushes to protected branches.
- MFA deactivation on an IAM user.

**Expected response:** Investigate within the current work shift. Escalate to
critical if initial findings suggest active compromise.

### Medium

**Definition:** A moderate-risk finding that warrants review but is unlikely to
represent an active threat.

**Examples:**

- Unusual EC2 instance launches in non-standard regions.
- Balance tracker conditions met for non-critical wallets.
- Docker image tag changes on non-production registries.
- New Certificate Transparency log entries.
- Access denied errors in CloudTrail.
- npm dist-tag audit changes.
- Spot instance eviction warnings.

**Expected response:** Review within the business day. Determine whether the
activity is expected or needs further investigation.

### Low

**Definition:** Informational events captured for audit and compliance purposes.

**Examples:**

- Routine release artifact logging (Docker and npm).
- All-event log detections with no alerting action.

**Expected response:** Review during the next scheduled triage cycle. No immediate
action required.

### Info

**Definition:** Purely informational records used for visibility and
record-keeping. These do not represent any security risk.

**Examples:**

- Test notifications sent during channel verification.
- Detection dry-run results.
- Baseline data collection events.

**Expected response:** No action required. Review only when building context for
an investigation or audit.

## Triage workflow recommendations

Establish a structured process for reviewing and acting on alerts.

### 1. Initial review

Open the **Alerts** page and review new alerts since the last triage session.
Filter by severity (critical first) to prioritize the most urgent findings.

For each alert, assess:

- **Is this expected?** Check whether the alert corresponds to a known change
  (deployment, maintenance window, planned configuration update).
- **Is this a repeat?** Filter by the same detection to look for previous alerts
  with similar trigger data. Recurring alerts may indicate a tuning opportunity
  rather than a new threat.
- **What is the scope?** Review the trigger data to understand which resources are
  affected (contract addresses, repositories, AWS accounts, domains).

### 2. Investigation

For alerts that require investigation:

- Select the alert row to open the detail view. Review the full trigger data
  payload.
- Cross-reference with the source system (CloudTrail console, GitHub audit log,
  blockchain explorer, registry dashboard).
- Check the associated event record for additional context about the raw event
  that triggered the alert.
- Determine whether the activity was authorized by checking change management
  records, deployment logs, or team communication channels.

### 3. Response

Based on your investigation:

- **Confirmed threat:** Initiate your incident response procedure. Contain the
  threat, preserve evidence, and escalate as appropriate.
- **False positive:** Tune the detection (see
  [Managing false positives](../detections/managing-false-positives.md)) to
  prevent recurrence.
- **Expected activity:** No action required. Consider adding a suppress rule or
  narrowing the detection scope if this pattern recurs.

### 4. Documentation

Record the outcome of your investigation. Use external incident tracking systems
or the detection description field to document:

- What triggered the alert.
- Whether it was a true positive, false positive, or expected activity.
- What tuning changes (if any) were applied.

## Using severity to prioritize response

Use severity levels as the primary axis for prioritizing your team's attention.
The following table provides response time guidance:

| Severity | Target response time | Notification method |
|---|---|---|
| Critical | Within 15 minutes | Page on-call (PagerDuty/Opsgenie webhook), dedicated Slack channel |
| High | Within 1 hour | Security Slack channel, email to security team |
| Medium | Within 8 hours (business day) | Review queue Slack channel or email |
| Low | Next scheduled triage | Dashboard review only |
| Info | No response required | Dashboard review only |

These targets are guidelines. Adjust them based on your organization's risk
tolerance and team capacity.

## Escalation strategies

Configure escalation paths based on severity to ensure the right people are
notified at the right time.

### Severity-based channel assignment

Create separate notification channels for each severity tier and assign them to
detections accordingly.

| Severity | Channel recommendation |
|---|---|
| Critical | PagerDuty webhook (pages on-call) + dedicated Slack channel (#critical-alerts) |
| High | Slack channel (#security-alerts) + email to security team |
| Medium | Slack channel (#security-review) |
| Low | No notification channel (review in dashboard during triage) |

### Tiered detection strategy

Use the comprehensive templates (such as "AWS Full Security Suite" or "Full
GitHub Security Suite") as a first layer. These detections cover a broad set of
threats at high or critical severity. Then create focused detections at lower
severity for specific scenarios that need different notification routing.

For example:

1. Deploy "Full GitHub Security Suite" at critical severity with PagerDuty and
   Slack channels assigned.
2. Create a separate "Member Access Monitor" at medium severity with only a Slack
   channel, to track routine member additions without paging on-call.

### Escalation through cooldown management

For detections that monitor ongoing conditions (such as balance monitors or
availability probes), use short cooldowns for the initial alert and rely on your
incident management tool for escalation timing. Sentinel's cooldown prevents
duplicate notifications during the investigation period.

### Multi-channel escalation

Assign multiple channels to critical detections so that a failure in one delivery
method does not prevent notification. For example, assign both a PagerDuty webhook
and a Slack channel to ensure redundancy. If the webhook fails, the Slack
notification still reaches your team.

## Reducing alert fatigue

Alert fatigue occurs when your team receives so many notifications that they begin
ignoring alerts or responding slowly to genuine threats. Use the following
strategies to keep alert volumes manageable.

### Right-size your severity levels

Review your detections and verify that severity levels match the actual risk. If
most of your alerts are critical, your team will lose the ability to distinguish
between urgent and routine findings. Reserve critical for events that genuinely
require an immediate response.

### Use cooldowns aggressively

For high-volume detections, set cooldowns to at least 15 minutes. This reduces
the total number of notifications while preserving the first alert for each
incident.

### Consolidate with comprehensive templates

Instead of creating many individual detections for the same module, use a
comprehensive template (such as "Full Registry Security") that bundles all
monitors into a single detection. This provides a single cooldown boundary and a
unified alert stream.

### Route low-severity alerts to passive channels

Configure low and medium severity detections with email-only or dashboard-only
notification. Reserve Slack and pager notifications for high and critical
detections.

### Tune continuously

Review alert volumes weekly. Detections that produce more than 10 alerts per day
without corresponding incidents are candidates for threshold increases, scope
narrowing, or cooldown extensions. See
[Managing false positives](../detections/managing-false-positives.md) for detailed
tuning guidance.

## Setting up severity-based routing

To implement severity-based notification routing:

1. **Create channels per severity tier.** For example:
   - "Critical - PagerDuty" (webhook to PagerDuty Events API)
   - "High - Security Slack" (Slack channel #security-alerts)
   - "Medium - Review Queue" (email to security-review@yourcompany.com)

2. **Assign channels to detections by severity.** When creating or editing a
   detection:
   - Critical detections: assign the PagerDuty webhook and the Slack channel.
   - High detections: assign the Slack channel and the email channel.
   - Medium detections: assign only the email channel.
   - Low detections: leave channels empty (dashboard-only).

3. **Use comprehensive templates as baselines.** Enable "AWS Full Security Suite"
   or "Full GitHub Security Suite" with your critical-tier channels. Then create
   individual detections for lower-severity monitoring of the same data sources
   with different channel assignments.

4. **Review and adjust.** After operating for two weeks, review alert volumes by
   channel. If a channel receives too many notifications, consider moving some
   detections to a lower tier or increasing their cooldowns.

## Alert acknowledgment

Sentinel alerts are immutable records. The platform does not include a built-in
acknowledgment or status workflow (such as "open", "acknowledged", "resolved").
Alerts serve as a historical record of what triggered and when.

For acknowledgment and case management, integrate Sentinel with your existing
tools:

- **Webhook channels** can forward alerts to PagerDuty, Opsgenie, or ServiceNow
  for lifecycle management.
- **Slack channels** allow team members to react to and thread discussions on
  alert messages.
- **Email channels** can route to shared inboxes with built-in triage workflows.
