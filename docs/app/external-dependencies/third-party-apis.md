# Third-Party APIs and External Services

This document describes every external service that Sentinel communicates with at runtime,
the credentials required, rate limits, and failure modes.

## Summary table

| Service | Purpose | Module / package | Auth required | Failure impact |
|---------|---------|-----------------|---------------|----------------|
| GitHub REST API | Webhook event ingestion, OAuth user auth, CI workflow lookups | `@sentinel/module-github`, `@sentinel/module-registry` | App ID + private key (JWT), installation token, or PAT | GitHub module non-functional; registry GHCR lookups degrade to unauthenticated |
| Slack API | Alert delivery via `chat.postMessage`, OAuth flow, channel listing | `@sentinel/notifications`, API routes | Slack App client ID/secret (OAuth flow); bot token (delivery) | Slack alert channels fail; BullMQ retries |
| Etherscan API | Contract ABI and source verification lookup | `@sentinel/module-chain` | API key (optional, higher rate limits) | Contract metadata unavailable; detection rule setup degrades |
| EVM JSON-RPC nodes | Block polling, log fetching, balance/state/view calls | `@sentinel/module-chain` | RPC URL (may include API key for Infura/Alchemy) | Chain module non-functional for affected chain |
| Docker Hub API | Tag listing, digest comparison, image metadata | `@sentinel/module-registry` | Optional Bearer token per artifact | Registry digest-change detection unavailable for Docker artifacts |
| npm Registry API | Package metadata, version listing, dist-tag tracking | `@sentinel/module-registry` | Optional Bearer token per artifact | Registry version-change detection unavailable for npm artifacts |
| crt.sh (Certificate Transparency) | CT log queries for subdomain discovery and certificate monitoring | `@sentinel/module-infra` | None (public API) | Subdomain discovery and CT log monitoring degrade gracefully |
| WHOIS (port 43) | Domain registration expiry and registrar lookup | `@sentinel/module-infra` | None (raw TCP socket) | WHOIS expiry detection unavailable for affected TLDs |
| Sigstore TUF | Trust root for registry artifact signature verification | `@sentinel/module-registry` | None (public PKI) | Signature verification fails until trust root is fetched |
| AWS SQS | Polling CloudTrail event notifications | `@sentinel/module-aws` | IAM role ARN (preferred) or access key | AWS module non-functional for affected integration |
| AWS STS | Assuming IAM roles for cross-account access | `@sentinel/module-aws` | IAM role with `sts:AssumeRole` | Cannot assume cross-account roles; falls back to static credentials if configured |
| SMTP server | Email alert delivery | `nodemailer` | SMTP URL with credentials | Email alert channels fail; BullMQ retries |

---

## GitHub REST API

**Module**: `@sentinel/module-github`
**Source**: `modules/github/src/github-api.ts`
**Environment variables**: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`

### Purpose

The GitHub module receives webhook events from GitHub organizations (push, branch protection
changes, repository visibility changes, org member events, deploy key additions, secret
scanning alerts) and evaluates them against active detection rules.

Users authenticate with Sentinel using their GitHub account via the GitHub OAuth flow. The
GitHub App installation grants Sentinel access to organization-level events.

### Endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /app/installations/{id}/access_tokens` | POST | Exchange App JWT for an installation access token |
| `GET /app/installations/{id}` | GET | Fetch installation details (permissions, account, events) |
| `GET /repos/{owner}/{repo}/actions/workflows/{id}/runs` | GET | Look up CI workflow run status for registry provenance checks |
| `GET /repos/{owner}/{repo}/actions/runs` | GET | Broad workflow run search when specific workflow file is unknown |

### Authentication model

Sentinel authenticates to GitHub in two ways:

