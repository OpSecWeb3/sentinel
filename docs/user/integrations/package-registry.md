# Package Registry Integration

This guide explains how to connect Sentinel to Docker Hub and npm registries
so that Sentinel can monitor container images and npm packages for supply
chain threats.

## Architecture overview

Sentinel monitors package registries through two complementary mechanisms:

1. **Webhooks** -- Docker Hub and npm send real-time notifications when images
   or packages change.
2. **Polling** -- Sentinel periodically queries the registry API to detect
   changes that webhooks may miss (for example, tag mutations, digest changes,
   or metadata updates).

Both mechanisms feed into the same detection pipeline, and Sentinel
cross-references webhook and polling data to detect anomalies such as direct
registry pushes that bypass CI/CD.

## Prerequisites

- A Sentinel account with the **Admin** role in your organization.
- For Docker Hub webhooks: admin access to the Docker Hub repository to
  configure webhook delivery.
- For npm webhooks: an npm account with access to configure hooks on the
  packages you want to monitor.
- A webhook secret configured for your Sentinel organization (set under
  **Settings > Webhook Secret**).

## Adding Docker images for monitoring

### Step 1: Register the image

1. Navigate to **Registry > Images**.
2. Click **Add Image**.
3. Fill in:
   - **Name** -- the Docker image name, including the namespace (for example,
     `library/nginx`, `myorg/api-server`).
   - **Tag patterns** -- glob patterns that control which tags to monitor. The
     default `*` monitors all tags. Use specific patterns (for example,
     `v*`, `latest`) to reduce noise.
   - **Ignore patterns** -- glob patterns for tags to skip (for example,
     `*-dev`, `*-rc*`).
   - **Poll interval** -- how often Sentinel checks the registry (minimum: 60
     seconds, default: 300 seconds).
   - **GitHub repo** (optional) -- the source repository in `owner/repo`
     format. Used for CI attribution checks.
4. Click **Add**.

Sentinel immediately triggers an initial poll to discover existing tags and
their digests.

> **Pre-flight check:** If you leave tag patterns as `*`, Sentinel performs a
> pre-flight check to count the total number of tags. If the image has an
> unusually large number of tags, Sentinel warns you and suggests using
> specific patterns to avoid excessive polling.

### Step 2: Configure the Docker Hub webhook

1. Open Docker Hub and navigate to the repository's **Webhooks** settings.
2. Add a webhook with the URL:
   ```
   https://<your-sentinel-api>/modules/registry/webhooks/docker
   ```
3. Set the webhook secret to your organization's webhook secret (available
   under **Settings > Webhook Secret** in Sentinel).

Docker Hub sends a webhook notification for every push to the repository.
Sentinel verifies the HMAC-SHA256 signature before processing.

### Managing Docker images

**Viewing images:** Navigate to **Registry > Images**. Each image shows:

- **Name** -- the Docker image name.
- **Tag count** -- total tracked tags.
- **Latest version** -- the most recent tag.
- **Verification status** -- whether signatures and provenance are present.
- **Last event** -- when the last change was detected.
- **Poll interval** -- how often Sentinel checks for changes.

**Updating configuration:** Click an image to open its detail page. Update
tag patterns, ignore patterns, poll interval, or the linked GitHub repository.

**Triggering a manual poll:** Click **Poll** on the image detail page or
image list to immediately check for changes.

**Removing an image:** Click **Delete** on the image. This disables monitoring
and pauses any detections that reference the image by name.

## Adding npm packages for monitoring

### Step 1: Register the package

1. Navigate to **Registry > Packages**.
2. Click **Add Package**.
3. Fill in:
   - **Name** -- the npm package name (for example, `@acme/sdk`,
     `express`).
   - **Tag patterns** -- glob patterns for dist-tags to monitor (default:
     `*`).
   - **Ignore patterns** -- dist-tags to skip.
   - **Watch mode** -- `versions` (track all version publishes) or
     `dist-tags` (track dist-tag movements only).
   - **Poll interval** -- how often Sentinel checks the registry (minimum: 60
     seconds, default: 300 seconds).
   - **GitHub repo** (optional) -- the source repository in `owner/repo`
     format.
