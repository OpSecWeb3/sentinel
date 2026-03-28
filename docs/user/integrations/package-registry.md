# Package registry integration

This guide explains how to use Sentinel to monitor Docker image registries and npm package registries for supply chain security events. Sentinel detects unauthorized changes, missing cryptographic signatures, absent provenance attestations, suspicious publish patterns, and npm-specific risk signals.

## What Sentinel monitors

Sentinel's registry module monitors the following event types:

| Event type | Description |
|---|---|
| `registry.docker.digest_change` | A Docker image tag changed to a different content digest |
| `registry.docker.new_tag` | A new Docker image tag appeared |
| `registry.docker.tag_removed` | An existing Docker image tag was deleted |
| `registry.npm.version_published` | A new npm package version was published |
| `registry.npm.version_deprecated` | An npm package version was deprecated |
| `registry.npm.version_unpublished` | An npm package version was unpublished |
| `registry.npm.maintainer_changed` | The maintainer list for an npm package changed |
| `registry.npm.dist_tag_updated` | An npm dist-tag was added or moved |
| `registry.verification.signature_missing` | A Docker image lacks a cosign signature |
| `registry.verification.provenance_missing` | An artifact lacks a SLSA provenance attestation |
| `registry.verification.signature_invalid` | A Docker image has an invalid or unverifiable signature |
| `registry.verification.provenance_invalid` | An artifact has an invalid provenance attestation |
| `registry.attribution.unattributed_change` | A push occurred without matching CI attribution |
| `registry.attribution.attribution_mismatch` | CI attribution data does not match the artifact |

## Supported registries

| Registry | Artifact type | Ingestion method |
|---|---|---|
| Docker Hub | Docker images | Webhook + polling |
| GitHub Container Registry (ghcr.io) | Docker images | Webhook + polling |
| npm Registry (registry.npmjs.org) | npm packages | Webhook + polling |

Sentinel uses polling as a fallback when webhooks are unavailable or fail to deliver. The polling interval is configurable per artifact.

## Prerequisites

