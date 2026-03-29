# GitHub App Integration

This guide explains how to connect Sentinel to your GitHub organizations and
repositories so that Sentinel can monitor security-relevant events in real time.

## Prerequisites

- A Sentinel account with the **Admin** role in your organization.
- Owner or admin access to the GitHub organization you want to monitor.
- The Sentinel instance must be reachable from the public internet (GitHub
  delivers webhooks over HTTPS).

## Installing the GitHub App

### Automated installation (recommended)

1. Open the Sentinel web console and navigate to **GitHub > Overview**.
2. Click **+ Install GitHub App**.
3. Sentinel redirects you to GitHub. Sign in if prompted.
4. Select the GitHub organization (or personal account) where you want to
   install the app.
5. Choose whether to grant access to **All repositories** or **Only select
   repositories**.
6. Click **Install**.
7. GitHub redirects you back to Sentinel. A success banner confirms the
   installation.

Sentinel automatically triggers a repository sync after installation. Within
a few seconds, the **Repositories** page shows every repository the app can
access.

> **Note:** The redirect URL includes a cryptographically signed state
> parameter that expires after 10 minutes. If you leave the GitHub
> authorization page open for longer than 10 minutes, restart the flow from
> Step 2.

### Manual installation (GitHub Enterprise Server)

If you run a self-hosted GitHub Enterprise Server instance, use the manual
setup endpoint instead.

1. Create a GitHub App on your GHES instance with the permissions listed in
   the section below.
2. Install the app on your organization and note the **installation ID**.
3. Generate a webhook secret (at least 20 characters).
4. In the Sentinel web console, navigate to **Settings > GitHub**.
5. Enter the **Installation ID** and **Webhook Secret**, then click
   **Save**.
6. Sentinel verifies the installation against the GitHub API and begins
   syncing repositories.

## Required GitHub App permissions

Sentinel requests the following permissions during installation:

| Permission | Access | Purpose |
|---|---|---|
| Repository metadata | Read | List repositories, detect visibility changes |
| Repository administration | Read | Branch protection rule changes |
| Organization members | Read | Member additions and removals |
| Organization administration | Read | Organization setting changes |
| Secret scanning alerts | Read | Detect exposed secrets |

Sentinel subscribes to these webhook event types:

- `repository` -- visibility, creation, deletion, archival, transfer, rename
- `member` -- collaborator added, removed, or permission changed
- `organization` -- member added, removed, invited
- `team` -- created, deleted, edited, repository access changed
- `branch_protection_rule` -- created, edited, deleted
- `deploy_key` -- created, deleted
- `secret_scanning_alert` -- created, resolved
- `push` -- code pushed (used for force-push detection)
- `installation` -- created, deleted, suspended, unsuspended

## Managing tracked repositories

After installation, Sentinel automatically syncs the list of accessible
repositories.

### Viewing repositories

1. Navigate to **GitHub > Repositories**.
2. The table shows each repository's name, visibility (public, private, or
   internal), and last sync timestamp.

### Triggering a manual sync

If repository access changed on the GitHub side (for example, you granted the
app access to additional repositories), trigger a sync manually:

1. Navigate to **GitHub > Installations**.
2. Locate the installation and click **Sync**.
3. Sentinel enqueues a background sync job. The repository list updates within
   a few seconds.

Sentinel deduplicates concurrent sync requests. If a sync is already running
for the same installation, the second request is silently dropped.

### Removing an installation

1. Navigate to **GitHub > Installations**.
2. Click **Delete** next to the installation you want to remove.
3. Confirm the deletion.

When you remove the last active installation for your organization, Sentinel
automatically pauses all GitHub detection rules. This prevents false negatives
from detections that no longer receive events.

## Available detection templates

Navigate to **GitHub > Templates** to see the full list. Sentinel ships with
the following built-in detection templates:

### Access control

| Template | Severity | Description |
|---|---|---|
| Repository Visibility Monitor | Critical | Alerts when a repository is made public. Prevents accidental exposure of private code. |
| Member Access Monitor | High | Alerts on member additions and removals. Tracks who has access to your repositories and organization. |
| Deploy Key Monitor | High | Alerts when deploy keys are added. Write-access keys are a common supply chain attack vector. |

### Code protection

| Template | Severity | Description |
|---|---|---|
| Branch Protection Changes | High | Alerts when branch protection rules are modified or removed. Detects weakening of code review requirements. |
| Force Push Detection | Critical | Alerts on force pushes to critical branches. Force pushes can rewrite history and bypass code review. |

