#!/usr/bin/env bash
set -euo pipefail

# Seeds AWS SSM Parameter Store with Sentinel production secrets.
# Run once before first deploy. Requires AWS CLI configured with write access.
#
# Usage:
#   bash scripts/seed-ssm.sh                            # skip params that already exist
#   bash scripts/seed-ssm.sh --generate                 # auto-generate SESSION_SECRET & ENCRYPTION_KEY
#   bash scripts/seed-ssm.sh --update                   # re-prompt all params, including existing ones
#   bash scripts/seed-ssm.sh --generate --update        # generate + overwrite existing

REGION="${AWS_REGION:-eu-west-2}"
PREFIX="/sentinel/production"
GENERATE=false
UPDATE=false

for arg in "$@"; do
  case "$arg" in
    --generate) GENERATE=true ;;
    --update)   UPDATE=true ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────

param_exists() {
  aws ssm get-parameter \
    --region "$REGION" \
    --name "${PREFIX}/${1}" \
    --query 'Parameter.Name' \
    --output text 2>/dev/null | grep -q . && return 0 || return 1
}

get_param() {
  aws ssm get-parameter \
    --region "$REGION" \
    --name "${PREFIX}/${1}" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text 2>/dev/null || echo ""
}

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

# Checks if a param already exists and handles the skip/update logic.
# If the param exists and --update was not passed, prints a skip message and returns 1.
# If the param exists and --update was passed, sets CURRENT_VALUE so the caller
# can use it as a prompt default. Returns 0 to signal the caller should proceed.
# If the param does not exist, clears CURRENT_VALUE and returns 0.
CURRENT_VALUE=""
should_handle() {
  local name="$1"
  CURRENT_VALUE=""
  if param_exists "$name"; then
    if [ "$UPDATE" = false ]; then
      echo "  SKIP: ${PREFIX}/${name} (already set — use --update to overwrite)"
      return 1
    fi
    CURRENT_VALUE=$(get_param "$name")
  fi
  return 0
}

prompt_param() {
  local prompt_text="$1"
  local default="${2:-}"

  if [ -n "$default" ]; then
    read -rp "${prompt_text} [${default}]: " value
    echo "${value:-$default}"
  else
    read -rp "${prompt_text}: " value
    echo "$value"
  fi
}

# Full lifecycle: exist-check → prompt → write.
# Args: name prompt_text description [static_default]
handle_param() {
  local name="$1"
  local prompt_text="$2"
  local description="$3"
  local static_default="${4:-}"

  should_handle "$name" || return 0

  # Prefer the current SSM value as default (set by should_handle when --update);
  # fall back to the static default passed by the caller.
  local default="${CURRENT_VALUE:-$static_default}"
  local value
  value=$(prompt_param "$prompt_text" "$default")
  put_param "$name" "$value" "$description"
}

echo "=== Sentinel SSM Parameter Seeder ==="
echo "Region:  $REGION"
echo "Prefix:  $PREFIX"
echo "Update:  $UPDATE"
echo "Generate: $GENERATE"
echo ""

# ── Required parameters ───────────────────────────────────────────────

handle_param "DATABASE_URL" \
  "PostgreSQL connection string" \
  "PostgreSQL connection string" \
  "postgresql://sentinel:PASSWORD@localhost:5432/sentinel"

# SESSION_SECRET: auto-generate if --generate, but only when the param is absent
# or --update was explicitly passed. Never silently overwrite an existing key.
if should_handle "SESSION_SECRET"; then
  if [ "$GENERATE" = true ] && [ -z "$CURRENT_VALUE" ]; then
    SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
    echo "  Generated SESSION_SECRET"
  else
    SESSION_SECRET=$(prompt_param "Session secret (min 32 chars)" "$CURRENT_VALUE")
  fi
  put_param "SESSION_SECRET" "$SESSION_SECRET" "Session signing secret"
fi