1. **App JWT (RS256)**: Generated from `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. Valid
   for 10 minutes. Used to create installation access tokens and fetch installation details.
   The JWT `iat` is backdated 60 seconds to allow for clock drift.
2. **Installation access tokens**: Short-lived tokens (1 hour) created via the App JWT. Used
   for all subsequent API calls on behalf of an installation.

### Required GitHub App permissions

| Permission scope | Level | Reason |
|-----------------|-------|--------|
| `Administration` | Read | Receive org admin and repository settings events |
| `Members` | Read | Receive organization member change events |
| `Repository hooks` | Read/Write | Validate and manage webhook deliveries |
| `Contents` | Read | Read branch protection and repository metadata |
| `Secret scanning alerts` | Read | Receive secret scanning alert events |

### Webhook events subscribed

| Event | Description |
|-------|-------------|
| `push` | Branch pushes, including force pushes |
| `branch_protection_rule` | Branch protection rule creation, deletion, or modification |
| `repository` | Repository visibility and settings changes |
| `member` | Organization member added or removed |
| `organization` | Organization-level settings changes |
| `deploy_key` | Deploy key added or removed from a repository |
| `secret_scanning_alert` | Secret scanning alert created or resolved |

### Rate limits

| Limit type | Value | Notes |
|-----------|-------|-------|
| REST API (per installation) | 5,000 requests/hour | Standard GitHub Apps rate limit |
| Webhook delivery timeout | 10 seconds | GitHub retries failed deliveries with exponential backoff |
| Secondary rate limit | Varies | Triggered by large bursts; Sentinel backs off when `X-RateLimit-Remaining` < 100 |

### Rate limit handling

The `githubApiFetch` function in `modules/github/src/github-api.ts` handles rate limiting:

- On HTTP 429 or HTTP 403 with `X-RateLimit-Remaining: 0`, retries up to 3 times.
- Reads the `Retry-After` or `X-RateLimit-Reset` header to calculate wait time (capped at
  120 seconds).
- Proactively slows down when remaining requests drop below 100.

### SSRF protection

The GitHub API client validates all request URLs against an allowlist of hostnames
(`api.github.com` plus any configured `GITHUB_ENTERPRISE_HOST`). Requests to disallowed hosts
are rejected with an error.

### Failure modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| GitHub API unreachable | Webhook verification still works (local HMAC check); installation token refresh fails; registry CI lookups fail | BullMQ retries the job |
| Invalid App credentials | All authenticated API calls fail; webhooks still arrive but org-scoped queries cannot run | Fix credentials and restart |
| Rate limit exhaustion | API calls delayed up to 120 seconds per retry; max 3 retries | Automatic back-off; reduce polling frequency |

### Single-installation constraint

Sentinel supports a single GitHub App installation per organization. Installing the same
Sentinel GitHub App in multiple GitHub organizations requires a separate Sentinel organization
for each. See [Limitations](../limitations.md#github-app-single-installation-per-org).

---

## Slack API

**Module**: `@sentinel/notifications` (delivery), API routes (OAuth)
**Source**: `packages/notifications/src/slack.ts`, `apps/api/src/routes/integrations.ts`
**Environment variables**: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`

### Purpose

Sentinel uses the Slack API to:

1. Deliver alert notifications to Slack channels via `chat.postMessage`.
2. Authenticate the Sentinel Slack App with user workspaces via the OAuth 2.0 flow.
3. List workspace channels for the channel picker in the Sentinel UI.

### Endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST https://slack.com/api/oauth.v2.access` | POST | Exchange OAuth authorization code for bot token |
| `POST https://slack.com/api/chat.postMessage` | POST | Send alert notification messages (Block Kit format) |
| `GET https://slack.com/api/conversations.list` | GET | List public channels for the channel picker |
| `GET https://slack.com/api/conversations.info` | GET | Fetch channel details by ID |

### OAuth scopes required

| Scope | Description |
|-------|-------------|
| `chat:write` | Send messages to channels the bot has been invited to |
| `chat:write.public` | Send messages to public channels without requiring an invitation |
| `channels:read` | List public channels for the channel picker in the Sentinel UI |
| `incoming-webhook` | (Optional) If using Incoming Webhooks as an alternative to the Bot API |

### Bot token usage

After a successful OAuth flow, Slack returns an `xoxb-` bot token. The token is stored
encrypted in the `slack_installations` table (one row per Sentinel organization). At alert
dispatch time, the worker decrypts the token and uses it to call `chat.postMessage`.

Alert messages use Slack's [Block Kit](https://api.slack.com/block-kit) format for rich
formatting. Each module can register a custom Slack formatter (`slackFormatter` on the module
interface) to produce module-specific block layouts.

