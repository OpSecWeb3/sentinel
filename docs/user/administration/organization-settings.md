# Organization settings

This page describes the organization-level settings available to administrators. Only users with the **admin** role can access these settings.

## Accessing organization settings

1. In the top navigation, click **Settings**.

The **Settings** page opens to the **Members** tab by default. Use the tab bar to navigate between sections.

---

## Organization name and slug

Your organization has a human-readable **name** (for example, `Acme Security`) and a URL-safe **slug** derived from it at creation time (for example, `acme-security`). The slug is computed by lowercasing the organization name and replacing non-alphanumeric characters with hyphens.

The slug identifies your organization in internal references and cannot be changed after creation. The organization name is displayed in the Sentinel interface. To update the name, contact your Sentinel platform operator -- name changes require a direct database update.

---

## API key management

API keys allow programmatic access to the Sentinel API. Each key is owned by a user, scoped to the organization, and carries explicit permission scopes.

### Available scopes

| Scope | Description |
|---|---|
| `api:read` | Read-only access: list detections, events, alerts, and audit logs |
| `api:write` | Read and write access: create and delete detections, channels, and keys |

### Creating an API key

1. In **Settings**, select the **API Keys** tab.
2. Enter a descriptive name for the key (for example, `ci-pipeline` or `grafana-dashboard`).
3. Select the required scopes. Default scope is `api:read`.
4. Optionally, set an expiry by entering the number of days until the key expires.
5. Click **Create**.

The full key value is shown once immediately after creation. Copy it to a secure secrets store before closing the dialog. Sentinel stores only a SHA-256 hash of the key and cannot display the full value again.

API keys use the prefix `sk_` followed by a short identifier prefix. You can identify a key by its prefix -- for example, `sk_abc123...` -- without exposing the full secret.

> **Warning:** Save the key immediately. The raw key value cannot be retrieved after the creation dialog is closed.

### Viewing existing keys

The **API Keys** tab lists all keys for your organization with the following fields:

| Field | Description |
|---|---|
| **Name** | The label you assigned at creation |
| **Prefix** | The first few characters of the key, for identification |
| **Scopes** | The permissions granted |
| **Last used** | When the key was most recently used for authentication |
| **Expires** | The expiry date, or blank if no expiry is set |
| **Status** | Active or revoked |

### Revoking an API key

1. In **Settings**, select the **API Keys** tab.
2. Find the key you want to revoke.
3. Click **Revoke**.

Revocation is immediate. Any request made with the revoked key returns a `401 Unauthorized` error. Revoked keys remain visible in the list for auditing purposes but cannot be reactivated.

Revoking a key requires the `api:write` scope (for API-based revocation) or the admin role (for UI-based revocation).

---

## Webhook secret rotation

The webhook secret authenticates inbound webhook payloads delivered to Sentinel from external services (Docker Hub, npm). Sentinel uses this secret to compute and verify HMAC-SHA256 signatures on incoming requests.

### Viewing the webhook configuration

1. In **Settings**, select the **Webhook** tab.

The page displays:

- **Docker webhook URL**: The endpoint to configure in Docker Hub, in the format `https://<sentinel-host>/modules/registry/webhooks/docker`.
- **npm webhook URL**: The endpoint for npm webhook delivery, in the format `https://<sentinel-host>/modules/registry/webhooks/npm`.
- **Secret status**: Whether a secret is currently configured, shown by the first 8 characters of the secret followed by `...`.

### Generating or rotating the webhook secret

1. In **Settings**, select the **Webhook** tab.
2. Click **Rotate Secret**.

A new secret is generated with the prefix `whsec_` followed by 64 hex characters. The full secret is shown once. Copy it immediately and update it in all external services that send webhooks to Sentinel.

> **Warning:** After rotation, requests signed with the old secret are rejected immediately. Update the secret in Docker Hub, npm, and any other webhook sources before the next delivery attempt. Plan rotations during maintenance windows if continuous ingestion is critical.

---

## Notify key management

The notify key is an organization-level credential that authorizes CI pipeline notifications to the Sentinel registry module. It is distinct from user API keys and from the webhook secret.

### Purpose

The notify key authenticates the `POST /modules/registry/ci/notify` endpoint. CI pipelines (such as GitHub Actions) include the notify key as a Bearer token when reporting artifact pushes to Sentinel. This allows Sentinel to attribute registry changes to specific CI runs.

### Checking notify key status

1. In **Settings**, select the **Notify Key** tab.

The page shows:

- Whether a key exists.
- The key's identifying prefix.
- The last time the key was used to authenticate a request.

### Generating a notify key

If no notify key exists:

1. Click **Generate notify key**.
2. The full key value is shown once. Store it in your CI/CD secrets manager as `SENTINEL_NOTIFY_KEY`.

If a key already exists, the generate operation is rejected. Use **Rotate** to replace the existing key.

### Rotating the notify key

1. Click **Rotate notify key**.
2. The previous key is immediately invalidated.
3. The new key is shown once. Update the `SENTINEL_NOTIFY_KEY` secret in your CI/CD pipelines.

### Revoking the notify key

To disable all notify-key-authenticated ingestion without issuing a replacement:

1. Click **Revoke**.

This clears the key hash, prefix, and last-used timestamp. CI notifications will fail with a `401 Unauthorized` response until a new key is generated.

---

## Data retention settings

Sentinel automatically purges old data on a daily schedule. The default retention periods are:

| Data type | Default retention |
|---|---|
| Events | 90 days |
| Alerts | 365 days |
| Notification delivery records | 30 days |
| Expired sessions | Purged daily |
| Audit log | Retained indefinitely |

Individual modules may define additional retention policies for their own data tables. For example, the AWS module retains raw CloudTrail events for 7 days before purging unpromoted records.

> **Note:** Retention policies are managed at the platform level. Contact your Sentinel platform operator to change retention periods. Changes require editing the worker configuration and redeploying the worker service.

---

## Deleting the organization

Only admins can delete an organization.

1. In **Settings**, navigate to the organization management section.
2. Click **Delete Organization**.
3. Confirm the deletion.

When an organization is deleted:

- All sessions for all members are invalidated immediately.
- All organization data (detections, rules, events, alerts, memberships, API keys, integrations) is deleted via database cascading.
- This action is irreversible.

---

## Integration credentials

Sentinel integrations are configured per-module through the **Settings** page. The following integration-specific sections are available:

| Section | Description |
|---|---|
| **Slack** | Connect Sentinel to your Slack workspace via OAuth. Used to deliver alert messages to Slack channels. |
| **GitHub** | Connect the GitHub App for repository monitoring and webhook event ingestion. |
| **AWS** | Configure AWS SQS polling for CloudTrail event ingestion. |
| **Webhook** | Configure the inbound webhook endpoint and secret used by the registry module. |
| **Chain Networks** | Configure EVM blockchain RPC endpoints used by the chain module. |

Each section is accessible from the **Settings** tab bar. Only admins can create, update, or remove integration credentials. Credentials (tokens, secrets, keys) are stored encrypted at rest and are never displayed in full after initial entry.
