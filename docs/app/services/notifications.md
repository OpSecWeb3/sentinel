# Notifications

The `@sentinel/notifications` package (`packages/notifications/`) handles all outbound alert
delivery. It supports three channel types: Slack (via the Slack Bot API), email (via Nodemailer
SMTP), and HTTP webhooks (with HMAC-SHA256 signing). The package is consumed exclusively by
the worker's `alert-dispatch` job handler.

## Delivery flow

```
alert created (alerts table)
  → alert.dispatch job enqueued (alerts queue)
    → worker picks up job
      → load alert + detection
        → load channel_ids from detection
          → load slack bot token (if slackChannelId set)
            → check notification_deliveries for already-sent channels
              → resolve module formatter (optional)
                → dispatchAlert()
                  ├── Slack (direct channel)
                  ├── Slack (channel config)
                  ├── email (channel config)
                  └── webhook (channel config)
                      → write notification_deliveries rows
                        → update alerts.notificationStatus
```

Delivery is attempted for all configured channels in a single job execution. Per-channel
success or failure is recorded independently; a failure on one channel does not prevent
delivery to other channels.

## Slack delivery

### OAuth workspace token

Slack notifications use the Slack Bot API (`chat.postMessage`). The bot token is stored in
the `slack_installations` table, encrypted with AES-256-GCM, and decrypted at dispatch time.
The token is associated with a specific organization (`orgId`) and Slack workspace.

The `slackChannelId` field on a detection row specifies the target Slack channel. If this
field is set, the dispatch handler:

1. Queries `slack_installations` for the organization's bot token.
2. Decrypts the bot token using `@sentinel/shared/crypto`.
3. Passes the token and channel ID to `sendSlackMessage`.

### Channel selection

Two mechanisms configure Slack delivery:

| Mechanism | Source field | Description |
|-----------|-------------|-------------|
| Direct Slack channel | `detections.slackChannelId` | A single Slack channel ID configured on the detection. Uses the workspace OAuth bot token. |
| Notification channel | `detections.channelIds[]` | An array of `notification_channels` row IDs. Each channel row with `type = 'slack'` must carry its own configuration. |

Both mechanisms can be active simultaneously for the same detection.

### Block Kit formatting

