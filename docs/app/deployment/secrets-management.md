# Secrets Management

Sentinel uses AWS SSM Parameter Store as the single source of truth for production secrets. No secret value ever appears in git history, GitHub Actions environment variables, or the GitHub UI. This document describes the complete secrets lifecycle from storage through rotation.

## Production secrets flow

```
AWS SSM Parameter Store
        │
        │  aws ssm get-parameter --with-decryption
        ▼
GitHub Actions runner (in-memory only)
        │
        │  scp /tmp/sentinel.env → /opt/sentinel/.env
        ▼
Hetzner VPS filesystem  (/opt/sentinel/.env)
        │
        │  env_file: .env  (Docker Compose)
        ▼
Container environment variables
```

At no point are secrets stored in:
- The git repository (`.env` is listed in `.gitignore`)
- GitHub Actions secrets (only the AWS role ARN, region, and SSH key are stored there)
- Docker images or build artifacts
- GitHub Actions job logs (secrets fetched via AWS SDK do not appear in log output)

## AWS SSM parameter structure

All Sentinel parameters follow the naming convention `/sentinel/<environment>/<VARIABLE_NAME>`. Parameters shared across applications (such as Redis credentials) use `/shared/<environment>/<VARIABLE_NAME>`.

### Required parameters

| SSM parameter | Environment variable | Type | Description |
|---|---|---|---|
| `/sentinel/production/DATABASE_URL` | `DATABASE_URL` | `SecureString` | PostgreSQL connection string. Include `?sslmode=require` for TLS. |
| `/sentinel/production/SESSION_SECRET` | `SESSION_SECRET` | `SecureString` | Cookie signing secret, minimum 32 characters. |
| `/sentinel/production/ENCRYPTION_KEY` | `ENCRYPTION_KEY` | `SecureString` | 64 hex characters (32 bytes) for AES-256-GCM field encryption. |
| `/sentinel/production/ENCRYPTION_KEY_PREV` | `ENCRYPTION_KEY_PREV` | `SecureString` | Previous encryption key; set during key rotation (decrypt-only). |
| `/sentinel/production/ALLOWED_ORIGINS` | `ALLOWED_ORIGINS` | `String` | Comma-separated list of allowed CORS origins. |
| `/sentinel/production/NEXT_PUBLIC_API_URL` | `NEXT_PUBLIC_API_URL` | `String` | Public API URL, inlined into the Next.js bundle at build time. |
| `/shared/production/REDIS_PASSWORD` | Used to construct `REDIS_URL` | `SecureString` | Redis password. The deploy workflow constructs `REDIS_URL` as `redis://:<password>@redis:6379`. |

### Optional parameters

| SSM parameter | Environment variable | Description |
|---|---|---|
| `/sentinel/production/SLACK_CLIENT_ID` | `SLACK_CLIENT_ID` | Slack OAuth app client ID. |
| `/sentinel/production/SLACK_CLIENT_SECRET` | `SLACK_CLIENT_SECRET` | Slack OAuth app client secret. |
| `/sentinel/production/GITHUB_APP_ID` | `GITHUB_APP_ID` | GitHub App numeric ID. |
| `/sentinel/production/GITHUB_APP_PRIVATE_KEY` | `GITHUB_APP_PRIVATE_KEY` | GitHub App RSA private key (PEM format, multi-line). |
| `/sentinel/production/GITHUB_APP_WEBHOOK_SECRET` | `GITHUB_APP_WEBHOOK_SECRET` | Secret for validating GitHub webhook payloads. |
| `/sentinel/production/GITHUB_APP_CLIENT_ID` | `GITHUB_APP_CLIENT_ID` | GitHub App OAuth client ID. |
| `/sentinel/production/GITHUB_APP_CLIENT_SECRET` | `GITHUB_APP_CLIENT_SECRET` | GitHub App OAuth client secret. |
| `/sentinel/production/GITHUB_APP_SLUG` | `GITHUB_APP_SLUG` | GitHub App URL slug. |
| `/sentinel/production/GITHUB_TOKEN` | `GITHUB_TOKEN` | Personal access token for GitHub API calls. |
| `/sentinel/production/SMTP_URL` | `SMTP_URL` | SMTP connection string, e.g. `smtps://user:pass@smtp.example.com:465`. |
| `/sentinel/production/SMTP_FROM` | `SMTP_FROM` | From address for outbound email. Defaults to `alerts@sentinel.dev`. |
| `/sentinel/production/SENTRY_DSN` | `SENTRY_DSN` | Single Sentry project DSN for API, worker, and web. Deploy copies this value into `NEXT_PUBLIC_SENTRY_DSN` for the Next.js build (browser telemetry). |
| `/sentinel/production/SENTRY_ENVIRONMENT` | `SENTRY_ENVIRONMENT` | Sentry environment tag. Defaults to `production`. Deploy also writes `NEXT_PUBLIC_SENTRY_ENVIRONMENT` to match for client events. |
| `/sentinel/production/SENTRY_AUTH_TOKEN` | `SENTRY_AUTH_TOKEN` | Sentry auth token for source map uploads during Docker build. Generate at `sentry.io/settings/auth-tokens/`. |
| `/sentinel/production/ETHERSCAN_API_KEY` | `ETHERSCAN_API_KEY` | Etherscan API key for on-chain module queries. |
| `/sentinel/production/RPC_ETHEREUM` | `RPC_ETHEREUM` | Ethereum Mainnet RPC URL(s), comma-separated. Overrides seeded public fallbacks. |

