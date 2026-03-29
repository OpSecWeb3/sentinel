# Notifications

The `@sentinel/notifications` package (`packages/notifications/`) handles all outbound alert
delivery. It supports three channel types: Slack (via the Slack Bot API), email (via Nodemailer
SMTP), and HTTP webhooks (with HMAC-SHA256 signing). The package is consumed exclusively by
the worker's `alert-dispatch` job handler.

## Dispatch architecture

```mermaid
flowchart TD
    A[alert.dispatch job] --> B[Load alert + detection]
    B --> C[Load notification channels]
    C --> D[Load Slack bot token]
    D --> E[Check notification_deliveries<br/>for already-sent channels]
    E --> F[Resolve module formatter]
    F --> G[dispatchAlert]

    G --> H{Circuit breaker<br/>open?}
    H -->|Yes| I[Skip channel<br/>status: circuit_open]
    H -->|No| J{Channel type?}

    J -->|Slack direct| K[sendSlackMessage]
    J -->|Email| L[sendEmailNotification]
    J -->|Webhook| M[sendWebhookNotification]

    K --> N[Record result]
    L --> N
    M --> N
    I --> N

    N --> O[Write notification_deliveries]
    O --> P[Update alerts.notificationStatus]

    style G fill:#f0f0ff,stroke:#333
```

Delivery is attempted for all configured channels in a single job execution. Per-channel
success or failure is recorded independently; a failure on one channel does not prevent
delivery to other channels.

## SlackNotifier

**Source:** `packages/notifications/src/slack.ts`

### Bot token usage

Slack notifications use the Slack Bot API (`chat.postMessage`). The bot token is stored in
the `slack_installations` table, encrypted with AES-256-GCM, and decrypted at dispatch time.
The token is associated with a specific organization (`orgId`) and Slack workspace.

The dispatch handler:

1. Queries `slack_installations` for the organization's bot token.
2. Decrypts the bot token using `@sentinel/shared/crypto`.
3. Passes the token, channel ID, and alert payload to `sendSlackMessage`.

The HTTP request to `https://slack.com/api/chat.postMessage` uses a 10-second
`AbortSignal.timeout` to prevent indefinite hangs.

### Block Kit formatting

