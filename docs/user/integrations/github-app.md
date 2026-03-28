# GitHub App integration

This guide explains how to connect Sentinel to your GitHub organization using a GitHub App. After completing this setup, Sentinel monitors your organization's repositories, members, branch protections, deploy keys, secret scanning alerts, force pushes, and organization-level settings in real time.

## What Sentinel monitors

When the GitHub App integration is active, Sentinel ingests webhook events from your GitHub organization and evaluates them against your configured detections. Sentinel monitors the following:

- **Repository visibility changes**: Detects when a repository is made public or private.
- **Branch protection rules**: Detects when branch protections are created, modified, or deleted.
- **Member changes**: Detects when users are added to or removed from repositories and the organization.
- **Deploy keys**: Detects when deploy keys with write access are added or removed.
- **Secret scanning alerts**: Detects when GitHub identifies a leaked credential in a commit.
- **Force pushes**: Detects when a force push targets a protected branch such as `main`, `master`, `release/*`, or `production`.
- **Organization and team events**: Detects organization membership changes, team creation and deletion, and organization-level administrative actions.

Sentinel also performs a periodic repository sync to maintain an up-to-date list of repositories and their settings. The sync runs automatically after installation and can be triggered on demand.

## Prerequisites

Before you begin, confirm the following:

- You have owner or admin access to the GitHub organization you want to monitor.
- You have the **admin** role in your Sentinel organization.
- Your Sentinel instance is accessible from the public internet, or from GitHub's webhook delivery IP ranges, to receive webhook events.
- Your Sentinel server administrator has configured the `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_SLUG` environment variables.

## Step 1: Install the GitHub App via OAuth flow

The OAuth-assisted flow is the recommended setup path for GitHub.com. Sentinel handles the full installation lifecycle automatically.

1. In Sentinel, navigate to **Settings** and select **GitHub**.
2. Click **Connect GitHub App**. Sentinel generates an HMAC-signed state parameter for CSRF protection and redirects you to GitHub.
3. On GitHub, authorize the installation for your organization. Select **All repositories** or choose specific repositories to monitor.
4. GitHub redirects you back to Sentinel at the callback URL. Sentinel performs the following actions automatically:
   - Fetches installation details from the GitHub API, including the installation ID, target organization or user, permissions, and subscribed events.
   - Generates a unique HMAC-SHA256 webhook secret for the installation and encrypts it at rest.
   - Stores the installation record in the database.
   - Queues a background repository sync job.
5. You are redirected to the GitHub settings page in Sentinel, which displays the connected installation.

> **Note:** The OAuth state parameter expires after 10 minutes. If you do not complete the flow within that time, return to Sentinel and start again.

### Manual setup (GitHub Enterprise Server or custom installations)

If your organization uses GitHub Enterprise Server or the OAuth flow is not available, you can register an installation manually.

1. In Sentinel, navigate to **Settings** and select **GitHub**, then click **Add Installation Manually**.
2. Enter the following values:
   - **Installation ID**: The numeric GitHub App installation ID. Find this in the URL after installing the App on GitHub, for example `https://github.com/organizations/your-org/settings/installations/12345678`.
   - **Webhook secret**: A strong random string of at least 20 characters. You must configure the same secret in your GitHub App's webhook settings.
   - **Base URL** (optional): Required only for GitHub Enterprise Server. Enter the GHE base URL, for example `https://github.example.com`.
3. Click **Save**. Sentinel encrypts the webhook secret, verifies the installation with the GitHub API, and queues a repository sync.

> **Warning:** The webhook secret must be at least 20 characters. Sentinel uses HMAC-SHA256 to verify all incoming webhook deliveries. If this secret does not match the value configured on the GitHub App, all webhooks are rejected with a 401 response.

## Step 2: Configure the GitHub App permissions

