# Slack integration

This guide explains how to connect Sentinel to your Slack workspace so that alerts are delivered to Slack channels in real time.

## What the Slack integration provides

When Slack is connected, Sentinel can send alert notifications to one or more Slack channels. Each notification includes the alert title, severity, module, and a link back to the alert detail view in Sentinel. You can route different detections and correlation rules to different channels -- for example, critical GitHub alerts to a `#security-critical` channel and low-severity infrastructure alerts to a `#security-audit` channel.

Sentinel requests the following Slack OAuth scopes:

| Scope | Purpose |
|---|---|
| `chat:write` | Post alert messages to channels |
| `channels:read` | List and search public channels for channel selection |
| `groups:read` | List and search private channels the bot has been invited to |

## Prerequisites

- You have the **admin** role in your Sentinel organization (admin role is required to connect or disconnect Slack).
- Your Sentinel server administrator has configured the `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` environment variables.
- You have permission to add apps to the target Slack workspace.

## Step 1: Connect your Slack workspace

1. In Sentinel, navigate to **Settings** and select **Channels**.
2. Click **Add Slack** (or **Connect Slack Workspace** if no workspace is currently connected).
3. Sentinel generates an HMAC-signed OAuth state parameter for CSRF protection and redirects you to Slack's authorization page.
4. Sign in to Slack with an account that has permission to add apps to the workspace.
5. Review the permissions Sentinel requests and click **Allow**.
6. Slack redirects you back to Sentinel. Sentinel exchanges the authorization code for a bot token, encrypts the token at rest, and stores the workspace connection.
7. Your workspace name and ID now appear under **Settings > Channels**.

> **Note:** Only one Slack workspace can be connected per Sentinel organization. If you need to send alerts to channels in a different workspace, disconnect the current workspace first and reconnect the new one.

> **Security note:** The OAuth state parameter expires after 10 minutes. Sentinel also validates that the user who initiated the flow still has an active membership in the organization before storing the token. If the user's membership is revoked between initiating the flow and completing it, the connection is rejected.

## Step 2: Choose channels for alerts

After connecting your Slack workspace, you assign Slack channels to individual detections and correlation rules. When a detection or correlation rule fires, Sentinel sends the alert to the assigned Slack channel.

### Assigning a Slack channel when creating a detection

1. Navigate to **Detections** and click **New Detection** (or edit an existing detection).
2. In the detection form, locate the **Slack Channel** field.
3. Begin typing the channel name. Sentinel searches your connected workspace for matching channels (minimum 2 characters). Both public and private channels are included in the search results.
4. Select the target channel from the dropdown.
5. Save the detection.

### Assigning a Slack channel to a correlation rule

Correlation rules support the same Slack channel assignment. When editing a correlation rule, select the target channel in the **Slack Channel** field.

### Searching for channels

The channel search queries the Slack API using the `conversations.list` endpoint with a client-side filter. Results include:

- Public channels visible to the Sentinel bot.
- Private channels the Sentinel bot has been invited to.

Up to 50 matching channels are returned per search. If you do not see the expected channel, confirm the bot has been invited to it (for private channels) or that the channel name matches your search query.

> **Important:** For private channels, you must manually invite the Sentinel Slack bot before it can post messages. In Slack, open the target channel, type `/invite @SentinelBot` (replace `SentinelBot` with the name of your Sentinel Slack app), and press Enter.

## Alert message format in Slack

When an alert fires and is routed to a Slack channel, Sentinel posts a message containing:

- **Alert title**: A concise description of what was detected.
- **Severity badge**: The alert severity level (critical, high, medium, or low).
- **Module**: The module that generated the alert (for example, GitHub, Chain, Registry, AWS, Infra).
- **Detection name**: The name of the detection or correlation rule that triggered the alert.
- **Link**: A direct URL to the alert detail page in Sentinel.
- **Trigger data**: Key contextual fields from the triggering event, formatted for quick triage.

Messages are posted using the bot token. The bot's display name and avatar are configured in your Slack app settings.

## Disconnecting Slack

Only users with the **admin** role can disconnect the Slack integration.

1. In Sentinel, navigate to **Settings** and select **Channels**.
2. Click **Disconnect Slack**.

When the workspace is disconnected:

- The encrypted bot token is deleted from the database.
- All Slack channel references on detections and correlation rules are cleared (set to null).
- Future alerts are not delivered to Slack until a new workspace is connected and channels are re-assigned.

> **Warning:** Disconnecting Slack immediately clears all Slack channel assignments on every detection and correlation rule in your organization. You must reassign channels after reconnecting.

## Viewing connection status

To check whether Slack is currently connected:

1. Navigate to **Settings** and select **Channels**.
2. The connection status shows whether a workspace is connected, including the team name, team ID, and the date the connection was established.

Alternatively, make a GET request to the `/integrations/slack` API endpoint to retrieve the connection status programmatically.

## Troubleshooting

### The Sentinel bot is not posting to the channel

1. Confirm the Sentinel bot is a member of the channel. For private channels, use `/invite @SentinelBot` in Slack.
2. Check the alert's notification delivery record in Sentinel for an error message. Common Slack API errors include:
   - `channel_not_found` -- the channel ID stored in the detection does not match a channel in the workspace.
   - `not_in_channel` -- the bot has not been invited to the private channel.
   - `token_revoked` -- the bot token has been revoked. Reconnect the workspace.

### Notifications stopped working after previously succeeding

The most common cause is a revoked bot token. This can happen when:

- A Slack workspace admin revokes the Sentinel app's access.
- The Slack app is uninstalled from the workspace.

To fix this:

1. In Sentinel, navigate to **Settings > Channels**.
2. If the workspace still appears as connected, click **Disconnect Slack** to clear the stale token.
3. Click **Add Slack** to reconnect and complete the OAuth flow again.
4. Reassign Slack channels to your detections and correlation rules.

### Channel search returns no results

- Ensure you have typed at least 2 characters in the search field. Sentinel requires a minimum query length.
- Confirm the Sentinel bot has been added to any private channels you want to find.
- Sentinel pages through up to 5 pages of Slack channel results (up to 1000 channels). If your workspace has more channels than this, the search may not find channels beyond that limit. Use a more specific search query.

### Alert delivery is delayed

Sentinel delivers Slack notifications asynchronously through a job queue. Delays of more than a few minutes typically indicate a worker queue backlog, not a Slack connectivity issue. Check your Sentinel worker health and queue depth if you suspect congestion.
