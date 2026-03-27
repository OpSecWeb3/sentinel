#!/usr/bin/env bash
set -euo pipefail

# Seeds AWS SSM Parameter Store with Sentinel production secrets.
# Run once before first deploy. Requires AWS CLI configured with write access.
#
# Usage:
#   bash scripts/seed-ssm.sh                  # interactive prompts
#   bash scripts/seed-ssm.sh --generate       # auto-generate SESSION_SECRET & ENCRYPTION_KEY

REGION="${AWS_REGION:-eu-central-1}"
PREFIX="/sentinel/production"
GENERATE=false

if [[ "${1:-}" == "--generate" ]]; then
  GENERATE=true
fi

put_param() {
  local name="$1"
  local value="$2"
  local description="${3:-}"

  if [ -z "$value" ]; then
    echo "  SKIP: $name (empty value)"
    return
  fi

  aws ssm put-parameter \
    --region "$REGION" \
    --name "${PREFIX}/${name}" \
    --type SecureString \
    --value "$value" \
    --description "$description" \
    --overwrite \
    --no-cli-pager

  echo "  SET:  ${PREFIX}/${name}"
}

prompt_or_default() {
  local var_name="$1"
  local prompt_text="$2"
  local default="${3:-}"

  if [ -n "$default" ]; then
    read -rp "${prompt_text} [${default}]: " value
    echo "${value:-$default}"
  else
    read -rp "${prompt_text}: " value
    echo "$value"
  fi
}

echo "=== Sentinel SSM Parameter Seeder ==="
echo "Region: $REGION"
echo "Prefix: $PREFIX"
echo ""

# ── Required parameters ──────────────────────────────────────────────

DATABASE_URL=$(prompt_or_default "DATABASE_URL" "PostgreSQL connection string" "postgresql://sentinel:PASSWORD@localhost:5432/sentinel")
put_param "DATABASE_URL" "$DATABASE_URL" "PostgreSQL connection string"

if [ "$GENERATE" = true ]; then
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
  echo "  Generated SESSION_SECRET"
else
  SESSION_SECRET=$(prompt_or_default "SESSION_SECRET" "Session secret (min 32 chars)")
fi
put_param "SESSION_SECRET" "$SESSION_SECRET" "Session signing secret"

if [ "$GENERATE" = true ]; then
  ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  echo "  Generated ENCRYPTION_KEY"
else
  ENCRYPTION_KEY=$(prompt_or_default "ENCRYPTION_KEY" "Encryption key (64 hex chars)")
fi
put_param "ENCRYPTION_KEY" "$ENCRYPTION_KEY" "AES-256-GCM encryption key"

ALLOWED_ORIGINS=$(prompt_or_default "ALLOWED_ORIGINS" "Allowed CORS origins" "https://sentinel.example.com")
put_param "ALLOWED_ORIGINS" "$ALLOWED_ORIGINS" "Comma-separated CORS origins"

# ── Optional parameters ──────────────────────────────────────────────

echo ""
echo "Optional parameters (press Enter to skip):"
echo ""

SLACK_CLIENT_ID=$(prompt_or_default "SLACK_CLIENT_ID" "Slack Client ID")
put_param "SLACK_CLIENT_ID" "$SLACK_CLIENT_ID" "Slack OAuth client ID"

SLACK_CLIENT_SECRET=$(prompt_or_default "SLACK_CLIENT_SECRET" "Slack Client Secret")
put_param "SLACK_CLIENT_SECRET" "$SLACK_CLIENT_SECRET" "Slack OAuth client secret"

GITHUB_APP_ID=$(prompt_or_default "GITHUB_APP_ID" "GitHub App ID")
put_param "GITHUB_APP_ID" "$GITHUB_APP_ID" "GitHub App ID"

GITHUB_APP_PRIVATE_KEY=$(prompt_or_default "GITHUB_APP_PRIVATE_KEY" "GitHub App Private Key (PEM, single line)")
put_param "GITHUB_APP_PRIVATE_KEY" "$GITHUB_APP_PRIVATE_KEY" "GitHub App private key for JWT signing"

GITHUB_APP_WEBHOOK_SECRET=$(prompt_or_default "GITHUB_APP_WEBHOOK_SECRET" "GitHub App Webhook Secret")
put_param "GITHUB_APP_WEBHOOK_SECRET" "$GITHUB_APP_WEBHOOK_SECRET" "GitHub webhook HMAC secret"

GITHUB_APP_CLIENT_ID=$(prompt_or_default "GITHUB_APP_CLIENT_ID" "GitHub App Client ID")
put_param "GITHUB_APP_CLIENT_ID" "$GITHUB_APP_CLIENT_ID" "GitHub App OAuth client ID"

GITHUB_APP_CLIENT_SECRET=$(prompt_or_default "GITHUB_APP_CLIENT_SECRET" "GitHub App Client Secret")
put_param "GITHUB_APP_CLIENT_SECRET" "$GITHUB_APP_CLIENT_SECRET" "GitHub App OAuth client secret"

SMTP_URL=$(prompt_or_default "SMTP_URL" "SMTP connection URL")
put_param "SMTP_URL" "$SMTP_URL" "SMTP server URL"

SMTP_FROM=$(prompt_or_default "SMTP_FROM" "SMTP from address" "alerts@sentinel.dev")
put_param "SMTP_FROM" "$SMTP_FROM" "Email sender address"

echo ""
echo "=== Done! ==="
echo ""
echo "Verify with:"
echo "  aws ssm get-parameters-by-path --path $PREFIX --with-decryption --region $REGION --query 'Parameters[].Name' --output table"