## Seeding SSM parameters with `seed-ssm.sh`

The `scripts/seed-ssm.sh` script provides an interactive wizard for populating all SSM
parameters before the first production deploy. It requires the AWS CLI configured with
write access to the target region.

### Usage

```bash
# Skip parameters that already exist in SSM
bash scripts/seed-ssm.sh

# Auto-generate SESSION_SECRET and ENCRYPTION_KEY for new installations
bash scripts/seed-ssm.sh --generate

# Re-prompt for all parameters, including those that already exist
bash scripts/seed-ssm.sh --update

# Generate keys and overwrite existing values
bash scripts/seed-ssm.sh --generate --update
```

### Flags

| Flag | Description |
|---|---|
| `--generate` | Auto-generates `SESSION_SECRET` (48 random bytes, base64url) and `ENCRYPTION_KEY` (32 random bytes, hex) instead of prompting. Only generates when the parameter does not already exist, unless combined with `--update`. |
| `--update` | Re-prompts for all parameters, even those that already exist in SSM. Without this flag, existing parameters are skipped. |

### Behavior

The script processes parameters in two groups:

1. **Required parameters**: `DATABASE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`,
   `ENCRYPTION_KEY_PREV`, `ALLOWED_ORIGINS`, `NEXT_PUBLIC_API_URL`.
2. **Optional parameters**: Slack, GitHub App, SMTP, Sentry (server + client DSN, auth token),
   Etherscan, and RPC credentials. Press Enter at any prompt to skip.

All parameters are stored as `SecureString` type in SSM under the prefix
`/sentinel/production/`. The default region is `eu-west-2` (overridable via the `AWS_REGION`
environment variable).

The `REDIS_PASSWORD` parameter is stored at `/shared/production/REDIS_PASSWORD` (a shared
infrastructure path) and must be seeded separately:

```bash
aws ssm put-parameter \
  --region eu-west-2 \
  --name /shared/production/REDIS_PASSWORD \
  --type SecureString \
  --value '<password>' \
  --overwrite
```

### Verification

After running the script, verify all parameters were written:

```bash
aws ssm get-parameters-by-path \
  --path /sentinel/production \
  --with-decryption \
  --region eu-west-2 \
  --query 'Parameters[].Name' \
  --output table
```

## AWS IAM role for GitHub Actions OIDC

The deploy workflow assumes an IAM role rather than using a static access key. Create a role with the following trust policy, replacing `<your-github-org>` and `<your-repo>` with your actual values:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<your-github-org>/<your-repo>:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

The `sub` condition restricts role assumption to the `main` branch of your specific repository. Pull request builds and other branches cannot assume the role.

