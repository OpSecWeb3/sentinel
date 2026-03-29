# Environment Variables

All environment variables marked **validated** are checked at startup using a
[Zod](https://zod.dev/) schema defined in `packages/shared/src/env.ts`. The API server and
worker both call `env()` on startup; if any required validated variable is missing or fails
validation, the process exits immediately with a descriptive error message.

Additional variables marked **runtime** are read via `process.env` at point-of-use and are
not part of the startup validation schema. Missing runtime variables degrade specific features
rather than preventing startup.

Copy `.env.example` to `.env` to get started in development. See
[.env.example reference](#envexample-reference) at the bottom of this page.

## Quick reference by category

- [Core](#core)
- [Database](#database)
- [Cache (Redis)](#cache-redis)
- [Authentication and security](#authentication-and-security)
- [CORS and URLs](#cors-and-urls)
- [Integrations -- GitHub App](#integrations--github-app)
- [Integrations -- Slack](#integrations--slack)
- [Blockchain (chain module)](#blockchain-chain-module)
- [Email (SMTP)](#email-smtp)
- [AWS integration](#aws-integration)
- [Observability](#observability)
- [Operational overrides](#operational-overrides)
- [Build-time only (web)](#build-time-only-web)

---

## Core

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `NODE_ENV` | No | `development` | No | Validated. Enum: `development`, `production`, `test`. | Runtime environment. Affects logging format, security headers (HSTS), cookie `Secure` flag, and Sentry initialization. | `production` |
| `PORT` | No | `4000` | No | Validated. Coerced to number. | TCP port the API HTTP server binds to. The production Docker Compose overrides this to `4100`. | `4100` |

---

## Database

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `DATABASE_URL` | **Yes** | -- | **Yes** | Validated. Must be a valid URL. | PostgreSQL connection string. Use `?sslmode=require` in production to enforce TLS. | `postgresql://sentinel:pass@db:5432/sentinel?sslmode=require` |
| `POSTGRES_PASSWORD` | No | -- | **Yes** | Runtime (Docker Compose only). | Used only by `docker-compose.yml` and `docker-compose.dev.yml` to initialize the development database container. Not read by the application. | `devpassword` |

**Production note**: The application does not use read replicas. All queries (reads and
writes) go to the single primary PostgreSQL instance. The worker initializes a larger
connection pool (`maxConnections: 20`) to support concurrent BullMQ job processing.

---

## Cache (Redis)

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `REDIS_URL` | No | `redis://localhost:6379` | **Yes** | Validated. String with default. In production, a `superRefine` check enforces a valid URL with `redis://` or `rediss://` scheme and a password. | Redis connection URL. Use `rediss://` with TLS in production. Include the password in the URL. Both the API server and worker create connections from this URL. | `rediss://:password@redis.internal:6379` |

**Production enforcement**: When `NODE_ENV=production`, the Zod `superRefine` block validates
that `REDIS_URL` is a well-formed URL using the `redis:` or `rediss:` protocol and contains
an authentication password. If any check fails, the process exits at startup.

**Connection model**: The API server creates one shared Redis connection used by the rate
limiter, health check, and BullMQ queue producers. The worker creates one shared connection
for queue producers plus one dedicated connection per BullMQ Worker instance (to avoid
head-of-line blocking on `BRPOPLPUSH`). A two-replica worker deployment with four queues
creates approximately 10 Redis connections total.

---

## Authentication and security

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `SESSION_SECRET` | **Yes** | -- | **Yes** | Validated. Minimum 32 characters. | Secret used to sign session cookies. Use a cryptographically random string in production. | `$(openssl rand -base64 48)` |
| `ENCRYPTION_KEY` | **Yes** | -- | **Yes** | Validated. Must match regex `^[0-9a-f]{64}$/i` (64 hex characters = 32 bytes AES-256). | AES-256-GCM encryption key for secrets stored in the database (Slack tokens, AWS credentials, Docker registry credentials). | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ENCRYPTION_KEY_PREV` | No | -- | **Yes** | Validated. Must match the same 64 hex character regex when present. | Previous encryption key, used during key rotation. The `platform.key.rotation` worker job re-encrypts all ciphertext columns in batches of 100 rows every 5 minutes. Remove after rotation is complete. | (previous `ENCRYPTION_KEY` value) |

**Security requirements:**

- `SESSION_SECRET`: The Zod schema enforces a minimum length of 32 characters. Values shorter
  than 32 characters cause the application to exit at startup.
- `ENCRYPTION_KEY`: Must be exactly 64 hex characters (validated by Zod regex). Any
  other length causes a startup failure.
- `ENCRYPTION_KEY_PREV`: Optional. When set, it must also be exactly 64 hex characters. The
  key rotation handler (`platform.key.rotation`) automatically re-encrypts all ciphertext
  columns in batches of 100 rows every 5 minutes until all rows use the current key.

**Example (development only -- never use these values in production):**
```
SESSION_SECRET=change-me-to-a-long-random-string-at-least-32-chars
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
```

---

## CORS and URLs

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `API_BASE_URL` | No | `http://localhost:4000` | No | Validated. Must be a valid URL. | Public base URL of the API server. Used to construct OAuth `redirect_uri` values. Must match the URL registered with GitHub App and Slack OAuth. Do not derive from request headers. | `https://api.sentinel.example.com` |
| `ALLOWED_ORIGINS` | No | `http://localhost:3000` | No | Validated. Comma-separated string. | Comma-separated list of origins allowed by the CORS policy. The API sets `Access-Control-Allow-Origin` to match any of these origins. Do not use wildcards. | `https://sentinel.example.com,https://www.sentinel.example.com` |
| `NEXT_PUBLIC_API_URL` | No | -- | No | Runtime (Next.js build-time). | Read by the Next.js web app at build time. Must point to the public API URL. This is a Next.js public environment variable and must be set before running `next build`. Also seeded into SSM and passed as a Docker build argument for the production web service. | `https://api.sentinel.example.com` |

---

## Integrations -- GitHub App

All GitHub App variables are optional. The GitHub module is fully functional without them;
however, GitHub webhook reception and OAuth user authentication will not work until these are
set.

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `GITHUB_APP_ID` | No | -- | No | Validated. Optional string. | Numeric ID of the GitHub App, found in the App Settings page. Required to generate App JWTs for authentication. | `123456` |
| `GITHUB_APP_PRIVATE_KEY` | No | -- | **Yes** | Validated. Optional string, PEM format. | RSA private key in PEM format, used to sign GitHub App JWTs (RS256). Newlines may be represented as `\n` in a single-line environment variable value. | `-----BEGIN RSA PRIVATE KEY-----\nMIIE...` |
| `GITHUB_APP_WEBHOOK_SECRET` | No | -- | **Yes** | Validated. Optional string. | Shared secret used to verify the HMAC-SHA256 signature on incoming GitHub webhooks (`X-Hub-Signature-256`). | `whsec_abc123...` |
| `GITHUB_APP_SLUG` | No | -- | No | Validated. Optional string. | URL slug of the GitHub App (the `name` field from the App settings page). Used to construct the App installation URL shown in the Sentinel UI. | `sentinel-security` |
| `GITHUB_APP_CLIENT_ID` | No | -- | No | Validated. Optional string. | OAuth client ID, used for the GitHub OAuth user authorization flow. | `Iv1.abc123...` |
| `GITHUB_APP_CLIENT_SECRET` | No | -- | **Yes** | Validated. Optional string. | OAuth client secret, used for the GitHub OAuth user authorization flow. | `secret_abc123...` |
| `GITHUB_TOKEN` | No | -- | **Yes** | Validated. Optional string. | GitHub personal access token used by the registry module to authenticate requests to the GitHub Container Registry (GHCR) and GitHub Packages API when fetching Docker image tags. Not used by the GitHub module itself. | `ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |

---

## Integrations -- Slack

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `SLACK_CLIENT_ID` | No | -- | No | Validated. Optional string. | OAuth client ID for the Slack App, found in the Slack App configuration page under "App Credentials". Required for the Slack OAuth flow. | `1234567890.1234567890` |
| `SLACK_CLIENT_SECRET` | No | -- | **Yes** | Validated. Optional string. | OAuth client secret for the Slack App. Used to exchange the OAuth authorization code for a bot token. | `abc123def456...` |

**Note**: After a successful OAuth flow, the Slack bot token is stored encrypted in the
`slack_installations` table and is retrieved automatically at alert dispatch time. Operators do
not need to provision the bot token manually.

---

## Blockchain (chain module)

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `RPC_ROTATION_HOURS` | No | `10` | No | Validated. Non-negative integer (coerced from string). | Rotate the primary RPC provider URL every N hours for load distribution. Set to `0` to disable rotation. Only relevant when multiple RPC URLs are configured per chain. | `10` |
| `ETHERSCAN_API_KEY` | No | -- | **Yes** | Validated. Optional string. | Etherscan API key used for contract ABI and source verification lookups. Without a key, requests use the unauthenticated tier (1 request per 5 seconds). | `ABCDEF1234567890ABCDEF1234567890AB` |
| `RPC_ETHEREUM` | No | -- | **Yes** | Runtime (SSM only). | Comma-separated Ethereum Mainnet RPC URL(s). Overrides the seeded public fallback URLs in the chain-networks seed data. Seeded via `scripts/seed-ssm.sh`. | `https://mainnet.infura.io/v3/KEY,https://eth-mainnet.g.alchemy.com/v2/KEY` |

**Note on RPC URLs**: Per-chain RPC URLs are primarily configured in the database
(`chain_networks` table) and seeded via `packages/db/src/seed/chain-networks.ts`. The
`RPC_ETHEREUM` SSM parameter provides an override mechanism for production deployments.
Individual detections can also specify custom RPC endpoints. All RPC URLs are validated for
SSRF safety at initialization time (private IP ranges, internal hostnames, and non-HTTPS
schemes are rejected or warned).

---

## Email (SMTP)

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `SMTP_URL` | No | -- | **Yes** | Validated. Optional string. | SMTP connection URL passed directly to Nodemailer's `createTransport`. Supports `smtp://`, `smtps://`, and `smtp+starttls://` schemes. If not set, email delivery is unavailable and any email channel dispatch fails. | `smtp://user:password@smtp.example.com:587` |
| `SMTP_FROM` | No | `alerts@sentinel.dev` | No | Validated. String with default. | The `From` address used for all outgoing alert emails. Must be a valid RFC 5321 address. Use a verified sender domain in production. | `alerts@sentinel.example.com` |

---

## AWS integration

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `AWS_SENTINEL_ROLE_ARN` | No | -- | No | Validated. Must start with `arn:aws:iam::` when set. | Intermediate SentinelService IAM role ARN. Required when running off-AWS with IAM user credentials. The bootstrap IAM user assumes this role first, then the role assumes customer cross-account roles. When running on AWS with an instance profile that is already the SentinelService role, leave unset. | `arn:aws:iam::123456789012:role/SentinelService` |
| `AWS_ACCESS_KEY_ID` | No | -- | **Yes** | Runtime (standard AWS SDK env var). | Bootstrap IAM user access key ID. Required only when running off-AWS. On AWS instances with an instance profile, the SDK automatically uses the instance metadata service. | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | No | -- | **Yes** | Runtime (standard AWS SDK env var). | Bootstrap IAM user secret access key. Always paired with `AWS_ACCESS_KEY_ID`. | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |

**Cross-account flow**: When running off-AWS (e.g., Hetzner VPS), the worker uses the
bootstrap IAM user credentials (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`) to assume the
`AWS_SENTINEL_ROLE_ARN` role via STS. That intermediate role then assumes each customer's
cross-account role (stored encrypted per integration in the database). When running on AWS
with an instance profile, the SDK picks up credentials automatically and
`AWS_SENTINEL_ROLE_ARN` is only needed if the instance profile is not the SentinelService
role itself.

---

## Observability

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `LOG_LEVEL` | No | `info` | No | Validated. Enum: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. | Minimum log level emitted by [Pino](https://getpino.io/). Use `debug` or `trace` only in development; these levels are verbose in production. | `warn` |
| `SENTRY_DSN` | No | -- | **Yes** | Validated. Optional, must be a valid URL when set. | Sentry DSN for the API and worker. Production deploy reuses this value as `NEXT_PUBLIC_SENTRY_DSN` for the Next.js build so browser and server events share one project. If not set, server-side Sentry is not initialized. | `https://abc123@o123456.ingest.sentry.io/1234567` |
| `SENTRY_ENVIRONMENT` | No | -- | No | Validated. Optional string. | Environment tag for API and worker Sentry events. If not set, falls back to `NODE_ENV`. Production deploy sets `NEXT_PUBLIC_SENTRY_ENVIRONMENT` to the same value for the Next.js client. | `production` |
| `METRICS_TOKEN` | No | -- | **Yes** | Validated. Optional string. | Bearer token required to access the Prometheus `/metrics` endpoint. When unset, the endpoint is unauthenticated. In production, the API logs a warning if this is not configured. | `$(openssl rand -base64 32)` |

---

## Operational overrides

These variables are part of the Zod-validated environment schema but are intended for testing
or specific deployment scenarios.

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `DISABLE_RATE_LIMIT` | No | `false` | No | Validated. Enum: `true`, `false`. | When set to `true`, disables all Redis-backed API rate limiting. Intended for integration tests only. Do not set in production. | `true` |
| `TRUSTED_PROXY_COUNT` | No | `0` | No | Validated. Non-negative integer (coerced from string). | Number of trusted reverse proxies in front of the API server. When greater than 0, the rate limiter reads `X-Forwarded-For` at depth N from the right to determine client IP. When 0, uses raw socket `remoteAddress` only. Set to `1` when running behind a single nginx reverse proxy. | `1` |

---

## Build-time only (web)

These variables are consumed exclusively during the `next build` step, either at the Docker
image build stage or during a local build. They are not part of the Zod schema and are not
read at runtime by the API or worker.

| Variable | Required | Default | Sensitive | Validation | Description | Example |
|----------|----------|---------|-----------|------------|-------------|---------|
| `NEXT_PUBLIC_SENTRY_DSN` | No | -- | No | Build-time for Next.js. Read by `@sentry/nextjs` on the **client**. | Must match `SENTRY_DSN` when using a single Sentry project. Inlined at build time (Docker build arg / local `pnpm build`). If not set, client-side error reporting is disabled. | `https://abc123@o123456.ingest.sentry.io/1234567` |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | No | -- | No | Build-time for Next.js. | Environment tag for client Sentry events. Should match `SENTRY_ENVIRONMENT`. If not set, the client falls back to `NODE_ENV`. | `production` |
| `SENTRY_ORG` | No | -- | No | Build-time only. Used by `@sentry/nextjs` during `next build`. | Sentry organization slug, required for source map uploads. | `my-org` |
| `SENTRY_PROJECT` | No | -- | No | Build-time only. Used by `@sentry/nextjs` during `next build`. | Sentry project slug, required for source map uploads. | `sentinel-web` |
| `SENTRY_AUTH_TOKEN` | No | -- | **Yes** | Build-time only. Used by `@sentry/nextjs` during `next build`. | Sentry authentication token for uploading source maps during the Docker build. Generate at `sentry.io/settings/auth-tokens/`. If not set, source maps are not uploaded and production stack traces will be minified. | `sntrys_...` |

---

## Service-level variable requirements

The following table shows which service consumes each variable. A cell marked with a dash
indicates the variable is not used by that service.

| Variable | API | Worker | Web |
|----------|-----|--------|-----|
| `NODE_ENV` | Yes | Yes | Yes |
| `PORT` | Yes | -- | Yes |
| `DATABASE_URL` | Yes | Yes | -- |
| `REDIS_URL` | Yes | Yes | -- |
| `SESSION_SECRET` | Yes | Yes | -- |
| `ENCRYPTION_KEY` | Yes | Yes | -- |
| `ENCRYPTION_KEY_PREV` | Yes | Yes | -- |
| `API_BASE_URL` | Yes | -- | -- |
| `ALLOWED_ORIGINS` | Yes | -- | -- |
| `NEXT_PUBLIC_API_URL` | -- | -- | Build-time |
| `GITHUB_APP_*` | Yes | Yes | -- |
| `GITHUB_TOKEN` | -- | Yes | -- |
| `SLACK_CLIENT_ID` | Yes | -- | -- |
| `SLACK_CLIENT_SECRET` | Yes | -- | -- |
| `RPC_ROTATION_HOURS` | -- | Yes | -- |
| `ETHERSCAN_API_KEY` | -- | Yes | -- |
| `SMTP_URL` | -- | Yes | -- |
| `SMTP_FROM` | -- | Yes | -- |
| `AWS_SENTINEL_ROLE_ARN` | -- | Yes | -- |
| `AWS_ACCESS_KEY_ID` | -- | Yes | -- |
| `AWS_SECRET_ACCESS_KEY` | -- | Yes | -- |
| `LOG_LEVEL` | Yes | Yes | -- |
| `SENTRY_DSN` | Yes | Yes | -- |
| `SENTRY_ENVIRONMENT` | Yes | Yes | -- |
| `METRICS_TOKEN` | Yes | -- | -- |
| `DISABLE_RATE_LIMIT` | Yes | -- | -- |
| `TRUSTED_PROXY_COUNT` | Yes | -- | -- |

---

## Sensitive variables that must not be logged

The following variables contain credentials or cryptographic material and must never appear in
log output, error messages, health check responses, or monitoring dashboards:

- `DATABASE_URL` (contains password)
- `REDIS_URL` (contains password in production)
- `SESSION_SECRET`
- `ENCRYPTION_KEY`
- `ENCRYPTION_KEY_PREV`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_WEBHOOK_SECRET`
- `GITHUB_TOKEN`
- `SLACK_CLIENT_SECRET`
- `SMTP_URL` (may contain password)
- `ETHERSCAN_API_KEY`
- `RPC_ETHEREUM` (may contain API keys)
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `SENTRY_DSN` (contains ingest key)
- `SENTRY_AUTH_TOKEN`
- `METRICS_TOKEN`

---

## Consolidated variable table

The following table lists every environment variable in a single view for quick scanning.

| Variable | Category | Required | Default | Sensitive | Zod-validated |
|----------|----------|----------|---------|-----------|---------------|
| `NODE_ENV` | Core | No | `development` | No | Yes |
| `PORT` | Core | No | `4000` | No | Yes |
| `DATABASE_URL` | Database | **Yes** | -- | **Yes** | Yes |
| `POSTGRES_PASSWORD` | Database | No | -- | **Yes** | No |
| `REDIS_URL` | Redis | No | `redis://localhost:6379` | **Yes** | Yes |
| `SESSION_SECRET` | Auth/Security | **Yes** | -- | **Yes** | Yes |
| `ENCRYPTION_KEY` | Auth/Security | **Yes** | -- | **Yes** | Yes |
| `ENCRYPTION_KEY_PREV` | Auth/Security | No | -- | **Yes** | Yes |
| `API_BASE_URL` | CORS/URLs | No | `http://localhost:4000` | No | Yes |
| `ALLOWED_ORIGINS` | CORS/URLs | No | `http://localhost:3000` | No | Yes |
| `NEXT_PUBLIC_API_URL` | CORS/URLs | No | -- | No | No |
| `GITHUB_APP_ID` | GitHub | No | -- | No | Yes |
| `GITHUB_APP_PRIVATE_KEY` | GitHub | No | -- | **Yes** | Yes |
| `GITHUB_APP_WEBHOOK_SECRET` | GitHub | No | -- | **Yes** | Yes |
| `GITHUB_APP_SLUG` | GitHub | No | -- | No | Yes |
| `GITHUB_APP_CLIENT_ID` | GitHub | No | -- | No | Yes |
| `GITHUB_APP_CLIENT_SECRET` | GitHub | No | -- | **Yes** | Yes |
| `GITHUB_TOKEN` | GitHub/Registry | No | -- | **Yes** | Yes |
| `SLACK_CLIENT_ID` | Slack | No | -- | No | Yes |
| `SLACK_CLIENT_SECRET` | Slack | No | -- | **Yes** | Yes |
| `RPC_ROTATION_HOURS` | Blockchain | No | `10` | No | Yes |
| `ETHERSCAN_API_KEY` | Blockchain | No | -- | **Yes** | Yes |
| `RPC_ETHEREUM` | Blockchain | No | -- | **Yes** | No |
| `SMTP_URL` | Email | No | -- | **Yes** | Yes |
| `SMTP_FROM` | Email | No | `alerts@sentinel.dev` | No | Yes |
| `AWS_SENTINEL_ROLE_ARN` | AWS | No | -- | No | Yes |
| `AWS_ACCESS_KEY_ID` | AWS | No | -- | **Yes** | No |
| `AWS_SECRET_ACCESS_KEY` | AWS | No | -- | **Yes** | No |
| `LOG_LEVEL` | Observability | No | `info` | No | Yes |
| `SENTRY_DSN` | Observability | No | -- | **Yes** | Yes |
| `SENTRY_ENVIRONMENT` | Observability | No | -- | No | Yes |
| `METRICS_TOKEN` | Observability | No | -- | **Yes** | Yes |
| `NEXT_PUBLIC_SENTRY_DSN` | Observability | No | -- | No | No |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | Observability | No | -- | No | No |
| `SENTRY_ORG` | Build-time | No | -- | No | No |
| `SENTRY_PROJECT` | Build-time | No | -- | No | No |
| `SENTRY_AUTH_TOKEN` | Build-time | No | -- | **Yes** | No |
| `DISABLE_RATE_LIMIT` | Override | No | `false` | No | Yes |
| `TRUSTED_PROXY_COUNT` | Override | No | `0` | No | Yes |

---

## Production vs development

### Development

In development, the `.env.example` defaults are designed to work with the Docker Compose
service definitions. The database runs on port 5434 and Redis on port 6380 to avoid conflicts
with locally-installed instances.

The development encryption key in `.env.example` (`000...000`) is intentionally trivial.
Replace it with a securely generated value before storing any real secrets in the database.

### Production

The following additional steps are required before deploying to production:

1. **Generate a strong session secret**: `openssl rand -base64 48`
2. **Generate a strong encryption key**: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. **Use TLS for all external connections**:
   - Append `?sslmode=require` to `DATABASE_URL`.
   - Use the `rediss://` scheme for `REDIS_URL`.
4. **Set `API_BASE_URL`** to the public HTTPS URL of the API server. This value is used as
   the OAuth redirect URI and must match the registered callback URL in the GitHub App and
   Slack App configuration.
5. **Set `ALLOWED_ORIGINS`** to the exact origin of the web application. Do not use wildcards.
6. **Set `TRUSTED_PROXY_COUNT`** to `1` when behind a single nginx reverse proxy (the default
   production topology on the shared Hetzner VPS).
7. **Set `METRICS_TOKEN`** to protect the Prometheus `/metrics` endpoint. Without it, the
   endpoint is publicly accessible without authentication.
8. **Configure SMTP** if email notification channels are required.
9. **Configure Sentry** for error tracking in production.
10. **Seed SSM parameters** using `scripts/seed-ssm.sh --generate` for first-time deployments.
    See [Secrets Management](../deployment/secrets-management.md) for details.

---

## .env.example reference

The `.env.example` file at the repository root contains all required and commonly-used
optional variables with safe development defaults. It is the canonical starting point for
local development. Copy it to `.env` and adjust values as needed:

```bash
cp .env.example .env
```

Variables marked as sensitive in the table above must never be committed to version control.
The `.gitignore` file excludes `.env` by default. For production secret management, use
`scripts/seed-ssm.sh` to store secrets in AWS SSM Parameter Store as `SecureString` values.