All Slack messages use the
[Block Kit](https://api.slack.com/block-kit) format. The default `buildBlocks` function
in `packages/notifications/src/slack.ts` produces the following block structure:

- **Header block**: severity badge emoji and alert title.
- **Section block**: four fields — Severity, Module, Event type, Timestamp.
- **Section block** (conditional): alert description in Markdown.
- **Section block** (conditional): custom `fields` array (label/value pairs).
- **Divider block**.

Severity badges:

| Severity   | Emoji                  |
|------------|------------------------|
| `critical` | `:rotating_light:`     |
| `high`     | `:red_circle:`         |
| `medium`   | `:large_orange_circle:`|
| `low`      | `:white_circle:`       |
| (other)    | `:bell:`               |

The fallback text (displayed in notifications and when blocks cannot render) is
`"<title> — <severity> severity"`.

### Custom Slack formatting (module formatters)

Each feature module can register a `formatSlackBlocks` function that overrides the default
block layout for alerts it generates. This allows modules to include module-specific fields
such as contract addresses, blockchain transaction hashes, or GitHub repository details.

The worker calls `setModuleFormatters(modules)` at startup, which builds a map from
`moduleId` to the module's `formatSlackBlocks` function. At dispatch time, the handler
resolves the formatter by the `moduleId` stored in `alert.triggerData`, and passes it to
`dispatchAlert` as the `formatBlocks` callback.

The `formatBlocks` signature:

```typescript
formatSlackBlocks?: (alert: SlackAlertPayload) => object[]
```

The function receives a `SlackAlertPayload` and must return a valid array of
[Block Kit block objects](https://api.slack.com/reference/block-kit/blocks).

## Email delivery

Email notifications use [Nodemailer](https://nodemailer.com/) with a configurable SMTP URL.
The transporter is initialized lazily on first use and cached for the lifetime of the process.

### Configuration

| Variable    | Description                                        |
|-------------|-----------------------------------------------------|
| `SMTP_URL`  | Full SMTP connection URL (e.g., `smtp://user:pass@host:587`) |
| `SMTP_FROM` | Sender address (default: `alerts@sentinel.dev`)    |

If `SMTP_URL` is not set, any attempt to send an email will throw an error and the delivery
will be recorded as `failed`.

### Message format

Emails use an inline HTML template generated from the alert payload. The template includes:

- **Subject**: `[SEVERITY] Alert title`
- **Heading**: Alert title (HTML-escaped).
- **Subtitle**: `SEVERITY · module · timestamp`.
- **Body paragraph**: Alert description (HTML-escaped, only if present).
- **Fields table**: Optional `label → value` rows for module-specific context fields.
- **Footer**: `"Sentinel Security Platform"`.

All user-supplied strings are HTML-escaped to prevent injection through crafted event
payloads. There are no external CSS dependencies; all styles are inline.

## Webhook delivery

Webhook notifications send a signed HTTP POST to a user-configured URL.

### Request format

```http
POST <webhook_url> HTTP/1.1
Content-Type: application/json
X-Signature: <hmac-sha256-hex>

{
  "event": "alert.triggered",
  "timestamp": "<ISO-8601>",
  "alert": { ... }
}
```

The `X-Signature` header is an HMAC-SHA256 hex digest of the raw request body, computed
using the channel's `secret` field. The secret is stored encrypted in the
`notification_channels.config` JSONB column and is decrypted at dispatch time.

### SSRF protection

Before sending, the webhook handler resolves the target hostname via DNS and rejects
requests that resolve to private or reserved IP ranges (RFC 1918, link-local, loopback,
CGNAT RFC 6598, and AWS IMDS at `169.254.169.254`). This prevents malicious webhook URLs
from reaching internal services. The validation uses a validate-then-fetch pattern rather
than DNS pinning to maintain TLS compatibility.

## Delivery tracking

Every channel delivery attempt is recorded in the `notification_deliveries` table. This
enables idempotent retries and provides an audit log of notification outcomes.

| Column            | Type      | Description                                        |
|-------------------|-----------|----------------------------------------------------|
| `id`              | `bigint`  | Surrogate primary key                              |
| `alertId`         | `bigint`  | Foreign key to `alerts.id`                         |
| `channelId`       | `string`  | Foreign key to `notification_channels.id` (or the raw `slackChannelId`) |
| `channelType`     | `string`  | `slack`, `email`, or `webhook`                     |
| `status`          | `string`  | `sent` or `failed`                                 |
| `statusCode`      | `integer` | HTTP status code from the channel endpoint, if applicable |
| `responseTimeMs`  | `integer` | Round-trip time in milliseconds                    |
| `error`           | `string`  | Error message if `status = 'failed'`               |
| `sentAt`          | `timestamp` | Time of successful delivery; `null` if failed    |
| `createdAt`       | `timestamp` | Row creation time                                |

The `notification_deliveries` table is subject to a 30-day retention policy enforced by the
`platform.data.retention` job.

### Alert-level status

The `alerts.notificationStatus` column summarizes the delivery outcome:

| Value         | Meaning                                                          |
|---------------|------------------------------------------------------------------|
| `sent`        | All configured channels delivered successfully                   |
| `partial`     | At least one channel succeeded and at least one failed           |
| `failed`      | All channels failed                                              |
| `no_channels` | No channels were configured; no deliveries were attempted        |

## Retry behavior

The `alert.dispatch` job retries up to 3 times with exponential backoff (2 s, 4 s).

Delivery results and the alert status update are written atomically in a single database
transaction. Delivery records are inserted first, followed by the `alerts.notificationStatus`
update. This ensures that a crash between the two writes cannot leave the alert marked `sent`
with no audit trail.

On retry, the handler re-reads the `notification_deliveries` table and skips channels that
were already marked `sent`. This ensures that a transient failure on one channel does not
cause duplicate deliveries to channels that already succeeded.

## Channel association

Detections (the named monitoring rules) carry channel configuration in two forms:

1. **`channelIds` array**: An array of `notification_channels` primary keys. Each channel
   row specifies a `type` (`slack`, `email`, or `webhook`) and a `config` JSONB object with
   type-specific settings (recipients list, Slack channel ID, webhook URL).

2. **`slackChannelId`**: A single Slack channel ID for direct delivery using the
   organization's OAuth bot token. This field is intended for one-click configuration from
   the Sentinel UI without requiring a separate channel configuration object.

Both fields are evaluated independently; a detection may use either, both, or neither.