### Secrets

| Template | Severity | Description |
|---|---|---|
| Secret Scanning Alerts | Critical | Alerts when GitHub detects exposed secrets. Immediate action required to rotate compromised credentials. |

### Organization

| Template | Severity | Description |
|---|---|---|
| Organization Settings Monitor | High | Alerts on organization and team changes. Tracks membership, team permissions, and org-level events. |

### Comprehensive

| Template | Severity | Description |
|---|---|---|
| Full GitHub Security Suite | Critical | Enables all GitHub security monitors in one detection. Covers visibility, access, branch protection, force pushes, secrets, and org changes. |

To activate a template:

1. Navigate to **GitHub > Templates**.
2. Click the template you want to enable.
3. Configure any required inputs (for example, branch patterns for force-push
   detection).
4. Optionally assign a Slack channel for notifications.
5. Click **Create Detection**.

## Webhook delivery

Sentinel receives GitHub webhooks at:

```
POST https://<your-sentinel-api>/modules/github/webhooks/<installation-id>
```

Each webhook is verified using HMAC-SHA256 with a per-installation secret that
Sentinel generates and encrypts at rest. Invalid signatures are rejected with
HTTP 401.

### Rate limiting

Sentinel enforces a rate limit of 100 webhook deliveries per source IP address
per 60-second window. If your GitHub instance exceeds this limit, Sentinel
returns HTTP 429. Contact your Sentinel administrator to adjust the limit if
needed.

### Deduplication

Sentinel uses the `X-GitHub-Delivery` header as a unique job identifier. If
GitHub retries a webhook delivery, Sentinel silently drops the duplicate.

## Troubleshooting

### "Missing required GitHub webhook headers" (HTTP 400)

GitHub did not send the expected `X-Hub-Signature-256`, `X-GitHub-Event`, or
`X-GitHub-Delivery` headers. Verify that:

- You are using the correct webhook URL.
- The webhook content type is set to `application/json` in your GitHub App
  settings.
- No proxy or load balancer is stripping headers.

### "Invalid signature" (HTTP 401)

The HMAC-SHA256 signature does not match. Possible causes:

- The webhook secret was rotated on the GitHub side but not updated in
  Sentinel. Re-run the installation flow to regenerate the secret.
- A proxy or WAF modified the request body after GitHub signed it.
- The installation was removed from Sentinel. Reinstall the GitHub App.

### Webhook returns HTTP 429

The source IP address exceeded the rate limit (100 requests per 60 seconds).
This can happen during large GitHub organization events (for example, bulk
repository transfers). Sentinel queues miss no events -- GitHub retries
delivery automatically. If the problem persists, ask your Sentinel
administrator to increase the `WEBHOOK_RATE_LIMIT`.

### Repository list is empty after installation

1. Confirm that the GitHub App has access to at least one repository. Check
   **GitHub > Settings > GitHub Apps > Sentinel > Repository access**.
2. Navigate to **GitHub > Installations** and click **Sync** to trigger a
   manual repository sync.
3. Check the Sentinel worker logs for errors related to
   `github.repo.sync` jobs.

### Detections are paused unexpectedly

When the last active GitHub installation is removed, Sentinel automatically
pauses all GitHub detections for your organization. To resume:

1. Reinstall the GitHub App (see "Installing the GitHub App" above).
2. Navigate to **Detections** and re-enable any paused GitHub detections.

### "GitHub App not configured on this server" (HTTP 501)

The Sentinel server does not have `GITHUB_APP_CLIENT_ID` and
`GITHUB_APP_SLUG` environment variables set. Contact your Sentinel
administrator.

### OAuth callback errors

If the GitHub redirect lands on an error page, check the `reason` query
parameter:

| Reason | Meaning |
|---|---|
| `missing_params` | GitHub did not include the installation ID or state. Retry the installation. |
| `invalid_state` | The CSRF state token is malformed. Clear cookies and retry. |
| `invalid_signature` | The CSRF state token signature is invalid. This may indicate a tampered URL. |
| `expired_state` | More than 10 minutes passed since you started the flow. Retry. |
| `user_mismatch` | The logged-in user does not match the user who initiated the flow. Log in with the correct account. |
| `github_api_error` | Sentinel could not reach the GitHub API. Check network connectivity and retry. |
| `queue_unavailable` | The background job queue is down. Contact your Sentinel administrator. |
