# Alerting System

This document covers the full lifecycle of a Sentinel alert, the fields that every alert carries, how notifications are dispatched and tracked, and how to use the alert management interface effectively.

## Alert Lifecycle

An alert begins when a detection rule fires or a correlation sequence completes. It moves through the following stages:

**1. Triggered.** The detection engine or correlation engine matched an event against a rule and produced an alert candidate. This state is internal and lasts only milliseconds.

**2. Pending.** The alert is written to the database with a notification status of `pending`. The alert is immediately visible in the Sentinel web UI. A background job is queued to dispatch notifications.

**3. Notification dispatched.** A background worker processes the notification job. It loads the alert, resolves the detection's notification channels, and dispatches the alert to each channel. Each individual delivery is recorded in the `notification_deliveries` table with its own status, HTTP status code, response time, and any error message.

**4. Final notification status.** After all channels are attempted, the alert's notification status is updated:

| Status | Meaning |
|---|---|
| `sent` | All configured channels received the notification successfully. |
| `partial` | At least one channel succeeded and at least one failed. |
| `failed` | All configured channels failed to receive the notification. |
| `no_channels` | The detection had no notification channels configured at the time the alert fired. |
| `pending` | Notification dispatch is queued but has not completed yet. |

**5. Triage.** You review the alert, investigate the underlying event, and take appropriate action in the affected system.

### Deduplication

Sentinel prevents duplicate alerts for the same event:

- For detection alerts: a unique constraint prevents the same event + detection + rule combination from producing more than one alert.
- For correlated alerts: a unique constraint prevents the same event from producing more than one correlated alert.

If a duplicate is attempted (for example, due to a retry after a worker crash), the database constraint rejects it silently. This ensures that even in the event of infrastructure issues, you never see duplicate alerts.

---

## Alert Fields

Every alert record contains the following fields:

| Field | Description |
|---|---|
| **ID** | A numeric identifier, unique across all organizations (bigserial). |
| **Title** | A short description of what happened. For template-based detections, the title is generated from the event data (for example, `Repository made public: your-org/your-repo`). For correlation alerts, the title is formatted as `Correlated: <rule name>` or `Aggregation: <rule name>`. |
| **Description** | A longer explanation of the event or matched sequence. For correlation alerts, this includes the correlation key values, the matched steps, actors involved, and time span. |
| **Severity** | `critical`, `high`, `medium`, or `low`. Inherited from the detection or correlation rule that fired. |
| **Module** | The security domain the event originated from: `github`, `chain`, `infra`, `registry`, or `aws`. |
| **Detection** | The detection that produced this alert (for standard alerts). May be null for correlated alerts. |
| **Trigger type** | Whether this is a standard detection alert (`rule`) or a correlated alert (`correlated`). |
| **Trigger data** | A JSON object containing details specific to the trigger type -- the event payload for detection alerts, or the correlation context (matched steps, actors, time span, modules) for correlated alerts. |
| **Notification status** | The result of notification dispatch: `sent`, `partial`, `failed`, `no_channels`, or `pending`. |
| **Timestamp** | When the alert was created. |

---

## Notification Channels

When an alert is created, Sentinel dispatches a notification to every channel attached to the triggering detection. Sentinel supports three channel types:

### Email

Email notifications are sent to one or more recipient addresses. The email includes the alert title, severity, module, detection name, description, and a direct link to the alert in the Sentinel web UI.

To send email notifications, `SMTP_URL` and `SMTP_FROM` must be configured in your environment. See [Installation](../getting-started/installation.md).

### Webhook

Webhook notifications deliver a JSON payload to an HTTP endpoint of your choice. Use this channel type to integrate Sentinel alerts with a SIEM, incident management platform (such as PagerDuty or Opsgenie), or a custom automation pipeline.

The payload includes the alert title, severity, description, module, event type, and timestamp. If you configure a signing secret on the channel, Sentinel includes an HMAC-SHA256 signature in the `X-Signature-256` request header so your endpoint can verify that the request originated from Sentinel.

**Security notes on webhook channels:**

- Certain HTTP headers are blocked and cannot be set as custom headers: `Host`, `Transfer-Encoding`, `Connection`, `Content-Length`, `Cookie`, `Authorization`, `X-Signature`, and `Content-Type`.
- Webhook URLs should use HTTPS in production.

### Slack

Slack notifications use the Slack API to post a formatted message to a channel of your choice. The message uses Slack's Block Kit format and includes alert severity color-coding, the alert title and description, the module and detection name, and a link to view the alert in Sentinel.

Each module can provide its own custom Slack message formatter for richer, domain-specific alert messages (for example, including the contract address and transaction hash for chain alerts).

There are two ways to configure Slack:

1. **Notification channel (Slack channel ID)** -- Create a Slack notification channel in **Settings** > **Channels** with the Slack channel ID. Requires the Slack OAuth installation to be completed.
2. **Direct Slack channel on a detection** -- When creating or editing a detection, you can specify a Slack channel ID and channel name directly. This is useful for routing specific high-priority detections to a dedicated Slack channel.

For full Slack setup details, see [Slack Integration](../integrations/slack.md).

---

## Delivery Tracking

Every notification dispatch attempt is recorded individually in the delivery tracking system. For each alert and each channel, Sentinel records:

| Field | Description |
|---|---|
| **Channel ID** | The notification channel UUID, or the Slack channel ID for direct Slack dispatches. |
| **Channel type** | `email`, `webhook`, or `slack`. |
| **Status** | `sent` or `failed`. |
| **HTTP status code** | The response status code from the webhook endpoint or Slack API (for webhook and Slack channels). |
| **Response time (ms)** | How long the delivery took. |
| **Error** | The error message if the delivery failed. |
| **Attempt count** | How many times this delivery was attempted. |
| **Sent at** | The timestamp when the delivery succeeded. |

This audit trail lets you diagnose notification failures and verify that alerts are reaching their intended destinations.

### Retry Behavior

If a notification dispatch job fails (for example, due to a temporary network issue), the background worker retries the job. On retry, channels that already succeeded on a previous attempt are skipped -- Sentinel checks the delivery records and only re-attempts channels that have not yet been marked as `sent`. This prevents duplicate notifications to channels that already received the alert.

---

## Alert Cooldown: Preventing Alert Fatigue

A **cooldown** is a configurable suppression window on a detection. When a detection fires, Sentinel starts a cooldown timer. If the same detection matches another event before the timer expires, that match is suppressed and no new alert is created. Once the cooldown period elapses, the detection can fire again.

Cooldown is configured per detection, in minutes. The valid range is 0 (no cooldown -- every match produces an alert) to 1,440 (24 hours).

**When to use cooldown:**

- Set a non-zero cooldown for detections that monitor high-frequency events (for example, a detection on Docker image tag changes for a busy CI/CD pipeline).
- Leave the cooldown at 0 for detections on rare, high-severity events where every instance matters (for example, a repository visibility change or a contract ownership transfer).

**How cooldown works in practice:**

A detection with a 30-minute cooldown fires at 14:00. A second matching event arrives at 14:15. The second event is still stored as a raw event record, but no alert is created. If a third matching event arrives at 14:35 (35 minutes after the first alert), a new alert is created because the cooldown has elapsed.

**Cooldown scope:** Cooldown is tracked per detection, per rule, and per resource. If events come from different resources (for example, different contract addresses), cooldowns are independent. An alert for `contract-A` does not suppress an alert for `contract-B` on the same detection.

---

## Viewing Alerts

### The Alerts View

Navigate to the alerts section to see a paginated list of all alerts for your organization, sorted by most recent first.

### Filtering Alerts

Use the filter controls at the top of the alerts page to narrow the list:

- **Severity** -- Filter to `critical`, `high`, `medium`, or `low`. Use this to focus on the highest-priority items first during an incident.
- **Module** -- Filter to a specific security domain (`github`, `chain`, `infra`, `registry`, `aws`).
- **Detection** -- Filter to alerts from a specific detection rule.
- **Trigger type** -- Filter to standard detection alerts or correlated alerts.
- **Notification status** -- Filter by delivery outcome to identify alerts that failed to notify.
- **Search** -- Text search across alert titles.

You can combine multiple filters. For example, to see all critical GitHub alerts, set severity to `critical` and module to `github`.

### Alert Detail

Click any alert to open the detail view. The detail view shows all alert fields, the full description text, and -- for correlation alerts -- the complete list of matched steps with event types, timestamps, and actors.

---

## Alert Statistics on the Dashboard

The **Dashboard** (at `/dashboard`) shows summary statistics for your organization's alert activity:

- Total alerts across all detections
- Breakdown by severity (critical, high, medium, low)
- Breakdown by module
- Recent alert trend

Use the dashboard as a starting point when you log in. Spikes in critical or high alerts, or alerts from modules that are normally quiet, are signals worth investigating immediately.

---

## Notification Status Troubleshooting

If you see alerts with `failed` or `partial` notification status:

1. **Check channel configuration.** Verify that the channel's settings are correct: valid Slack bot token, reachable SMTP server, accessible webhook URL.
2. **Check delivery records.** Look at the individual delivery records for the alert to see the specific error message and HTTP status code.
3. **Check the worker service.** Notification dispatch runs in the background worker. Verify that the worker containers are running: `docker compose ps`.
4. **Check network connectivity.** The worker needs outbound network access to reach Slack, SMTP servers, and webhook endpoints.
5. **Check for rate limiting.** External services (Slack, email providers) may rate-limit requests. If you see HTTP 429 responses in delivery records, consider adding cooldown to high-frequency detections.