All Slack messages use [Block Kit](https://api.slack.com/block-kit) format. The default
`buildBlocks` function produces:

| Block     | Type      | Content                                                |
|-----------|-----------|--------------------------------------------------------|
| Header    | `header`  | Severity badge emoji + alert title.                    |
| Metadata  | `section` | Four fields: Severity, Module, Event type, Timestamp.  |
| Description | `section` | Alert description in Markdown. Conditional.           |
| Fields    | `section` | Custom `label: value` pairs. Conditional.              |
| Divider   | `divider` | Visual separator.                                      |

Severity badges:

| Severity   | Emoji                   |
|------------|-------------------------|
| `critical` | `:rotating_light:`      |
| `high`     | `:red_circle:`          |
| `medium`   | `:large_orange_circle:` |
| `low`      | `:white_circle:`        |
| (other)    | `:bell:`                |

The fallback `text` field (displayed in push notifications and when blocks cannot render) is
`"<title> -- <severity> severity"`.

### Custom module formatters

Each feature module can register a `formatSlackBlocks` function that overrides the default
block layout for alerts it generates. This allows modules to include module-specific fields
such as contract addresses, blockchain transaction hashes, or GitHub repository details.

The worker calls `setModuleFormatters(modules)` at startup, which builds a map from
`moduleId` to the module's `formatSlackBlocks` function. At dispatch time, the handler
resolves the formatter by the `moduleId` stored in `alert.triggerData`, and passes it to
`dispatchAlert` as the `formatBlocks` callback.

```typescript
formatSlackBlocks?: (alert: SlackAlertPayload) => object[]
```

The function receives a `SlackAlertPayload` and must return a valid array of
[Block Kit block objects](https://api.slack.com/reference/block-kit/blocks).

### Channel selection

Two mechanisms configure Slack delivery:

| Mechanism             | Source field                  | Description                                              |
|-----------------------|-------------------------------|----------------------------------------------------------|
| Direct Slack channel  | `detections.slackChannelId`   | A single Slack channel ID configured on the detection. Uses the workspace OAuth bot token. |
| Notification channel  | `detections.channelIds[]`     | An array of `notification_channels` row IDs. Each row with `type = 'email'` or `type = 'webhook'` carries its own configuration. |

Both mechanisms can be active simultaneously for the same detection.

## EmailNotifier

**Source:** `packages/notifications/src/email.ts`

Email notifications use [Nodemailer](https://nodemailer.com/) with SMTP transport.

### Configuration

| Variable    | Required | Description                                                |
|-------------|----------|------------------------------------------------------------|
| `SMTP_URL`  | Yes      | Full SMTP connection URL (e.g., `smtp://user:pass@host:587`). |
| `SMTP_FROM` | No       | Sender address. Default: `alerts@sentinel.dev`.            |

The SMTP transporter is initialized lazily on first use and cached for the process lifetime.
The URL is parsed manually to preserve timeout options that `nodemailer.parseConnectionUrl`
would silently discard. Connection, greeting, and socket timeouts are all set to 10 seconds.

If `SMTP_URL` is not set, any attempt to send an email throws an error and the delivery
is recorded as `failed`.

### SMTP connection options

| Option              | Value    | Purpose                                            |
|---------------------|----------|----------------------------------------------------|
| `connectionTimeout` | 10,000 ms | Maximum time to establish TCP connection.         |
| `greetingTimeout`   | 10,000 ms | Maximum time to receive SMTP greeting.            |
| `socketTimeout`     | 10,000 ms | Maximum time between data packets.                |
| `secure`            | auto     | `true` if protocol is `smtps:` or port is `465`.  |

### Message format

Emails use an inline HTML template:

- **Subject**: `[SEVERITY] Alert title`
- **Heading**: Alert title (HTML-escaped).
- **Subtitle**: `SEVERITY . module . timestamp`.
- **Body paragraph**: Alert description (HTML-escaped, only if present).
- **Fields table**: Optional `label -> value` rows for module-specific context.
- **Footer**: `"Sentinel Security Platform"`.

All user-supplied strings are HTML-escaped via a dedicated `escapeHtml()` function that
handles `&`, `<`, `>`, and `"` characters. There are no external CSS dependencies; all
styles are inline.

## WebhookNotifier

**Source:** `packages/notifications/src/webhook.ts`

Webhook notifications send a signed HTTP POST to a user-configured URL.

### Configuration

```typescript
export interface WebhookConfig {
  url: string;
  secret: string;
  headers?: Record<string, string>;
}
```

The `secret` field is stored encrypted in the `notification_channels.config` JSONB column
and is decrypted at dispatch time using `@sentinel/shared/crypto`.

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

The `X-Signature` header is an HMAC-SHA256 hex digest of the raw JSON body, computed using
the decrypted `secret`. The request uses a 10-second `AbortSignal.timeout` to prevent hangs.
Non-2xx responses cause the delivery to be recorded as `failed`.

### SSRF protection

Before sending, the webhook handler resolves the target hostname via DNS and rejects
requests that resolve to private or reserved IP ranges:

| Range                        | RFC / Description                         |
|------------------------------|-------------------------------------------|
| `10.0.0.0/8`                | RFC 1918 private.                         |
| `172.16.0.0/12`             | RFC 1918 private.                         |
| `192.168.0.0/16`            | RFC 1918 private.                         |
| `127.0.0.0/8`              | Loopback.                                 |
| `0.0.0.0/8`                | Current network.                          |
| `169.254.0.0/16`           | Link-local / AWS IMDS.                    |
| `100.64.0.0/10`            | CGNAT (RFC 6598).                         |
| `198.18.0.0/15`            | Benchmark testing (RFC 2544).             |
| `240.0.0.0/4`              | Reserved (RFC 1112).                      |
| `255.255.255.255/32`       | Broadcast.                                |
| `::1`, `::`                | IPv6 loopback / unspecified.              |
| `fc00::/7`                 | IPv6 ULA.                                 |
| `fe80::/10`                | IPv6 link-local.                          |
| `::ffff:<private-v4>`      | IPv4-mapped IPv6 (delegates to v4 check). |

Only `http:` and `https:` URL schemes are allowed. Other schemes (such as `ftp:` or `file:`)
are rejected before DNS resolution.

**TOCTOU note**: The validation uses a validate-then-fetch pattern rather than DNS pinning.
DNS pinning (replacing the hostname with the resolved IP) breaks TLS for HTTPS URLs because
the TLS SNI extension uses the URL hostname, and most servers do not present a valid
certificate for a bare IP address. The small TOCTOU window between validation and fetch is an
accepted trade-off, consistent with industry-standard webhook senders.

## Dispatcher

**Source:** `packages/notifications/src/dispatcher.ts`

The `dispatchAlert` function is the central routing point. It receives:

- `channels`: An array of `ChannelRow` objects (from the `notification_channels` table).
- `alert`: A `SlackAlertPayload` struct.
- `slackBotToken`: The decrypted Slack bot token (or `null`).
- `slackChannelId`: The target Slack channel ID for direct delivery (or `null`).
- `formatBlocks`: An optional module-specific Block Kit formatter.

### Per-channel circuit breaker

The dispatcher implements an in-memory circuit breaker per channel to prevent hammering a
flaky channel during every retry while it is down.

| Parameter          | Value      | Description                                          |
|--------------------|------------|------------------------------------------------------|
| `CIRCUIT_THRESHOLD`| 5          | Consecutive failures before the circuit opens.       |
| `CIRCUIT_RESET_MS` | 60,000 ms | Time before the circuit allows a probe attempt.      |

When the circuit is open for a channel, delivery is skipped and the result is recorded as
`circuit_open`. After the reset window elapses, the next attempt is allowed through as a
probe. If the probe succeeds, the circuit resets to closed.

Circuit state is held in process memory and does not survive worker restarts.

### Dispatch flow

1. If `slackBotToken` and `slackChannelId` are provided, attempt direct Slack delivery.
2. Iterate over configured `channels` (email, webhook).
3. For each channel, check the circuit breaker. If open, record `circuit_open` and skip.
4. Invoke the appropriate delivery function (`sendSlackMessage`, `sendEmailNotification`,
   `sendWebhookNotification`).
5. Record per-channel `success` or `failure` with response time.
6. If **all** channels either failed or are circuit-open, throw an error to trigger a
   BullMQ retry. Partially successful dispatches do not throw.

### Return value

```typescript
interface NotificationResult {
  channelId: string;
  type: string;
  status: 'sent' | 'failed' | 'circuit_open';
  error?: string;
  statusCode?: number;
  responseTimeMs?: number;
}
```

## Delivery tracking

Every delivery attempt is recorded in the `notification_deliveries` table. This provides
both idempotent retries and a complete audit log.

| Column            | Type        | Description                                        |
|-------------------|-------------|----------------------------------------------------|
| `id`              | `bigint`    | Surrogate primary key.                             |
| `alertId`         | `bigint`    | Foreign key to `alerts.id`.                        |
| `channelId`       | `string`    | FK to `notification_channels.id` or raw Slack channel ID. |
| `channelType`     | `string`    | `slack`, `email`, or `webhook`.                    |
| `status`          | `string`    | `sent`, `failed`, or `circuit_open`.               |
| `statusCode`      | `integer`   | HTTP status code from the channel endpoint.        |
| `responseTimeMs`  | `integer`   | Round-trip time in milliseconds.                   |
| `error`           | `string`    | Error message if `status = 'failed'`.              |
| `sentAt`          | `timestamp` | Time of successful delivery; `null` if failed.     |
| `createdAt`       | `timestamp` | Row creation time.                                 |

The `notification_deliveries` table is subject to a **30-day** retention policy enforced by
the `platform.data.retention` job.

### Alert-level status

The `alerts.notificationStatus` column summarizes the delivery outcome:

| Value         | Meaning                                                          |
|---------------|------------------------------------------------------------------|
| `sent`        | All configured channels delivered successfully.                  |
| `partial`     | At least one channel succeeded and at least one failed.          |
| `failed`      | All channels failed.                                             |
| `no_channels` | No channels were configured; no deliveries were attempted.       |

Delivery records and the alert status update are written atomically in a single database
transaction. Records are inserted first, followed by the `notificationStatus` update. This
ensures a crash between the two writes cannot leave an alert marked `sent` with no audit
trail.

## Retry logic for failed deliveries

The `alert.dispatch` job retries up to 3 times with exponential backoff (2 s base, with
jitter applied by the worker's custom backoff strategy).

On retry, the handler re-reads `notification_deliveries` and skips channels already marked
`sent`. This guarantees that a transient failure on one channel does not cause duplicate
deliveries to channels that already succeeded.

```mermaid
flowchart LR
    A[alert.dispatch attempt 1] -->|"channel A: sent<br/>channel B: failed"| B[BullMQ retry]
    B --> C[alert.dispatch attempt 2]
    C -->|"channel A: skipped (already sent)<br/>channel B: sent"| D[Job complete<br/>status: sent]
```

If all channels fail on the final retry attempt, the job is moved to the dead-letter queue
(see [Queue System: Dead-letter queue](queue-system.md#dead-letter-queue)).

## Message formatting per module

Each module can customize the Slack Block Kit layout for its alerts by exporting a
`formatSlackBlocks` function on the module definition. The following modules register
custom formatters:

| Module   | Custom formatter | Notes                                                |
|----------|------------------|------------------------------------------------------|
| GitHub   | Yes (if defined) | Includes repository, author, and commit details.     |
| Chain    | Yes (if defined) | Includes contract address, tx hash, block number.    |
| Registry | Yes (if defined) | Includes package name, version, and registry source. |
| Infra    | Yes (if defined) | Includes hostname, IP, and scan score.               |
| AWS      | Yes (if defined) | Includes AWS account ID, region, and event name.     |

The default `buildBlocks` function is used as a fallback for any module that does not
register a custom formatter.

Email and webhook deliveries use the same `SlackAlertPayload` struct regardless of module.
Module-specific context is included in the `fields` array and the `description` field of the
payload.

## Channel association

Detections (named monitoring rules) carry channel configuration in two forms:

1. **`channelIds` array**: An array of `notification_channels` primary keys. Each channel
   row specifies a `type` (`email` or `webhook`) and a `config` JSONB object with
   type-specific settings (recipients list, webhook URL, etc.).

2. **`slackChannelId`**: A single Slack channel ID for direct delivery using the
   organization's OAuth bot token. Intended for one-click configuration from the Sentinel
   UI without requiring a separate channel configuration object.

Both fields are evaluated independently; a detection may use either, both, or neither.
