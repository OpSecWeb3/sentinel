# Initial Setup

After you install Sentinel and log in for the first time, complete this initial setup to prepare your organization for active monitoring. This guide covers your organization structure, inviting team members, assigning roles, and configuring your first notification channel.

## Your Organization in Sentinel

Sentinel is multi-tenant. Every piece of data in Sentinel -- detections, alerts, channels, integrations, and correlation rules -- belongs to exactly one organization. Members of your organization can see and manage only the data within it. Users from other organizations cannot access your data. This isolation is enforced at the database level, not just the application layer.

When you registered as the first user, Sentinel created your organization automatically using the name you provided. The organization has a **slug** -- a lowercase, URL-safe identifier derived from the name (for example, `Acme Security` becomes `acme-security`). You can review your organization name at any time in **Settings**.

## Inviting Team Members

After completing first-user registration, Sentinel generated an **invite secret** for your organization. Any person who has this secret can register a new account and automatically join your organization as a **viewer**.

To invite a team member:

1. Share the invite secret with the person you want to invite (for example, via a password manager or secure message). If you need to retrieve the secret, navigate to **Settings** in the sidebar -- only admins can view it.
2. Tell them to go to the registration page at `/register`.
3. On the registration page, they should click the **join-org** mode toggle at the top of the form.
4. They enter their **username**, **email**, **password**, and paste the **invite secret** into the invite secret field.
5. Click **Register**.

Once they register, their account is immediately part of your organization with the **viewer** role. You can then change their role as described in the next section.

> **Note:** The invite secret grants access to your organization. Treat it like a credential. If it is ever compromised, regenerate it immediately from **Settings**. Existing members are not affected when you regenerate it -- only the ability to register new accounts with the old secret is revoked.

## Understanding Roles

Sentinel enforces role-based access control (RBAC) across the platform. Every member of your organization has exactly one role. The three roles are:

### Admin

Admins have full control over the organization. An admin can:

- Create, edit, and delete detections, correlation rules, and notification channels
- Invite and remove team members, and change member roles
- Manage integrations (GitHub App installations, AWS, chain contracts)
- View, filter, and search all alerts
- Regenerate the invite secret
- Create, list, and revoke API keys
- Generate and rotate the notify key (used for external webhook integrations)
- Delete the organization

Assign the **admin** role to security leads and platform owners who are responsible for the Sentinel configuration.

### Editor

Editors can manage the detection and notification configuration, but cannot change organization settings or manage team membership. An editor can:

- Create, edit, and delete detections, correlation rules, and notification channels
- View, filter, and search all alerts
- View integrations (but not add or remove them)

Assign the **editor** role to security engineers who tune detection rules and maintain channels but do not need access to organization administration.

### Viewer

Viewers have read-only access to the organization. A viewer can:

- View, filter, and search all alerts
- View detections and correlation rules (but not modify them)
- View configured channels (but not modify them)

Assign the **viewer** role to stakeholders such as compliance officers, executives, or developers who need visibility into security alerts without the ability to change the configuration.

### Changing a Member's Role

To change a team member's role:

1. Navigate to **Settings** in the sidebar.
2. Find the **Members** section.
3. Locate the member whose role you want to change.
4. Select the new role: **admin**, **editor**, or **viewer**.

You cannot change your own role. Sentinel also prevents you from demoting the last admin -- at least one admin must exist in the organization at all times.

When you change a member's role, all of their active sessions are immediately invalidated. They need to log in again, and the new role takes effect on their next login.

## Setting Up Your First Notification Channel

A notification channel is the destination where Sentinel sends alerts -- a Slack channel, a set of email addresses, or a custom webhook endpoint. Detections that are not linked to any channel still create alert records in the database, but no external notification is sent. Set up at least one channel before you activate your first detection.

Sentinel supports email and webhook channel types through the channels management page. Slack channels require a separate OAuth installation.

### Adding a Webhook Channel

