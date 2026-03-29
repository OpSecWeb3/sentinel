# Slack Integration

This guide explains how to connect Slack to Sentinel so that security alerts
are delivered to your team's channels in real time.

## Prerequisites

- A Sentinel account with the **Admin** role in your organization.
- Permission to install Slack apps in your Slack workspace (Slack admin or
  workspace owner approval may be required).
- The Sentinel server must have `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`
  environment variables configured. If you see "Slack not configured on this
  server," contact your Sentinel administrator.

## Connecting Slack

1. Open the Sentinel web console and navigate to **Settings**.
2. In the **Slack** section, click **Connect Slack**.
3. Sentinel redirects you to the Slack OAuth authorization page.
4. Select the Slack workspace where you want to receive alerts.
5. Review the requested permissions and click **Allow**.
6. Slack redirects you back to Sentinel. A success banner confirms the
   connection.

Sentinel stores an encrypted bot token that allows it to post messages to
channels the bot has been invited to. Only one Slack workspace can be connected
per Sentinel organization at a time. Connecting a new workspace replaces the
previous connection.

### OAuth permissions

Sentinel requests the following Slack OAuth scopes:

| Scope | Purpose |
|---|---|
| `chat:write` | Post alert messages to channels |
| `channels:read` | List public channels for the channel picker |
| `groups:read` | List private channels for the channel picker |

The bot does not read message history, manage users, or modify channel
settings.

## Selecting channels for notifications

After connecting Slack, you can assign notification channels at two levels:

### Per-detection channel assignment

1. Navigate to a detection's detail page (for example, **GitHub > Detections >
   Repository Visibility Monitor**).
2. In the **Notifications** section, search for a Slack channel by name.
3. Select the channel from the dropdown.
4. Click **Save**.

All alerts fired by that detection will be posted to the selected channel.

### Notification channels (advanced)

Sentinel also supports creating named notification channels that can be shared
across multiple detections:

1. Navigate to **Settings > Notification Channels**.
2. Click **Create Channel**.
3. Set **Type** to **Slack**.
4. Enter the Slack channel ID (the channel picker searches by name and returns
   the ID automatically).
5. Click **Save**.

You can then reference this notification channel when creating or editing
detections.

### Searching for channels

The channel search endpoint queries the Slack API in real time. Type at least
two characters to see results. Sentinel searches both public and private
channels (the bot must be a member of private channels to post to them).

Results are limited to 50 channels. If your workspace has many channels, use a
more specific search term.

## What Slack messages look like

When a detection fires, Sentinel posts a structured message to the assigned
channel containing:

- **Title** -- the alert name (for example, "Repository Visibility Monitor").
- **Severity** -- color-coded: critical (red), high (orange), medium (yellow),
  low (gray).
- **Description** -- a summary of what triggered the alert.
- **Module** -- which Sentinel module generated the alert (for example,
  "github", "chain", "aws").
- **Event type** -- the specific event that triggered the detection.
- **Timestamp** -- when the event occurred (ISO 8601).

### Test notifications

Before relying on a channel for production alerts, send a test message:

1. Navigate to **Settings > Notification Channels**.
2. Locate the Slack channel and click **Test**.
3. Sentinel sends a test notification with the title "Test Notification from
   Sentinel."
4. Verify the message appears in the expected Slack channel.

If the test fails, Sentinel returns a 502 error. Check that:

- The Sentinel bot has been invited to the target channel.
- The Slack connection is still active (token has not been revoked).

## Customizing Slack alert format

Sentinel uses a standard Slack message format for all alerts. Customization
is available through notification channel configuration:

- **Webhook-based channels** allow you to configure custom HTTP headers and
  route alerts through a middleware service that reformats messages before
  forwarding to Slack.
- **Slack-type channels** post directly using the Slack API and use the
  built-in format.

To fully customize message formatting, create a **Webhook** notification
channel that points to a Slack-compatible incoming webhook URL or your own
middleware endpoint, and apply your formatting logic there.

## Disconnecting Slack

1. Navigate to **Settings**.
2. In the **Slack** section, click **Disconnect**.
3. Confirm the action.

Disconnecting Slack:

- Deletes the encrypted bot token from Sentinel.
- Clears Slack channel references from all detections and correlation rules.
  These detections continue to run but will not send Slack notifications until
  a new channel is assigned.

Only users with the **Admin** role can disconnect Slack.

## Troubleshooting

### "Slack is not connected" when searching channels

Your organization does not have an active Slack connection. Follow the steps in
"Connecting Slack" above.

### "Failed to fetch channels from Slack" (HTTP 502)

Sentinel received an error from the Slack API. Possible causes:

- The bot token was revoked. Disconnect and reconnect Slack.
- The Slack workspace is on a plan that restricts API access.
- Transient Slack API outage. Retry after a few minutes.

### Test notification fails

1. Confirm the notification channel is **enabled** (disabled channels cannot
   send tests).
2. Verify the bot has been invited to the target Slack channel. Open the
   channel in Slack and type `/invite @Sentinel` (or the bot's display name).
3. Check that the Slack connection is still valid under **Settings > Slack**.

### OAuth callback lands on an error page

Check the `reason` query parameter in the redirect URL:

| Reason | Meaning |
|---|---|
| `missing_params` | Slack did not return an authorization code. Retry the flow. |
| `invalid_state` or `invalid_signature` | The CSRF state token is malformed or tampered. Clear cookies and retry. |
| `expired_state` | More than 10 minutes passed since you started the flow. Retry. |
| `session_mismatch` | The logged-in user changed between starting and completing the OAuth flow. Log in with the original account and retry. |
| `unauthorized` | The user who started the flow was removed from the Sentinel organization before completing it. |
| `not_configured` | The Sentinel server does not have Slack credentials configured. Contact your administrator. |
| `token_exchange_failed` | Slack rejected the authorization code. The code may have expired. Retry. |

### Messages are not delivered to a specific channel

1. Verify the detection has a Slack channel assigned. Navigate to the
   detection's detail page and check the **Notifications** section.
2. Verify the bot is a member of the channel. Private channels require an
   explicit `/invite`.
3. Check the Sentinel worker logs for errors related to Slack message delivery.

### "Cannot test a disabled channel"

Enable the notification channel before sending a test. Navigate to **Settings >
Notification Channels**, locate the channel, and toggle it to enabled.