### Rate limits

| Method | Tier | Approximate limit |
|--------|------|-------------------|
| `chat.postMessage` | Tier 3 | ~50 requests/minute per workspace |
| `conversations.list` | Tier 2 | ~20 requests/minute per workspace |
| `conversations.info` | Tier 3 | ~50 requests/minute per workspace |

Under normal alert volumes this limit is not approached; however, a burst of correlated alerts
could exhaust it. Failed deliveries are retried by the BullMQ backoff policy (3 attempts,
exponential, 2-second base delay).

### Failure modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| Slack API unreachable | Alert notifications delayed | BullMQ retries (3 attempts with exponential backoff) |
| Bot token revoked | All Slack deliveries for the org fail | Re-run Slack OAuth flow from the integrations page |
| Rate limit exhaustion | `chat.postMessage` returns 429 | BullMQ retry handles the backoff |
| Invalid channel | Single delivery fails, recorded in `notification_deliveries` | User reconfigures channel |

---

## Etherscan API

**Module**: `@sentinel/module-chain`
**Source**: `modules/chain/src/etherscan.ts`
**Environment variables**: `ETHERSCAN_API_KEY` (runtime, not Zod-validated)

### Purpose

The chain module uses the Etherscan API (and compatible explorer APIs such as PolygonScan,
BaseScan, Arbiscan) to:

1. Fetch the ABI for a deployed smart contract (`module=contract&action=getabi`).
2. Fetch source code metadata, contract name, and storage layout (`module=contract&action=getsourcecode`).

This data is used to decode contract function calls and events for detection rule evaluation.

### Endpoints used

| Endpoint | Action | Description |
|----------|--------|-------------|
| `https://api.etherscan.io/v2/api` (V2 unified) | `chainid=X&module=contract&action=getabi` | Fetch ABI for any Etherscan-supported chain using chain ID |
| `https://api.etherscan.io/v2/api` (V2 unified) | `chainid=X&module=contract&action=getsourcecode` | Fetch source code, contract name, and storage layout |
| Custom explorer URL (legacy) | `module=contract&action=getabi` | Fetch ABI from a user-configured explorer URL (Blockscout, etc.) |

### Endpoint selection logic

When a `chainId` is provided **and** no custom `explorerApi` URL is specified, the client uses
the Etherscan V2 unified endpoint (`https://api.etherscan.io/v2/api`). If a custom
`explorerApi` URL is provided, it is used directly regardless of whether `chainId` is also set.

### Rate limits

| Tier | Rate limit |
|------|-----------|
| No API key (unauthenticated) | 1 request per 5 seconds |
| Free API key | 5 requests per second |
| Pro API key | Higher limits per plan |

### Retry behavior

Requests use a custom retry helper with:

- Up to 3 attempts with exponential backoff (500 ms, 1 s, 2 s).
- 15-second timeout per individual request.
- Only 5xx responses and network-level errors trigger retries; 4xx responses are treated as
  final (deterministic failures).

### Failure modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| Etherscan API unreachable | Cannot fetch ABI for new contracts; existing cached ABIs continue to work | Retry with backoff; ABI is fetched once and cached in the database |
| Rate limit exhaustion | API returns rate limit error | Retry with backoff; configure an API key for higher limits |
| Contract not verified | `getabi` returns error status | Detection rule setup shows error; unverified contracts cannot be monitored via ABI |
| Invalid API key | 403 response, not retried | Fix the `ETHERSCAN_API_KEY` value |

---

## EVM JSON-RPC Nodes

**Module**: `@sentinel/module-chain`
**Source**: `modules/chain/src/rpc.ts`
**Environment variables**: Per-chain RPC URLs configured in the database; `RPC_ROTATION_HOURS`

### Purpose

The chain module communicates with Ethereum-compatible blockchain nodes using JSON-RPC to
perform real-time monitoring. All RPC communication uses direct JSON-RPC over HTTP/S.
[Viem](https://viem.sh/) is used for ABI encoding and decoding only (`encodeFunctionData`,
`decodeFunctionResult`, `parseAbi`), not for transport.

### JSON-RPC methods used

