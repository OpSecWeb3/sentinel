#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/sentinel"
COMPOSE_FILE="docker-compose.prod.yml"
API_PORT=4100
WEB_PORT=3100
MAX_RETRIES=30
RETRY_INTERVAL=2

cd "$APP_DIR"

ENV_PERMS=$(stat -c '%a' .env 2>/dev/null || echo "000")
if [ "$ENV_PERMS" != "600" ]; then
  echo "ERROR: .env has permissions $ENV_PERMS (expected 600). Run: chmod 600 .env"
  exit 1
fi

# ── Capture current state for rollback ──────────────────────────────────────
PREV_SHA=$(git rev-parse HEAD)
echo "==> Current commit: ${PREV_SHA:0:12}"

echo "==> Pulling latest code..."
git pull origin main

NEW_SHA=$(git rev-parse HEAD)
echo "==> New commit: ${NEW_SHA:0:12}"

# Check if this deploy includes migrations
HAS_MIGRATIONS=false
if [ "$PREV_SHA" != "$NEW_SHA" ]; then
  if git diff --name-only "$PREV_SHA" "$NEW_SHA" | grep -q '^packages/db/migrations/'; then
    HAS_MIGRATIONS=true
    echo "==> WARNING: This deploy includes database migrations (auto-rollback disabled)"
  fi
fi

# ── Rollback function ──────────────────────────────────────────────────────
rollback() {
  echo ""
  echo "==> DEPLOY FAILED — initiating rollback"

  if [ "$HAS_MIGRATIONS" = true ]; then
    echo "    This deploy included migrations — cannot auto-rollback."
    echo "    Manual intervention required:"
    echo "      1. Check migration state: psql \$DATABASE_URL -c 'SELECT * FROM drizzle.migrations ORDER BY created_at DESC LIMIT 5;'"
    echo "      2. If migration succeeded but app failed, fix the app code"
    echo "      3. If migration failed, restore from backup: ./scripts/restore-db.sh /backups/postgres/<latest>"
    echo "      4. To revert code: git checkout ${PREV_SHA} && bash scripts/deploy.sh"
    docker compose -f "$COMPOSE_FILE" logs --tail=50
    exit 1
  fi

  echo "    Rolling back to ${PREV_SHA:0:12}..."
  git checkout "$PREV_SHA"

  echo "    Rebuilding previous version..."
  docker compose -f "$COMPOSE_FILE" build
  docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

  echo "    Waiting for health check..."
  for i in $(seq 1 $MAX_RETRIES); do
    if wget -q --spider "http://localhost:${API_PORT}/health" 2>/dev/null; then
      echo "    Rollback healthy (attempt $i)"
      echo ""
      echo "==> ROLLED BACK to ${PREV_SHA:0:12}. Deploy of ${NEW_SHA:0:12} failed."
      exit 1
    fi
    sleep "$RETRY_INTERVAL"
  done

  echo "    ERROR: Rollback also failed. Manual intervention required."
  docker compose -f "$COMPOSE_FILE" logs --tail=50
  exit 1
}

echo "==> Ensuring Docker networks exist..."
docker network create gateway 2>/dev/null || true
docker network create shared-infra 2>/dev/null || true

echo "==> Installing dependencies (ensures host deps match lockfile)..."
pnpm install --frozen-lockfile

echo "==> Building containers..."
docker compose -f "$COMPOSE_FILE" build

echo "==> Running database migrations..."
set -a; source .env; set +a
npx drizzle-kit migrate --config packages/db/drizzle.config.ts

echo "==> Seeding database..."
npx tsx packages/db/src/seed.ts

echo "==> Starting containers..."
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

echo "==> Waiting for API health check..."
for i in $(seq 1 $MAX_RETRIES); do
  if wget -q --spider "http://localhost:${API_PORT}/health" 2>/dev/null; then
    echo "    API is healthy (attempt $i)"
    break
  fi
  if [ "$i" -eq "$MAX_RETRIES" ]; then
    echo "    ERROR: API failed health check after ${MAX_RETRIES} attempts"
    docker compose -f "$COMPOSE_FILE" logs --tail=50 api
    rollback
  fi
  sleep "$RETRY_INTERVAL"
done

echo "==> Waiting for Web health check..."
for i in $(seq 1 $MAX_RETRIES); do
  if wget -q --spider "http://localhost:${WEB_PORT}/" 2>/dev/null; then
    echo "    Web is healthy (attempt $i)"
    break
  fi
  if [ "$i" -eq "$MAX_RETRIES" ]; then
    echo "    ERROR: Web failed health check after ${MAX_RETRIES} attempts"
    docker compose -f "$COMPOSE_FILE" logs --tail=50 web
    rollback
  fi
  sleep "$RETRY_INTERVAL"
done

echo "==> Reloading Nginx gateway..."
docker exec gateway nginx -s reload || echo "    WARNING: Gateway reload failed (may not be running)"

echo "==> Deploy complete!"
docker compose -f "$COMPOSE_FILE" ps