# ENCRYPTION_KEY: same — generate only when absent. Rotating an existing key on a
# live system requires going through the key rotation procedure (ENCRYPTION_KEY_PREV),
# not re-running this script with --generate.
if should_handle "ENCRYPTION_KEY"; then
  if [ "$GENERATE" = true ] && [ -z "$CURRENT_VALUE" ]; then
    ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    echo "  Generated ENCRYPTION_KEY"
  else
    ENCRYPTION_KEY=$(prompt_param "Encryption key (64 hex chars)" "$CURRENT_VALUE")
  fi
  put_param "ENCRYPTION_KEY" "$ENCRYPTION_KEY" "AES-256-GCM encryption key"
fi

handle_param "ENCRYPTION_KEY_PREV" \
  "Previous encryption key for rotation (64 hex chars, skip if not rotating)" \
  "Previous AES-256-GCM key (decrypt-only, used during key rotation)"

handle_param "ALLOWED_ORIGINS" \
  "Allowed CORS origins" \
  "Comma-separated CORS origins" \
  "https://sentinel.example.com"

handle_param "NEXT_PUBLIC_API_URL" \
  "Public API URL (baked into web bundle at build time)" \
  "Public API URL for Next.js frontend (build-time)" \
  "https://api.sentinel.example.com"

# ── Optional parameters ───────────────────────────────────────────────

echo ""
echo "Optional parameters (press Enter to skip):"
echo ""

handle_param "SLACK_CLIENT_ID"     "Slack Client ID"                                   "Slack OAuth client ID"
handle_param "SLACK_CLIENT_SECRET" "Slack Client Secret"                               "Slack OAuth client secret"
handle_param "GITHUB_APP_ID"       "GitHub App ID"                                     "GitHub App ID"
handle_param "GITHUB_APP_PRIVATE_KEY" "GitHub App Private Key (PEM, single line)"      "GitHub App private key for JWT signing"
handle_param "GITHUB_APP_WEBHOOK_SECRET" "GitHub App Webhook Secret"                   "GitHub webhook HMAC secret"
handle_param "GITHUB_APP_CLIENT_ID"    "GitHub App Client ID"                          "GitHub App OAuth client ID"
handle_param "GITHUB_APP_CLIENT_SECRET" "GitHub App Client Secret"                     "GitHub App OAuth client secret"
handle_param "GITHUB_APP_SLUG"     "GitHub App slug (name)"                            "GitHub App slug for URL construction"
handle_param "GITHUB_TOKEN"        "GitHub personal access token (registry)"           "GitHub PAT for registry package/image lookups"
handle_param "SMTP_URL"            "SMTP connection URL"                                "SMTP server URL"
handle_param "SMTP_FROM"           "SMTP from address"                                  "Email sender address" "alerts@sentinel.dev"
handle_param "SENTRY_DSN"          "Sentry DSN (error tracking)"                       "Sentry DSN for error tracking"
handle_param "SENTRY_ENVIRONMENT"  "Sentry environment"                                 "Sentry environment name" "production"
handle_param "ETHERSCAN_API_KEY"   "Etherscan API key (chain module)"                  "Etherscan API key for blockchain data"
handle_param "RPC_ETHEREUM"        "Ethereum RPC URL(s), comma-separated (skip to use public fallbacks)" \
  "Ethereum Mainnet RPC URL(s), comma-separated — overrides seeded public fallbacks"

echo ""
echo "=== Done! ==="
echo ""
echo "NOTE: REDIS_PASSWORD lives at /shared/production/REDIS_PASSWORD (shared infra path)."
echo "Seed it separately if not already set:"
echo "  aws ssm put-parameter --region $REGION --name /shared/production/REDIS_PASSWORD --type SecureString --value '<password>' --overwrite"
echo ""
echo "Verify with:"
echo "  aws ssm get-parameters-by-path --path $PREFIX --with-decryption --region $REGION --query 'Parameters[].Name' --output table"
