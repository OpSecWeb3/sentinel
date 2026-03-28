# Configuring notification channels

Notification channels define where Sentinel delivers alert notifications. You can configure channels for Slack, email, and custom webhooks, then assign them to one or more detections.

## Notification channel types

Sentinel supports three channel types:

| Type | Delivery method | Configuration required |
|---|---|---|
| **Slack** | Posts to a Slack channel via the Slack Bot API. | Slack OAuth installation and a channel ID. |
| **Email** | Sends an email to one or more recipients via SMTP. | SMTP server configured on the Sentinel instance; recipient email addresses. |
| **Webhook** | Sends an HTTP POST with a signed JSON payload to a URL you specify. | A publicly reachable HTTPS endpoint. |

## Setting up Slack integration

Sentinel supports two methods for sending Slack notifications.

### Method 1: Slack notification channel (Bot API)

This method uses a Slack app installation to post messages via the Slack Bot API.

1. Navigate to **Settings > Integrations** and complete the Slack OAuth flow to install the Sentinel Slack app in your workspace.
2. Navigate to **Notification Channels** and select **New Channel**.
3. Set the **Name** to a descriptive label (for example, "Security alerts - #incident-response").
4. Set the **Type** to `slack`.
5. In the **Config** section, enter the **Channel ID** of the Slack channel where alerts should be posted. You can find the channel ID by right-clicking the channel name in Slack and selecting **Copy link** -- the ID is the last segment of the URL.
6. Select **Create Channel**.
7. Select **Test** to send a test notification and confirm delivery.

### Method 2: Direct Slack channel (per-detection)

You can also assign a Slack channel directly on a detection without creating a notification channel object.

1. Navigate to the detection detail page and select **Edit Detection**.
2. In the **Slack Channel ID** field, enter the Slack workspace channel ID.
3. In the **Slack Channel Name** field, enter the channel name for display purposes.
4. Save the detection.

This method uses the Slack bot token from your organization's Slack installation. It does not require a separate notification channel to be created.

Sentinel uses module-specific Slack formatters when available. Alerts from the blockchain module, for example, include formatted blocks with contract addresses, transaction hashes, and decoded event data.

## Configuring email notifications

Email notifications require your Sentinel instance to have `SMTP_URL` configured. If SMTP is not configured, the channel creation endpoint returns an error.

1. Navigate to **Notification Channels** and select **New Channel**.
2. Set the **Name** to a descriptive label (for example, "SOC team email").
3. Set the **Type** to `email`.
4. In the **Config** section, add one or more **Recipients** as valid email addresses.
5. Select **Create Channel**.
6. Select **Test** to send a test email and verify SMTP delivery.

Each recipient receives the same alert notification. There is no per-recipient filtering.

## Setting up webhook endpoints

Webhook channels send a signed HTTP POST request to a URL you control. Sentinel signs the payload using HMAC-SHA256, so you can verify that notifications originate from your Sentinel instance.

1. Navigate to **Notification Channels** and select **New Channel**.
2. Set the **Name** to a descriptive label (for example, "PagerDuty webhook").
3. Set the **Type** to `webhook`.
4. In the **Config** section, enter the **URL** of your webhook endpoint. The URL must be a valid, publicly reachable HTTPS URL.
5. Optionally provide a **Secret** for HMAC signing. If you do not provide a secret, Sentinel auto-generates a 32-byte hex secret and returns it in the creation response. Store this secret securely -- it is encrypted at rest and cannot be retrieved later.
6. Optionally add custom **Headers** as key-value pairs. These headers are included in every webhook request. The following headers are blocked for security reasons and are stripped automatically: `Host`, `Transfer-Encoding`, `Connection`, `Content-Length`, `Cookie`, `Authorization`, `X-Signature`, and `Content-Type`.
7. Select **Create Channel**.
8. Select **Test** to send a test payload and verify delivery.

### Webhook payload format

The webhook POST body is a JSON object with the following structure:

```json
{
  "alert": {
    "title": "Large Transfer Monitor triggered",
    "severity": "high",
    "description": "Transfer of 5,000,000 tokens detected",
    "module": "chain",
    "eventType": "chain.event_match",
    "timestamp": "2026-03-28T14:30:00.000Z"
  }
}
```

The request includes an `X-Signature` header containing the HMAC-SHA256 digest of the request body, computed using the channel's secret.

### Verifying webhook signatures

On your server, compute the HMAC-SHA256 of the raw request body using the secret you stored during channel creation, and compare it to the `X-Signature` header value.

## Assigning channels to detections

After creating notification channels, assign them to detections so that alerts trigger notifications.

1. Navigate to **Detections** and select the detection you want to configure.
2. Select **Edit Detection**.
3. In the **Notification Channels** section, select one or more channels from the list of available channels. Each channel is identified by its name and type.
4. Save the detection.

You can assign multiple channels to a single detection. When an alert fires, Sentinel dispatches notifications to all assigned channels in parallel. If a channel has been disabled or soft-deleted, it is skipped during dispatch.

You can also assign channels during detection creation, whether from a template or as a custom detection.

## Testing channel delivery

Test a channel at any time to verify that notifications can be delivered.

1. Navigate to **Notification Channels** and select the channel you want to test.
2. Select **Test**.
3. Sentinel sends a test notification with the title "Test Notification from Sentinel" and severity `medium`.
4. Check the target system (Slack channel, email inbox, or webhook endpoint) to confirm receipt.

If the test fails, Sentinel returns an error message. Common causes of test failures include:

- **Slack:** The bot is not invited to the target channel, or the Slack bot token is missing.
- **Email:** SMTP is not configured (`SMTP_URL` environment variable is unset), or the recipient address is invalid.
- **Webhook:** The endpoint URL is unreachable, returns an error status code, or the connection times out.

Disabled channels cannot be tested. Enable the channel first, then run the test.

## Managing channels

**Updating a channel.** You can update the channel name, configuration, and enabled status at any time. Navigate to the channel detail page and select **Edit**. When you update a webhook channel's secret, the new secret is encrypted before storage.

**Disabling a channel.** Set the channel's **Enabled** toggle to off. Disabled channels are skipped during alert dispatch but are not deleted. This is useful for temporarily muting a notification destination during maintenance.

**Deleting a channel.** Deleting a channel is a soft delete -- the channel record is retained with a `deletedAt` timestamp but no longer appears in listings or receives notifications. Only administrators can delete channels.