Attach the following inline or managed policy to the role to grant read access to SSM parameters:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters"
      ],
      "Resource": [
        "arn:aws:ssm:<region>:<account-id>:parameter/sentinel/production/*",
        "arn:aws:ssm:<region>:<account-id>:parameter/shared/production/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:<region>:<account-id>:key/<your-kms-key-id>"
    }
  ]
}
```

The `kms:Decrypt` permission is required only if `SecureString` parameters are encrypted with a customer-managed KMS key. If you use the default SSM-managed key (`alias/aws/ssm`), decryption is handled automatically and no explicit KMS permission is required.

## Adding a new secret

1. Store the value in AWS SSM:

   ```bash
   aws ssm put-parameter \
     --name "/sentinel/production/MY_NEW_SECRET" \
     --value "the-secret-value" \
     --type SecureString \
     --overwrite
   ```

2. Add the fetch call to the deploy workflow in `.github/workflows/deploy.yml`:

   ```bash
   MY_NEW_SECRET=$(fetch_param /sentinel/production/MY_NEW_SECRET)
   ```

3. Add the `printf` line to the `.env` construction block in the same step:

   ```bash
   printf 'MY_NEW_SECRET=%s\n' "$MY_NEW_SECRET"
   ```

4. Add the variable to `.env.example` with a placeholder or description comment so developers know it exists:

   ```
   # My new secret (required for X feature)
   # MY_NEW_SECRET=
   ```

5. Commit and push. The next deploy picks up the new variable automatically.

## Rotating the encryption key

`ENCRYPTION_KEY` is a 32-byte key used for AES-256-GCM encryption of sensitive fields in the database (webhook secrets, integration credentials, and similar values).

Sentinel supports zero-downtime key rotation via `ENCRYPTION_KEY_PREV`. During rotation, the application decrypts existing values with `ENCRYPTION_KEY_PREV` and re-encrypts them with the new `ENCRYPTION_KEY`. The old key is retained in `ENCRYPTION_KEY_PREV` until all data has been migrated.

### Rotation procedure

1. Generate a new 32-byte key:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Retrieve the current `ENCRYPTION_KEY` from SSM:

   ```bash
   aws ssm get-parameter \
     --name "/sentinel/production/ENCRYPTION_KEY" \
     --with-decryption \
     --query 'Parameter.Value' \
     --output text
   ```

3. Write the current key to `ENCRYPTION_KEY_PREV` in SSM:

   ```bash
   aws ssm put-parameter \
     --name "/sentinel/production/ENCRYPTION_KEY_PREV" \
     --value "<current-key-value>" \
     --type SecureString \
     --overwrite
   ```

4. Write the new key to `ENCRYPTION_KEY` in SSM:

   ```bash
   aws ssm put-parameter \
     --name "/sentinel/production/ENCRYPTION_KEY" \
     --value "<new-key-value>" \
     --type SecureString \
     --overwrite
   ```

5. Push any change to `main` to trigger a deploy, or run `bash scripts/deploy.sh` manually on the VPS.

6. After confirming the application is healthy and all data has been re-encrypted (check application logs), clear `ENCRYPTION_KEY_PREV`:

   ```bash
   aws ssm put-parameter \
     --name "/sentinel/production/ENCRYPTION_KEY_PREV" \
     --value "" \
     --type SecureString \
     --overwrite
   ```

Do not delete `ENCRYPTION_KEY_PREV` from SSM. The deploy workflow fetches it unconditionally; deleting the parameter causes the `aws ssm get-parameter` call to error. Setting it to an empty string is the safe approach.

## Rotating the session secret

`SESSION_SECRET` signs the session cookies. Changing it immediately invalidates all active sessions, logging out all users.

1. Generate a new secret:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
   ```

2. Update the value in SSM:

   ```bash
   aws ssm put-parameter \
     --name "/sentinel/production/SESSION_SECRET" \
     --value "<new-secret>" \
     --type SecureString \
     --overwrite
   ```

3. Deploy. All users are signed out when the new containers start.

Unlike `ENCRYPTION_KEY`, there is no gradual migration path for `SESSION_SECRET`. Schedule the rotation during low-traffic hours and communicate the forced sign-out to users in advance if required by your organization's policy.

## Local development

For local development, secrets live only in the `.env` file at the repository root.

```bash
cp .env.example .env
```

The `.env` file is listed in `.gitignore` and is never committed. Review `.gitignore` to confirm:

```
.env
.env.local
.env.*.local
```

The `.env.example` file contains only placeholder values and comments. It is safe to commit. Do not put real secrets in `.env.example`.

Generate local development values for the required secrets:

```bash
# Generate ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

The default values in `.env.example` (all-zeros `ENCRYPTION_KEY`, the placeholder `SESSION_SECRET`) are safe for local development only. Never use them in production or staging environments.

## Security properties summary

| Property | Implementation |
|---|---|
| Secrets never in git | `.env` in `.gitignore`; no secret values in `.env.example` |
| No long-lived CI credentials | AWS OIDC; credentials expire at job end |
| Secrets ephemeral in CI | Written to `/tmp/sentinel.env` in-memory; not cached or uploaded as artifacts |
| Secrets delivered per-deploy | SSM fetched fresh on every deploy; stale values cannot persist |
| Encrypted at rest | SSM `SecureString` type encrypts values using KMS |
| Encrypted in transit | AWS SDK uses TLS; `scp` uses SSH |
| Principle of least privilege | IAM role scoped to `main` branch of one repository, read-only SSM access |
| Non-root containers | All containers run as `sentinel` (UID 1001), not root |