| Method | Purpose | Called by |
|--------|---------|-----------|
| `eth_blockNumber` | Fetch latest block number | Block poller |
| `eth_getBlockByNumber` | Fetch block data and transactions | Block poller, state poller |
| `eth_getLogs` | Fetch event logs for a block range with address/topic filters | Event log evaluator |
| `eth_getBalance` | Read native token balance at latest block | Balance track evaluator |
| `eth_getStorageAt` | Read raw storage slot value at latest block | State poll evaluator |
| `eth_call` | Execute read-only contract call (view functions, ERC-20 `balanceOf`) | View call evaluator, balance track evaluator |

### RPC node options

Sentinel is compatible with any EVM JSON-RPC endpoint:

| Provider type | Notes |
|--------------|-------|
| Infura | Use the project URL: `https://mainnet.infura.io/v3/<PROJECT_ID>` |
| Alchemy | Use the app URL: `https://eth-mainnet.g.alchemy.com/v2/<API_KEY>` |
| QuickNode | Supported |
| Self-hosted node | Geth, Erigon, Nethermind, or Besu; must be HTTPS in production |
| Tenderly RPC | Supported |

### Load balancing and failover

Multiple RPC URLs can be configured per chain. The client provides two levels of resilience:

1. **URL rotation**: URLs are reordered using a deterministic round-robin based on the current
   hour (`RPC_ROTATION_HOURS` controls the rotation window). This distributes load across
   providers over time.
2. **Automatic failover**: If the primary URL fails, the client tries the next URL in order.
   All configured URLs are tried before the call is considered failed.

### SSRF protection

The RPC client validates all URLs at initialization time:

| Check | Action |
|-------|--------|
| Private IP ranges (RFC 1918, loopback, link-local, CGNAT, broadcast) | Rejected |
| Internal hostnames (`localhost`, `*.internal`, `*.local`, `*.lan`, `*.corp`, `metadata.google.internal`) | Rejected |
| HTTP (non-TLS) URLs | Warning logged; allowed (HTTPS enforced by convention in production) |

**Known limitation**: DNS rebinding attacks (a public hostname resolving to a private IP) are
not prevented at the application layer. Infrastructure-level egress firewall rules or a DNS
resolver with RPZ policies are required for full mitigation.

### Retry behavior

| Parameter | Value |
|-----------|-------|
| Max retries per URL | 3 |
| Base backoff delay | 1,000 ms (exponential: 1 s, 2 s, 4 s) |
| Request timeout | 15,000 ms |
| Total attempts across all URLs | `retries x URL_count` |

### Failure modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| All RPC URLs unreachable | Block polling stops; chain module cannot evaluate rules | BullMQ retries the job (3 attempts) |
| RPC rate limit exhaustion | Individual URL fails; failover to next URL | Configure multiple URLs; use dedicated provider plans |
| Stale block number | Poller processes old blocks; events may be delayed | Provider issue; switch to a different RPC provider |
| Block not found | `getBlock` throws; job fails | Transient; BullMQ retries |

---

## Docker Hub API

**Module**: `@sentinel/module-registry`
**Source**: `modules/registry/src/polling.ts`

### Purpose

The registry module polls Docker Hub for tag changes (new tags, digest changes, tag removals)
on monitored container images.

### Endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET https://hub.docker.com/v2/repositories/{namespace}/{repo}/tags` | GET | Paginated tag listing with digests and timestamps |
| `POST https://hub.docker.com/v2/users/login` | POST | Authenticate for private repository access |

### Authentication

Docker Hub API requests are unauthenticated by default. For private repositories, the registry
module uses per-artifact credentials stored encrypted in `rcArtifacts.credentialsEncrypted`.
The credentials are decrypted at poll time and sent as a `Bearer` token.

### Polling behavior

| Parameter | Value |
|-----------|-------|
| Page size | 100 tags per page |
| Max pages per poll | 10 |
| Full scan frequency | Every 10th poll cycle per artifact |
| Incremental poll cutoff | Stops pagination when `last_updated` is older than `lastPolledAt` |

### Rate limits

Docker Hub applies rate limits on unauthenticated and free-tier authenticated requests:

| Tier | Pull limit |
|------|-----------|
| Anonymous | 100 pulls per 6 hours per IP |
| Authenticated (free) | 200 pulls per 6 hours per account |
| Pro/Team/Business | Higher limits |

The tag listing API (`/v2/repositories/.../tags`) counts against the image pull rate limit.
High-frequency polling of many artifacts from a single IP can exhaust this limit.

### Failure modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| Docker Hub API unreachable | Digest-change detection paused | BullMQ retries; poll sweep re-triggers on next cycle (60 s) |
| Rate limit exhaustion | 429 response; poll fails | Automatic retry on next poll sweep; authenticate for higher limits |
| Private repo auth failure | 401/403 response | User updates credentials in the Sentinel UI |

---

## npm Registry API

**Module**: `@sentinel/module-registry`
**Source**: `modules/registry/src/polling.ts`, `modules/registry/src/npm-registry.ts`, `modules/registry/src/verification.ts`

### Purpose

The registry module polls the npm registry for version changes (new versions, dist-tag
updates) on monitored packages. It also fetches attestation data for npm provenance
verification.

### Endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET https://registry.npmjs.org/{package}` | GET | Full package metadata (all versions, timestamps, maintainers) |
| `GET https://registry.npmjs.org/{package}` (abbreviated) | GET | Incremental poll; uses `Accept: application/vnd.npm.install-v1+json` header |
| `GET https://registry.npmjs.org/-/v1/search?text=scope:{scope}` | GET | Scoped package search |
| `GET https://registry.npmjs.org/-/npm/v1/attestations/{pkg}@{version}` | GET | Fetch Sigstore attestation bundles for provenance verification |

### Authentication

npm registry requests are unauthenticated by default. For private packages or scoped
registries, per-artifact Bearer tokens are stored encrypted in
`rcArtifacts.credentialsEncrypted` and sent in the `Authorization` header.

### Polling behavior

| Parameter | Value |
|-----------|-------|
| Watch modes | `dist-tags` (track latest/next tags) or `versions` (track all versions) |
| Full scan interval (dist-tags mode) | Every 6 hours |
| Full scan frequency (versions mode) | Every 10th poll cycle |
| Incremental poll | Uses abbreviated metadata endpoint for reduced payload size |

### Rate limits

The npm public registry does not publish explicit rate limits but applies throttling under
high request volumes. In practice, Sentinel's polling frequency (60-second sweep intervals
distributed across artifacts) stays well within acceptable limits for typical deployments
(fewer than 100 monitored packages).

### Failure modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| npm registry unreachable | Version-change detection paused | BullMQ retries; poll sweep re-triggers on next cycle |
| Package not found (404) | Poll fails for that artifact | User corrects the package name |
| Attestation not found | Provenance verification skipped; detection rule evaluates without attestation data | Expected for packages without Sigstore provenance |

---

## crt.sh (Certificate Transparency Logs)

**Module**: `@sentinel/module-infra`
**Source**: `modules/infra/src/scanner/steps/ct-logs.ts`, `modules/infra/src/router.ts`

### Purpose