1. Navigate to `/channels` in your browser (or access the channels page from **Settings**).
2. Click **+ New Channel**.
3. Make sure the **[webhook]** type is selected (this is the default).
4. Enter a descriptive **name** for the channel (for example, `PagerDuty Integration`).
5. Enter the destination **URL** (for example, `https://hooks.example.com/sentinel`).
6. Click **Create**.

Sentinel creates the channel and displays it in the channel list. If a webhook signing secret is generated, it is shown once -- copy it immediately.

You can send a test notification to verify the channel is working by clicking **[test]** next to the channel in the list.

### Adding an Email Channel

1. Navigate to `/channels`.
2. Click **+ New Channel**.
3. Click the **email** type toggle to switch from webhook to email.
4. Enter a descriptive **name** (for example, `Security Team Email`).
5. Enter one or more **recipient email addresses**, separated by commas.
6. Click **Create**.

For email to work, you must configure `SMTP_URL` and `SMTP_FROM` in your `.env` file. See [Installation](installation.md) for details.

### Adding a Slack Channel

To send alerts directly to a Slack channel using the Slack API (not a webhook URL):

1. Complete the Slack OAuth installation flow. Navigate to **Settings** and click **Install Slack App**. Authorize the Sentinel bot in your Slack workspace.
2. Navigate to `/channels`.
3. Click **+ New Channel**.
4. Sentinel offers Slack as a channel type after the OAuth installation is complete.
5. Enter the Slack **channel ID** (the alphanumeric identifier, for example `C01ABCDEF`).
6. Click **Create**.

For full details on the Slack integration, see [Slack Integration](../integrations/slack.md).

### Managing Channels

Each channel in the list shows its type, status (enabled or disabled), and configuration details (webhook URL or email recipients). You can:

- **[test]** -- Send a test notification to verify the channel is reachable.
- **[disable]** / **[enable]** -- Temporarily disable a channel without deleting it. Disabled channels are skipped during notification dispatch.
- **[delete]** -- Permanently remove the channel. Sentinel asks for confirmation before deleting.

## Adding Your First Integration

Sentinel monitors external systems through integrations. Each integration connects Sentinel to a data source:

- **GitHub** -- Install the Sentinel GitHub App in your organization. Navigate to the **github** section in the sidebar, then click **installations** to begin.
- **Chain (EVM)** -- Register blockchain networks and contract addresses. Navigate to **chain** > **contracts** to add a monitored contract.
- **Infrastructure** -- Add hosts for monitoring. Navigate to **infra** > **hosts**.
- **Registry** -- Add Docker images or npm packages to monitor. Navigate to **registry** > **docker images** or **registry** > **npm packages**.
- **AWS** -- Configure CloudTrail event ingestion. Navigate to **aws** > **integrations**.

You do not need to configure all integrations at once. Start with the module that is most relevant to your security priorities and add others later.

## Organization Settings Reference

The **Settings** page (accessible from the sidebar) exposes the following organization-level controls:

### Invite Secret Management

The invite secret is a shared credential that allows new users to join your organization. You can regenerate it at any time. After regeneration, the old secret is immediately invalid. Share the new secret with anyone you intend to invite.

### API Key Management

Sentinel supports API keys for programmatic access (for example, querying alerts from a CI pipeline or SIEM integration). API keys carry scoped permissions:

- **api:read** -- Read-only access to query detections, alerts, and other resources.
- **api:write** -- Read and write access, including creating detections and managing configuration.

To create an API key:

1. Navigate to **Settings**.
2. Find the **API Keys** section.
3. Click **New API Key**.
4. Give the key a descriptive name.
5. Select the scopes the key should have.
6. Optionally, set an expiration period in days.
7. Click **Create**.
8. Copy the generated key immediately -- it is shown only once and cannot be retrieved later.

To revoke an API key, find it in the key list and click **Revoke**. Revoked keys are immediately invalid.

### Notify Key

The notify key is a separate credential used to authenticate external webhook deliveries to Sentinel (for example, GitHub webhook payloads). It is distinct from API keys. You can generate, rotate, or revoke the notify key from **Settings**.

### Password Management

You can change your password from **Settings**. Changing your password invalidates all of your other active sessions (on other devices or browsers) while keeping your current session active.