If you are creating a new GitHub App (rather than using Sentinel's managed App), configure the following permissions:

### Required permissions

| Permission | Access level | Purpose |
|---|---|---|
| **Contents** | Read-only | Read repository content for sync operations |
| **Members** | Read-only | Monitor organization membership changes |
| **Administration** | Read-only | Monitor repository settings and organization-level configuration |
| **Metadata** | Read-only | Required by GitHub for all Apps |
| **Secrets** | Read-only | Receive secret scanning alert events |

### Subscribed webhook events

| Event | What Sentinel monitors |
|---|---|
| `repository` | Visibility changes (public/private) |
| `branch_protection_rule` | Creation, modification, and deletion of branch protection rules |
| `member` | Members added to or removed from repositories |
| `organization` | Organization-level member and team events |
| `team` | Team creation, deletion, and membership changes |
| `deploy_key` | Deploy key creation and deletion |
| `secret_scanning_alert` | New and resolved secret scanning alerts |
| `push` | Force pushes to protected branches |

> **Note:** Some events only become available after you grant the corresponding permission. If you do not see a particular event in your GitHub App settings, confirm that the related permission is enabled.

## Step 3: Configure the webhook URL

After completing the Sentinel setup, you receive a webhook endpoint URL in the format:

```
https://<your-sentinel-host>/modules/github/webhooks/<installation-uuid>
```

The `<installation-uuid>` is the Sentinel-internal UUID for the installation, not the GitHub installation ID. You can find this value on the GitHub installation detail page in Sentinel.

1. Return to your GitHub App settings at `github.com/organizations/<org>/settings/apps/<app-slug>`.
2. Under **Webhook**, paste the Sentinel URL into the **Webhook URL** field.
3. Paste your webhook secret into the **Webhook secret** field.
4. Set **SSL verification** to **Enable SSL verification** unless you are running Sentinel on a non-public network with a self-signed certificate.
5. Click **Save changes**.

## Step 4: Configure repository monitoring

After the initial repository sync completes, Sentinel maintains a list of all repositories accessible through the installation. You can view and manage tracked repositories in Sentinel.

### Viewing tracked repositories

1. Navigate to the GitHub module page in Sentinel.
2. Select **Repositories**. The list shows all synced repositories with their metadata.

### Triggering a manual repository sync

If you have added new repositories to the GitHub App installation and want Sentinel to pick them up immediately:

1. Navigate to the GitHub module page.
2. Find the installation and click **Sync Repositories**.
3. Sentinel queues a sync job. The sync uses a deduplication job ID to prevent concurrent sync requests from creating duplicate work.

### Filtering synced repositories

When triggering a sync, you can provide optional filter criteria to control which repositories are synced. This is useful for large organizations with hundreds of repositories where you only want to monitor a subset.

## Webhook event processing

Sentinel enforces the following protections on incoming GitHub webhooks:

- **HMAC-SHA256 signature verification**: Every webhook delivery must include a valid `X-Hub-Signature-256` header. Sentinel rejects unsigned or incorrectly signed payloads with a 401 response.
- **Rate limiting**: Sentinel enforces a rate limit of 100 webhook requests per minute per source IP address.
- **Body size limit**: Webhook payloads are limited to 5 MB.
- **Deduplication**: Sentinel uses the `X-GitHub-Delivery` header as a job ID to prevent duplicate processing of retried webhook deliveries.

## Detection templates

Sentinel provides pre-built detection templates for the GitHub module. To view available templates:

1. Navigate to the GitHub module page.
2. Select **Templates**.

Templates include pre-configured rules for common security monitoring scenarios such as branch protection changes, force push detection, and secret scanning.

## Testing the integration

To confirm that events are flowing from GitHub to Sentinel:

1. In your GitHub organization, go to any repository's settings and make a non-critical change -- for example, rename a team or add yourself as a collaborator, then immediately remove yourself.
2. Wait 30 to 60 seconds, then navigate to the **Alerts** page in Sentinel.
3. Filter by **Module: github** and check for a new alert corresponding to the change you made.
4. If no alert appears, navigate to your GitHub App settings and select the **Advanced** tab. Under **Recent Deliveries**, inspect individual webhook deliveries and their HTTP response codes. A `202 Accepted` response indicates Sentinel received the payload successfully.

> **Note:** Detection rules must be active for events to produce alerts. If you have not yet created any detections for the GitHub module, no alerts appear even if events are being ingested. See [Using Detection Templates](../detections/using-templates.md) or [Custom Rules](../detections/custom-rules.md) to configure your first GitHub detection.

## Troubleshooting

### Webhooks return 401 Unauthorized

- Confirm the webhook secret in your GitHub App settings matches the secret stored in Sentinel. If you rotated the secret in Sentinel, update it in GitHub as well.
- Check that the webhook URL path contains the correct Sentinel installation UUID, not the GitHub numeric installation ID.

### Webhooks return 429 Too Many Requests

Sentinel enforces a rate limit of 100 webhook deliveries per minute per source IP. If you receive 429 responses, your GitHub organization may be generating webhook traffic faster than the limit allows. Contact your Sentinel administrator to adjust the rate limit.

### Repository sync does not complete

- Verify that the GitHub App installation has the **Contents** permission set to read-only.
- Check the Sentinel worker logs for errors related to the `github.repo.sync` job.
- Ensure the GitHub API is accessible from your Sentinel server. If you are behind a corporate firewall, allow outbound HTTPS to `api.github.com`.

### No alerts appear despite active detections

- Confirm that the detection's module is set to `github`.
- Verify the detection status is **active**.
- Check the events list in Sentinel to confirm that events are being ingested. If events appear but no alerts fire, review the detection's rule conditions.

### Installation shows "removed" status

An installation can enter the "removed" status if an administrator deletes it in Sentinel or if the GitHub App is uninstalled from the organization on GitHub's side. To reconnect, repeat the installation flow from Step 1.