The infra module queries the [crt.sh](https://crt.sh) public API to:

1. Discover subdomains for a monitored host via Certificate Transparency (CT) log entries.
2. Monitor for newly-issued certificates for a domain (certificate issuance tracking).

### Endpoints used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET https://crt.sh/?q={domain}&output=json` | GET | Query CT logs for certificates matching a domain |
| `GET https://crt.sh/?q=%.{domain}&output=json` | GET | Wildcard subdomain discovery (used by the `/discover` route) |

### Authentication

No authentication required. crt.sh is a public service operated by Sectigo.

### Concurrency control

The infra module limits concurrent requests to crt.sh using a Redis-backed concurrency slot
system (`slot:crtsh` key, max 5 concurrent requests). This prevents overwhelming the service
during bulk host scanning operations.

### Rate limits and timeouts

| Parameter | Value |
|-----------|-------|
| Request timeout | 30,000 ms |
| Max concurrent requests | 5 (enforced via Redis concurrency slots) |
| External rate limit | Not published; crt.sh may throttle or return 503 under heavy load |

### Failure modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| crt.sh unreachable or timeout | CT log data unavailable; subdomain discovery returns empty results | Best-effort; scan continues without CT data |
| 503 response | Concurrency limit on crt.sh side | Sentinel concurrency limiter naturally backs off |
| Malformed JSON response | CT log step fails; scan continues with other steps | Logged as warning |

### Data deduplication

CT log entries are deduplicated by serial number before storage. The database schema enforces
a unique index on `(hostId, crtShId)` to prevent duplicate entries across scan cycles.

---

## WHOIS Services

**Module**: `@sentinel/module-infra`
**Source**: `modules/infra/src/scanner/steps/whois.ts`

### Purpose

The infra module performs WHOIS lookups to monitor domain registration expiry dates, registrar
information, name server changes, and domain status codes. WHOIS data feeds the
`infra.whois_expiry` evaluator for domain expiry alerting.

### Protocol

WHOIS queries use raw TCP sockets on port 43 (RFC 3912). The module connects directly to
the appropriate WHOIS server for the domain's TLD, sends the domain name, and parses the
text response.

### WHOIS server mapping

| TLD | WHOIS server |
|-----|-------------|
| `.com`, `.net` | `whois.verisign-grs.com` |
| `.org` | `whois.pir.org` |
| `.io` | `whois.nic.io` |
| `.co` | `whois.nic.co` |
| `.dev`, `.app` | `whois.nic.google` |
| `.ai` | `whois.nic.ai` |
| `.me` | `whois.nic.me` |
| `.info` | `whois.afilias.net` |
| `.xyz` | `whois.nic.xyz` |
| `.uk` | `whois.nic.uk` |
| `.de` | `whois.denic.de` |
| `.fr` | `whois.nic.fr` |
| `.nl` | `whois.sidn.nl` |
| `.eu` | `whois.eu` |
| `.ca` | `whois.cira.ca` |
| `.au` | `whois.auda.org.au` |
| Other TLDs | `whois.iana.org` (IANA referral) |

### Timeouts

| Parameter | Value |
|-----------|-------|
| Socket timeout | 15,000 ms |

### Input sanitization

Domain names are sanitized before sending to the WHOIS server: `\r`, `\n`, and non-printable
characters are stripped to prevent injection of additional WHOIS commands.

### Rate limits

WHOIS services do not publish formal rate limits, but many registrars apply per-IP throttling.
Excessive queries from a single IP may result in temporary blocks (typically 24 hours).
Sentinel performs WHOIS queries as part of the periodic infrastructure scan, not on every
event, which keeps request volumes low.

### Failure modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| WHOIS server unreachable | WHOIS step fails; scan continues with other steps | Best-effort; scan retried on next cycle |
| Socket timeout | Same as unreachable | Logged; next scan cycle retries |
| Unsupported TLD (falls back to IANA) | IANA referral may not provide full WHOIS data | Manual configuration of a custom WHOIS server is not currently supported |
| IP-based rate limiting | WHOIS queries blocked for the source IP | Wait for block to expire (typically 24 hours) |

### Parsed fields

The WHOIS parser extracts:

- Registrar name
- Domain creation date
- Domain expiry date
- Name servers
- Domain status codes (EPP status, e.g., `clientTransferProhibited`)

---

## Sigstore TUF

**Module**: `@sentinel/module-registry`
**Packages**: `@sigstore/verify`, `@sigstore/bundle`, `@sigstore/tuf`

### Purpose

The registry module verifies Docker image signatures and provenance attestations using the
[Sigstore](https://www.sigstore.dev/) ecosystem. Sigstore uses a
[TUF (The Update Framework)](https://theupdateframework.io/) repository to distribute trust
roots for its Certificate Transparency log (Rekor) and certificate authority (Fulcio).

At worker startup, `initVerification()` fetches and caches the current TUF trust root from
the Sigstore TUF repository (`https://tuf-repo-cdn.sigstore.dev`).

### Credentials

No credentials required. The Sigstore TUF repository is a public CDN-backed endpoint.

### Failure modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| TUF repository unreachable at startup | `initVerification()` fails; all signature verification jobs fail | Worker logs error; other worker functionality unaffected; restart after network recovery |
| TUF repository unreachable after initial fetch | Cached trust material continues to work during brief interruptions | Automatic recovery when network is restored |
| Stale trust material | Verification may reject valid signatures signed with rotated keys | Restart worker to refresh TUF cache |

---

## AWS SDK (SQS and STS)

**Module**: `@sentinel/module-aws`
**Packages**: `@aws-sdk/client-sqs`, `@aws-sdk/client-sts`

### Purpose

The AWS module polls an Amazon SQS queue for CloudTrail event notifications, then processes
the CloudTrail events against detection rules. SQS is used as a delivery buffer between
AWS CloudTrail and Sentinel.

### Authentication methods

| Method | Description |
|--------|-------------|
| IAM role (recommended) | Sentinel assumes a cross-account IAM role using STS `AssumeRole`. Role ARN and optional external ID stored encrypted in `aws_integrations.credentialsEncrypted`. |
| Access key | Static AWS access key ID and secret access key, stored encrypted in `aws_integrations.credentialsEncrypted`. |

### Required IAM permissions

**For IAM role assumption (STS):**

The Sentinel execution role must have:

| Permission | Resource | Description |
|-----------|----------|-------------|
| `sts:AssumeRole` | Customer role ARN | Assume the customer's cross-account role |

The customer's IAM role must trust the Sentinel execution role and must have:

| Permission | Resource | Description |
|-----------|----------|-------------|
| `sqs:ReceiveMessage` | SQS queue ARN | Read messages from the CloudTrail SQS queue |
| `sqs:DeleteMessage` | SQS queue ARN | Delete processed messages |
| `sqs:GetQueueAttributes` | SQS queue ARN | Check queue depth and configuration |
| `sqs:ChangeMessageVisibility` | SQS queue ARN | Extend visibility timeout on long-running batches |

### Services used

| AWS Service | Client package | Operations |
|-------------|---------------|------------|
| SQS | `@aws-sdk/client-sqs` | `ReceiveMessage`, `DeleteMessage` |
| STS | `@aws-sdk/client-sts` | `AssumeRole` (when using IAM role auth) |

### Data retention

| Table | Retention |
|-------|-----------|
| `aws_raw_events` | 7 days |
| `events` (AWS module) | 14 days |
| `alerts` (platform) | 365 days |

### Failure modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| SQS queue unreachable | CloudTrail events not ingested | BullMQ retries; poll sweep re-triggers every 60 seconds |
| IAM role assumption fails | Cannot access customer's SQS queue | Verify trust policy and role ARN in integration settings |
| SQS message processing error | Individual message fails | Message visibility timeout expires; SQS redelivers |

---

## SMTP Server (Nodemailer)

**Package**: `nodemailer`
**Environment variables**: `SMTP_URL`, `SMTP_FROM`

### Purpose

Email alert delivery. Nodemailer is used as a transport-agnostic SMTP client.

### Compatible SMTP providers

| Provider | SMTP URL format |
|----------|----------------|
| Gmail (App password) | `smtp://user%40gmail.com:app-password@smtp.gmail.com:587` |
| SendGrid | `smtp://apikey:SG.xxx@smtp.sendgrid.net:587` |
| Mailgun | `smtp://postmaster%40domain:key@smtp.mailgun.org:587` |
| Amazon SES | `smtp://ACCESS_KEY_ID:SECRET_ACCESS_KEY@email-smtp.us-east-1.amazonaws.com:587` |
| Self-hosted Postfix | `smtp://localhost:25` (development only) |

### Connection behavior

The Nodemailer transporter is initialized lazily on first email delivery and cached for the
lifetime of the worker process. Connection errors are caught, recorded in
`notification_deliveries`, and trigger a BullMQ retry.

### Failure modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| SMTP server unreachable | Email alert delivery fails | BullMQ retries (3 attempts with exponential backoff) |
| Authentication failure | All email deliveries fail | Fix SMTP credentials in `SMTP_URL` |
| Sender domain not verified | Emails rejected or sent to spam | Configure SPF/DKIM/DMARC for the `SMTP_FROM` domain |
| `SMTP_URL` not configured | Email channel dispatch fails immediately | Set `SMTP_URL`; other notification channels (Slack, webhook) are unaffected |
