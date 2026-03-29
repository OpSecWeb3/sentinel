# Audit logs

The audit log records every significant action taken in your Sentinel organization: who did it, what they did, and when. Use the audit log to investigate incidents, demonstrate compliance, and review the history of configuration changes.

---

## What audit logs capture

The audit log captures actions across the following categories:

| Category | Recorded actions |
|---|---|
| **Authentication** | User logins (successful and failed), logouts, session invalidation |
| **User and membership management** | Member additions, role changes, member removals, organization join and leave, organization creation and deletion |
| **Detections** | Detection created, updated (name, severity, status, rules, channels, cooldown), detection deleted |
| **Correlation rules** | Correlation rule created, updated, deleted, instances cleared |
| **Notification channels** | Channel created, updated, enabled or disabled, deleted |
| **API keys** | API key created, API key revoked |
| **Organization secrets** | Invite secret regenerated, notify key generated, rotated, or revoked, webhook secret rotated |
| **Integration management** | GitHub App installations added or removed, AWS integrations configured, Slack workspace connected or disconnected |
| **Registry management** | Docker images and npm packages added, updated, or removed; credentials set or removed |

Each record links the action to a specific actor (a logged-in user or an API key), a target resource, and a timestamp. The audit log is append-only; records cannot be modified or deleted through the application.

---

## Accessing the audit log

The audit log is accessible to **admin** users only.

1. In the top navigation, click **Settings**.
2. Select the **Audit Log** tab.

The audit log displays entries in reverse chronological order (most recent first).

---

## Audit log fields

Each audit log entry contains the following fields:

| Field | Column name | Description |
|---|---|---|
| **ID** | `id` | Auto-incrementing unique identifier (bigserial) |
| **Organization** | `org_id` | The organization the action was performed in |
| **Actor** | `user_id` | The user ID of the person who performed the action. Null if the action was performed by a system process. |
| **Action** | `action` | A string identifying the type of action (for example, `detection.created`, `member.role_changed`, `api_key.revoked`) |
| **Resource type** | `resource_type` | The category of the resource that was affected (for example, `detection`, `member`, `api_key`, `organization`) |
| **Resource ID** | `resource_id` | The unique identifier of the specific resource that was affected |
| **Details** | `details` | A JSON object with additional context specific to the action |
| **Timestamp** | `created_at` | The date and time the action occurred, in UTC |

---

## Filtering by action type, user, and resource

Use the filters at the top of the **Audit Log** tab to narrow results:

### Filter by action type

Select a specific action to view only entries of that type. Common action types include:

- `detection.created`
- `detection.updated`
- `detection.deleted`
- `member.added`
- `member.role_changed`
- `member.removed`
- `correlation_rule.created`
- `correlation_rule.updated`
- `correlation_rule.deleted`
- `correlation_rule.instances_cleared`
- `api_key.created`
- `api_key.revoked`
- `invite_secret.regenerated`
- `notify_key.generated`
- `notify_key.rotated`
- `notify_key.revoked`
- `webhook_secret.rotated`
- `slack.connected`
- `slack.disconnected`

### Filter by user

Enter a user ID to see all actions performed by that specific user. This is useful for investigating whether a particular user made unauthorized changes.

### Filter by resource type

Select a resource type to see all actions affecting that category of resource. Resource types include `detection`, `correlation_rule`, `member`, `api_key`, `organization`, `notification_channel`, `slack_installation`, `github_installation`, and `artifact`.

### Filter by time range

Set **Since** and **Until** timestamps to restrict results to a specific time window.

### Combining filters

Filters can be combined. For example, you can view all `api_key.created` actions by a specific user within a date range.

Up to 100 records are returned per page. Use the pagination controls to move through large result sets.

---

## Viewing audit log details

Click on an audit log entry to expand its **Details** field. The details JSON contains action-specific context. Examples:

**Role change:**
```json
{
  "previousRole": "viewer",
  "newRole": "editor",
  "changedBy": "user-uuid-here"
}
```

**Detection created:**
```json
{
  "detectionName": "Branch Protection Monitor",
  "moduleId": "github",
  "severity": "high"
}
```

**API key revoked:**
```json
{
  "keyName": "ci-pipeline",
  "keyPrefix": "sk_abc"
}
```

---

## Retention and export

### Retention

Audit log entries are retained indefinitely by default. The audit log is not subject to the configurable data retention policies that apply to events and alerts. This ensures that the full history of administrative actions remains available for compliance purposes regardless of how long ago they occurred.

If your organization has specific audit log retention requirements (for example, a maximum retention period mandated by a privacy regulation), contact your Sentinel platform operator to implement a custom retention policy at the database level.

### Export

The audit log can be queried programmatically via the Sentinel API using an API key with the `api:read` scope. Use the API to:

- Export audit log entries to an external SIEM or log aggregation system.
- Build automated compliance reports.
- Integrate audit data into your organization's centralized security monitoring.

---

## Compliance use cases

The audit log supports the following common compliance and investigation workflows:

**Demonstrating who made a configuration change and when.** Filter by `detection.updated` within a date range, then check the **Actor** field. The **Details** field shows the specific fields that changed.

**Verifying least-privilege access.** Review `member.role_changed` entries to confirm that role escalations were authorized. Cross-reference with the current member list to identify accounts that should be downgraded.

**Investigating a suspected compromise.** Filter by a specific **User** and review all actions in a suspicious time window. Look for unexpected role changes, API key creations, or detection modifications.

**API key lifecycle tracking.** Filter by `api_key.created` and `api_key.revoked` to produce a full lifecycle history of programmatic access credentials.

**Secret rotation audit.** Filter by `webhook_secret.rotated`, `notify_key.rotated`, and `invite_secret.regenerated` to verify that secrets are being rotated on schedule per your security policy.