- The **admin** role in your Sentinel organization (required to add artifacts).
- A webhook secret configured for your organization (for webhook-based ingestion). See [Organization Settings](../administration/organization-settings.md).
- A notify key configured for CI attribution (if you want CI pipeline attribution). See [CI/CD integration](#cicd-integration-notify-endpoint).

## Adding Docker images to monitor

1. In Sentinel, navigate to **Registry** and select **Images**.
2. Click **Add Image**.
3. Enter the following:
   - **Image name**: The full image name, for example `library/nginx` or `myorg/myapp`.
   - **Tag patterns**: Glob patterns for tags to watch. Default is `*` (all tags). Set specific patterns like `v*` to watch only version tags.
   - **Ignore patterns**: Glob patterns for tags to exclude from monitoring.
   - **Poll interval (seconds)**: How often Sentinel polls the registry. Minimum: 60 seconds. Default: 300 seconds (5 minutes).
   - **GitHub repo** (optional): The GitHub repository associated with this image, in `owner/repo` format. Used for CI attribution matching.
4. Click **Save**.

Sentinel performs a pre-flight check when the tag pattern is `*` (all tags). If the image has an excessive number of tags, Sentinel rejects the request and asks you to specify a more targeted tag pattern to avoid overwhelming the polling system.

### Setting credentials for private Docker images

For private Docker Hub repositories that require authentication:

1. Navigate to **Registry > Images** and find the image.
2. Click the image to open its detail view.
3. Select **Set Credentials**.
4. Enter the Docker Hub username and access token.
5. Click **Save**.

Sentinel encrypts the credentials at rest and uses them for polling. To remove credentials, select **Remove Credentials** on the same page.

### Managing Docker image configuration

You can update the following settings on a monitored image:

- **Tag watch patterns**: Change which tags are monitored.
- **Tag ignore patterns**: Add or remove exclusion patterns.
- **Enabled/disabled**: Temporarily disable polling without removing the image.
- **Poll interval**: Adjust the polling frequency.
- **GitHub repo**: Link or unlink a GitHub repository for attribution.
- **Webhook URL**: Set a custom webhook URL for this specific image.

To delete a Docker image from monitoring, click **Delete** on the image detail page. This performs a soft delete (disables the image) rather than removing the record.

## Adding npm packages to monitor

1. In Sentinel, navigate to **Registry** and select **Packages**.
2. Click **Add Package**.
3. Enter the following:
   - **Package name**: The npm package name, for example `@myorg/mypackage` or `express`.
   - **Tag patterns**: Glob patterns for versions or dist-tags to watch. Default is `*`.
   - **Ignore patterns**: Glob patterns for versions to exclude.
   - **Poll interval (seconds)**: Minimum: 60 seconds. Default: 300 seconds.
   - **GitHub repo** (optional): The GitHub repository in `owner/repo` format.
   - **Watch mode**: Choose between `versions` (monitor all published versions) or `dist-tags` (monitor only dist-tag changes like `latest`, `next`). Default: `versions`.
4. Click **Save**.

### Bulk importing npm packages from an organization scope

To monitor all packages under an npm scope:

1. Navigate to **Registry > Packages**.
2. Click **Import npm Scope**.
3. Enter the scope name, for example `@myorg`.
4. Select the default tag patterns and poll interval for all imported packages.
5. Click **Import**.

Sentinel queries the npm registry for all packages under the scope (up to 100 packages) and adds them to monitoring with `dist-tags` watch mode. Packages that already exist in Sentinel are skipped.

### Setting credentials for private npm packages

For private npm packages that require authentication:

1. Navigate to **Registry > Packages** and find the package.
2. Click the package to open its detail view.
3. Select **Set Credentials**.
4. Enter your npm access token.
5. Click **Save**.

## CI/CD integration (notify endpoint)

CI attribution requires your build pipeline to send a notification to Sentinel after pushing an artifact. This creates a record that links the push to a specific CI run, actor, commit, and workflow.

### Step 1: Generate a notify key

1. In Sentinel, navigate to **Settings** and select **Notify Key**.
2. Click **Generate notify key**.
3. Copy the key value (prefix: `snk_`). Store it in your CI/CD secrets manager.

### Step 2: Add the notification step to your pipeline

Add the following step to your GitHub Actions workflow, immediately after the `docker push` or `npm publish` step:

```yaml
- name: Notify Sentinel
  run: |
    curl -X POST \
      ${{ secrets.SENTINEL_URL }}/modules/registry/ci/notify \
      -H "Authorization: Bearer ${{ secrets.SENTINEL_NOTIFY_KEY }}" \
      -H "Content-Type: application/json" \
      -d '{
        "image": "your-org/your-image",
        "tag": "${{ github.sha }}",
        "digest": "${{ steps.push.outputs.digest }}",
        "runId": ${{ github.run_id }},
        "commit": "${{ github.sha }}",
        "actor": "${{ github.actor }}",
        "workflow": "${{ github.workflow }}",
        "repo": "${{ github.repository }}"
      }'
```

Store `SENTINEL_NOTIFY_KEY` and `SENTINEL_URL` as encrypted GitHub Actions secrets.

### CI notification payload fields

All fields are required:

| Field | Type | Description |
|---|---|---|
| `image` | string | Artifact name, for example `myorg/myapp` |
| `tag` | string | Tag or version that was pushed |
| `digest` | string | Content digest of the pushed artifact |
| `runId` | integer | CI run ID (for example, GitHub Actions run ID) |
| `commit` | string | Git commit SHA (minimum 7 characters) |
| `actor` | string | The user or bot that triggered the CI run |
| `workflow` | string | CI workflow name or file path |
| `repo` | string | GitHub repository in `owner/repo` format |

### How attribution works

When Sentinel receives a CI notification:

1. The notification is persisted to the CI notifications table.
2. Sentinel searches for a pending registry event that matches the artifact name, tag, and digest.
3. If a match is found, the event's attribution status is updated to `verified` with the CI metadata.
4. The detection rules are re-evaluated with the updated attribution data.

If no matching event exists when the notification arrives (for example, the webhook has not yet been processed), the notification is stored and can be matched later.

Sentinel also runs a deferred attribution check 5 minutes after each registry event. During this grace period, Sentinel searches the GitHub Actions API for matching workflow runs. If a match is found, the attribution status is set to `inferred`. If no CI notification or matching workflow run is found, the status is set to `unattributed`.

## Understanding registry events

### Digest change detection

When polling detects that a tag's content digest has changed since the last poll, Sentinel creates a `digest_change` event. This is distinct from a `new_tag` event -- digest changes indicate that the content behind an existing tag was replaced, which can signal a supply chain compromise.

### Webhook vs. polling

Sentinel processes events from both webhooks and polling. Webhook events are processed in near real-time. Polling events are detected on the configured poll interval.

When Sentinel receives a webhook for a Docker image push, it checks whether the tag already exists in its version database. If the tag exists, the event is classified as a `digest_change`. If the tag is new, it is classified as a `new_tag`.

### Verification pipeline

For Docker images, Sentinel can run a verification pipeline that checks:

- **Cosign signature**: Whether the image has a valid cosign (Sigstore) signature.
- **SLSA provenance**: Whether the image has a valid SLSA provenance attestation.
- **Rekor transparency log**: Whether the signature is recorded in the Rekor transparency log.

Verification results are attached to the event payload and available for rule evaluation.

## Detection templates

Sentinel provides the following pre-built detection templates for the registry module:

| Template | Category | Severity | Rules |
|---|---|---|---|
| Docker Image Monitor | Container Security | Medium | 1 |
| Require CI Attribution | Supply Chain | High | 2 |
| Enforce Signatures | Supply Chain | Critical | 1 |
| Enforce Provenance | Supply Chain | Critical | 2 |
| npm Package Monitor | Package Security | High | 3 |
| Full Registry Security | Comprehensive | Critical | 8 |

To enable a template:

1. Navigate to **Registry** and select **Templates**.
2. Find the template and click **[enable]**.
3. Optionally scope the detection to a specific artifact. If no artifact is selected, the detection applies globally to all monitored artifacts in your organization.
4. Provide a detection name and click **Enable Detection**.

## Configuring webhook delivery

To receive real-time webhook events from Docker Hub or npm:

1. Navigate to **Registry** and select **Webhook Config** (or check the webhook configuration endpoint).
2. The page displays:
   - **Docker webhook URL**: The endpoint to configure in Docker Hub.
   - **npm webhook URL**: The endpoint to configure in your npm hook settings.
   - **Secret status**: Whether a webhook secret is configured, shown by prefix.
3. If no secret exists, click **Rotate Secret** to generate one. The plaintext secret is shown once -- copy it and configure it in your Docker Hub or npm webhook settings.

### Docker Hub webhook setup

1. In Docker Hub, navigate to your repository's **Webhooks** tab.
2. Enter the Sentinel Docker webhook URL.
3. Docker Hub does not natively support HMAC signing. Configure the webhook secret in Sentinel's webhook configuration and use a compatible webhook proxy if HMAC verification is required.

### npm webhook setup

1. Use the npm CLI to create a hook: `npm hook add <package-or-scope> <sentinel-npm-webhook-url> <webhook-secret>`.
2. npm signs webhook deliveries with the secret using HMAC-SHA256 in the `x-npm-signature` header.

## Troubleshooting

### Polling is not detecting changes

- Verify the artifact is enabled in Sentinel (not soft-deleted).
- Check the poll interval -- changes are detected only at the next scheduled poll.
- For npm packages, confirm the `watchMode` setting matches your needs (`versions` vs. `dist-tags`).

### CI attribution shows "unattributed" for known CI pushes

- Verify the CI notification step runs after the push step in your pipeline.
- Confirm the `digest` field in the notification matches the actual pushed digest.
- Check that the notify key is valid and has not been revoked.
- Verify the artifact name in the notification matches the monitored artifact name in Sentinel exactly.

### Webhook signature verification fails

- Confirm the webhook secret configured in Sentinel matches the secret configured in Docker Hub or npm.
- For Docker webhooks, check the `X-Hub-Signature-256` or `X-Signature` header format.
- For npm webhooks, check the `x-npm-signature` header format.