4. Click **Add**.

### Step 2: Configure the npm webhook

npm supports webhooks through the npm hooks API:

```bash
npm hook add @acme/sdk https://<your-sentinel-api>/modules/registry/webhooks/npm <your-webhook-secret>
```

npm sends a webhook notification with an `x-npm-signature` header for every
publish, unpublish, and dist-tag change. Sentinel verifies the HMAC-SHA256
signature before processing.

### Managing npm packages

The management workflow for npm packages mirrors Docker images. Navigate to
**Registry > Packages** to view, update, poll, or delete monitored packages.

## Signature verification with Sigstore

Sentinel verifies supply chain signatures and provenance attestations for both
Docker images and npm packages.

### Docker image signatures (cosign)

Sentinel checks whether Docker images are signed using
[cosign](https://github.com/sigstore/cosign). The **Enforce Signatures**
detection template alerts when an image lacks a cosign signature.

### SLSA provenance attestations

Sentinel verifies [SLSA](https://slsa.dev) provenance attestations that
cryptographically prove which source repository and build system produced an
artifact. The **Enforce Provenance** detection template alerts when an artifact
lacks a provenance attestation.

You can optionally specify an expected source repository to ensure provenance
attestations match your organization's repository.

### Verification status on the dashboard

Each artifact on the images or packages list shows a verification status:

| Status | Meaning |
|---|---|
| `verified` | At least one signature or provenance attestation is present. |
| `unverified` | No signatures or provenance attestations found. |

## What registry events Sentinel tracks

### Docker image events

- **Digest change** -- an existing tag now points to a different image digest.
- **New tag** -- a new tag was created.
- **Tag removed** -- an existing tag was deleted.

### npm package events

- **Version published** -- a new version was published.
- **Version unpublished** -- a version was removed from the registry.
- **Version deprecated** -- a version was marked as deprecated.
- **Maintainer changed** -- package maintainers were added or removed.
- **Dist-tag updated** -- a dist-tag (for example, `latest`) was moved to a
  different version.
- **Dist-tag removed** -- a dist-tag was deleted.

### CI attribution events

When Sentinel receives a CI notification (via the `/modules/registry/ci/notify`
endpoint from your GitHub Actions workflow), it records:

- **Image/package name and tag/version.**
- **Digest** of the published artifact.
- **GitHub Actions run ID, commit SHA, actor, workflow file, and source
  repository.**

This data is cross-referenced with polling and webhook data to detect pushes
that were not preceded by a CI build.

## Available detection templates

Navigate to **Registry > Templates** to see the full list. Sentinel ships with
the following built-in templates:

### Container security

| Template | Severity | Description |
|---|---|---|
| Docker Image Monitor | Medium | Alerts on digest changes, new tags, and tag removals. |

### Supply chain

| Template | Severity | Description |
|---|---|---|
| Require CI Attribution | High | Alerts when a release changes without verified CI attribution. |
| Enforce Signatures | Critical | Alerts when a Docker image lacks a cosign signature. |
| Enforce Provenance | Critical | Alerts when an artifact lacks a SLSA provenance attestation. |
| Detect Manual Push | High | Alerts when an image is pushed by an unauthorized user. |
| Pin Digest | Critical | Alerts when a Docker image digest changes from a pinned value. |
| Suspicious Activity | High | Alerts on rapid changes or off-hours activity. |
| Detect Source Mismatch | High | Alerts when a change is detected by polling but not preceded by a webhook. |

### Package security (npm)

| Template | Severity | Description |
|---|---|---|
| npm Package Monitor | High | Alerts on version changes, install script additions, major version jumps, and maintainer changes. |
| npm Unpublish Alert | Critical | Alerts when a version is unpublished. |
| npm Rapid Publish | High | Alerts when versions are published faster than expected. |
| npm Off-Hours Publish | High | Alerts on publishes outside business hours. |
| npm Maintainer Change | High | Alerts on maintainer additions or removals. |
| npm Require Provenance | Critical | Alerts when a published version lacks SLSA provenance. |
| npm Tag Audit | Medium | Logs dist-tag changes on release channels. |
| npm Tag Pin Digest | Critical | Alerts when a dist-tag tarball digest changes from a pinned value. |
| npm Tag Removed | High | Alerts when a dist-tag is deleted. |
| npm Tag Require CI | High | Alerts when a dist-tag change is not attributed to CI. |
| npm Tag Install Scripts | Critical | Alerts when a dist-tag points to a version with install scripts. |
| npm Tag Require Provenance | Critical | Alerts when a dist-tag points to a version without SLSA provenance. |
| npm Tag Major Version Jump | High | Alerts when a dist-tag is moved to a version with a major semver increment. |
| npm Tag Rapid Change | High | Alerts when dist-tags change faster than expected. |
| npm Tag Off-Hours | High | Alerts on dist-tag changes outside business hours. |

### Comprehensive

| Template | Severity | Description |
|---|---|---|
| Full Registry Security | Critical | Enables all registry security monitors in one detection. |

### Audit and logging

| Template | Severity | Description |
|---|---|---|
| Log Releases | Low | Logs all release changes without alerting. |
| npm Log Releases | Low | Logs all npm version changes without alerting. |

## Polling interval configuration

The default poll interval for new artifacts is 300 seconds (5 minutes). You
can set it to any value with a minimum of 60 seconds.

**Choosing an interval:**

- **60 seconds** -- fastest detection, highest API usage. Use for
  critical production images.
- **300 seconds** (default) -- good balance for most use cases.
- **900+ seconds** -- suitable for low-priority or archived packages.

To change the interval, update the artifact configuration on its detail page.
Sentinel triggers an immediate poll after each configuration change.

## CI notification endpoint

To improve attribution accuracy, configure your CI/CD pipeline to notify
Sentinel after each build:

```bash
curl -X POST https://<your-sentinel-api>/modules/registry/ci/notify \
  -H "Authorization: Bearer <notify-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "image": "myorg/api-server",
    "tag": "v1.2.3",
    "digest": "sha256:abc123...",
    "runId": 12345678,
    "commit": "a1b2c3d",
    "actor": "github-actions[bot]",
    "workflow": "build.yml",
    "repo": "myorg/api-server"
  }'
```

The **notify key** is available under **Settings > API Keys** in the Sentinel
web console.

## Troubleshooting

### "Invalid webhook signature" (HTTP 401)

The HMAC-SHA256 signature does not match. Verify that:

- The webhook secret configured in Docker Hub or npm matches your
  organization's webhook secret in Sentinel.
- No proxy or CDN modified the request body after the registry signed it.

### Pre-flight check rejects the image

If the pre-flight check reports too many tags, either:

- Specify explicit **tag patterns** (for example, `v*`, `latest`) to narrow
  the scope.
- The pre-flight check is automatically skipped when specific tag patterns
  are set.

### Polling detects changes but webhooks do not arrive

1. Verify the webhook URL is correct and reachable from the registry.
2. Check the webhook configuration in Docker Hub or npm for delivery failures.
3. The **Detect Source Mismatch** template can alert you when polling detects
   a change that was not preceded by a webhook notification.

### "Service temporarily unavailable" (HTTP 503)

The background job queue (Redis/BullMQ) is unreachable. Contact your Sentinel
administrator to check Redis connectivity and worker health.

### Verification status shows "unverified"

The artifact does not have cosign signatures or SLSA provenance attestations.
To fix this:

1. Add cosign signing to your CI/CD pipeline.
2. Enable provenance attestations in your build configuration (for example,
   `npm publish --provenance` for npm, or SLSA GitHub Actions generators for
   Docker).

### Detections paused after deleting an image

When you delete a Docker image, Sentinel pauses all detections that reference
that image by name. To resume monitoring:

1. Re-add the image under **Registry > Images**.
2. Navigate to **Detections** and re-enable the paused detections.
