# Configuring notification channels

Notification channels define where Sentinel delivers alert notifications. You can
configure channels for Slack, email, and custom webhooks, then assign them to one
or more detections.

## Notification channel types

Sentinel supports three channel types:

| Type | Delivery method | Configuration required |
|---|---|---|
| **Slack** | Posts to a Slack channel via the Slack Bot API. | Slack OAuth installation and a channel ID. |
| **Email** | Sends an email to one or more recipients via SMTP. | SMTP server configured on the Sentinel instance; recipient email addresses. |
| **Webhook** | Sends an HTTP POST with a signed JSON payload to a URL you specify. | A publicly reachable HTTPS endpoint. |

## Adding a Slack channel

Sentinel supports two methods for sending Slack notifications.

### Method 1: Slack notification channel (Bot API)

This method uses a Slack app installation to post messages via the Slack Bot API.

1. Navigate to **Settings** and select the **slack** section.
2. If Slack is not connected, select **[connect slack]** to start the OAuth flow.
   Complete the installation in the Slack authorization page.
3. After installation, the settings page shows the connected workspace name and
   installation date.
4. Navigate to **Settings** and select the **channels** section.
5. Select **[+ new channel]**.
6. Set the **name** to a descriptive label (for example, "Security alerts -
   #incident-response").
7. Set the **type** to `slack`.
8. In the config section, enter the **Channel ID** of the Slack channel where
   alerts should be posted. You can find the channel ID by right-clicking the
   channel name in Slack and selecting **Copy link** -- the ID is the last segment
   of the URL.
9. Select **create**.
10. Select **[test]** next to the new channel to send a test notification and
    confirm delivery.

**Note:** The Sentinel Slack bot must be invited to the target channel before it
can post messages. In Slack, type `/invite @Sentinel` in the channel.

### Method 2: Direct Slack channel (per-detection)

You can assign a Slack channel directly on a detection without creating a
notification channel object.

1. Navigate to the detection detail page and select **[edit]**.
2. In the **Slack Channel ID** field, enter the Slack workspace channel ID.
3. In the **Slack Channel Name** field, enter the channel name for display
   purposes.
4. Save the detection.

This method uses the Slack bot token from your organization's Slack installation.
It does not require a separate notification channel to be created.

Sentinel uses module-specific Slack formatters when available. Alerts from the
blockchain module, for example, include formatted blocks with contract addresses,
transaction hashes, and decoded event data.

### Disconnecting Slack

To remove the Slack integration:

1. Navigate to **Settings** and select the **slack** section.
2. Select **[disconnect]**. Sentinel displays a confirmation dialog warning that
   alert notifications to Slack channels will stop working.
3. Confirm the disconnection.

## Adding email recipients

Email notifications require your Sentinel instance to have `SMTP_URL` configured.
If SMTP is not configured, the channel creation endpoint returns an error
explaining that the administrator must configure SMTP.

1. Navigate to **Settings** and select the **channels** section.
2. Select **[+ new channel]**.
3. Set the **name** to a descriptive label (for example, "SOC team email").
4. Set the **type** to `email`.
5. In the **recipients** field, enter email addresses separated by commas.
6. Select **create**.
7. Select **[test]** to send a test email and verify SMTP delivery.

Each recipient receives the same alert notification. There is no per-recipient
filtering.

## Adding webhook endpoints

Webhook channels send a signed HTTP POST request to a URL you control. Sentinel
signs the payload using HMAC-SHA256, so you can verify that notifications
originate from your Sentinel instance.

1. Navigate to **Settings** and select the **channels** section.
2. Select **[+ new channel]**.
3. Set the **name** to a descriptive label (for example, "PagerDuty webhook").
4. Set the **type** to `webhook`.
5. In the **url** field, enter the URL of your webhook endpoint. The URL must be a
   valid, publicly reachable HTTPS URL.
6. Select **create**.

If you do not provide a secret, Sentinel auto-generates a 32-byte hex secret and
returns it in a toast notification. **Store this secret immediately** -- it is
encrypted at rest and cannot be retrieved later. The secret is displayed only once
at creation time.

Optionally, you can provide a custom secret and custom headers through the API.
The following headers are blocked for security reasons and are stripped
automatically: `Host`, `Transfer-Encoding`, `Connection`, `Content-Length`,
`Cookie`, `Authorization`, `X-Signature`, and `Content-Type`.

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

The request includes an `X-Signature` header containing the HMAC-SHA256 digest of
the request body, computed using the channel's secret.

### Verifying webhook signatures

On your server, compute the HMAC-SHA256 of the raw request body using the secret
you stored during channel creation, and compare it to the `X-Signature` header
value. Reject requests where the signature does not match.

## Verifying channels

After creating a channel, verify that it can deliver notifications before
assigning it to production detections.

1. Navigate to **Settings** and select the **channels** section.
2. Locate the channel in the list. Each channel displays its name, type, enabled
   status, and creation date.
3. Select **[test]** next to the channel.
4. Sentinel sends a test notification with the title "Test Notification from
   Sentinel" and severity `medium`.
5. Check the target system (Slack channel, email inbox, or webhook endpoint) to
   confirm receipt.

If the test fails, Sentinel displays an error message. Common causes of test
failures include:

- **Slack:** The bot is not invited to the target channel, or the Slack bot token
  is missing. Verify the Slack installation in **Settings > slack**.
- **Email:** SMTP is not configured (`SMTP_URL` environment variable is unset),
  or the recipient address is invalid.
- **Webhook:** The endpoint URL is unreachable, returns an error status code, or
  the connection times out.

Disabled channels cannot be tested. Enable the channel first, then run the test.

## Assigning channels to detections

After creating and verifying notification channels, assign them to detections so
that alerts trigger notifications.

1. Navigate to **Detections** and select the detection you want to configure.
2. Select **[edit]** on the detection detail page.
3. In the **Notification Channels** section, select one or more channels from the
   list of available channels. Each channel is identified by its name and type.
4. Save the detection.

You can assign multiple channels to a single detection. When an alert fires,
Sentinel dispatches notifications to all assigned channels in parallel. If a
channel has been disabled or soft-deleted, it is skipped during dispatch.

You can also assign channels during detection creation, whether from a template
or as a custom detection.

## Testing channel delivery

Test a channel at any time to verify that notifications can be delivered. This is
especially important after changing channel configuration or rotating credentials.

1. Navigate to **Settings** and select the **channels** section.
2. Locate the channel you want to test.
3. Select **[test]**.
4. Check the target system to confirm the test notification arrived.

For webhook channels, the test payload uses the same format and signing as
production alerts, so you can also use the test to verify your signature
validation logic.

## Managing channels

### Enabling and disabling channels

Toggle a channel's enabled status to temporarily mute a notification destination
during maintenance.

1. Navigate to **Settings** and select the **channels** section.
2. Locate the channel and select **[disable]** or **[enable]**.
3. Disabled channels are skipped during alert dispatch but are not deleted.

### Deleting a channel

Deleting a channel is a soft delete -- the channel record is retained with a
`deletedAt` timestamp but no longer appears in listings or receives notifications.
Only administrators can delete channels.

1. Navigate to **Settings** and select the **channels** section.
2. Locate the channel and select **[delete]**.
3. Confirm the deletion.

### Updating a channel

You can update the channel name, configuration, and enabled status at any time.

1. Navigate to **Settings** and select the **channels** section.
2. Select the channel you want to modify.
3. Update the name, recipients, URL, or other configuration fields.
4. Save the changes.

When you update a webhook channel's configuration, the existing secret is
preserved unless you explicitly provide a new one. If you provide a new secret, it
replaces the old one and is encrypted before storage.

### Role requirements

- **Creating channels** requires the `admin` or `editor` role.
- **Deleting channels** requires the `admin` role.
- **Testing channels** requires the `admin` or `editor` role.
- **Viewing channels** requires any authenticated role.
