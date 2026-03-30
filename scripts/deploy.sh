#!/usr/bin/env bash
# Production deploy: run after the repo is updated (git pull is done by CI, not here).
# CI exports DEPLOY_PREV_SHA = commit before pull (for rollback / migration detection).
# Manual: PREV=$(git rev-parse HEAD) && git pull origin main && DEPLOY_PREV_SHA=$PREV bash scripts/deploy.sh
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
NEW_SHA=$(git rev-parse HEAD)
echo "==> Deploying commit: ${NEW_SHA:0:12}"

if [ -n "${DEPLOY_PREV_SHA:-}" ]; then
  PREV_SHA="$DEPLOY_PREV_SHA"
  echo "==> Pre-update commit: ${PREV_SHA:0:12}"
else
  PREV_SHA=$(git rev-parse ORIG_HEAD 2>/dev/null || true)
  if [ -z "$PREV_SHA" ] || [ "$PREV_SHA" = "$NEW_SHA" ]; then
    PREV_SHA="$NEW_SHA"
    echo "==> WARN: DEPLOY_PREV_SHA unset (set by CI after pull). Manual: PREV=\$(git rev-parse HEAD); git pull; DEPLOY_PREV_SHA=\$PREV bash scripts/deploy.sh"
  else
    echo "==> Pre-update commit (ORIG_HEAD): ${PREV_SHA:0:12}"
  fi
fi

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
  trap - ERR  # prevent re-entry if a command inside rollback fails
  echo ""
  echo "==> DEPLOY FAILED — initiating rollback"

  if [ "$HAS_MIGRATIONS" = true ]; then
    echo "    This deploy included migrations — cannot auto-rollback."
    echo "    Manual intervention required:"
    echo "      1. Check migration state: psql \$DATABASE_URL -c 'SELECT * FROM drizzle.migrations ORDER BY created_at DESC LIMIT 5;'"
    echo "      2. If migration succeeded but app failed, fix the app code"
    echo "      3. If migration failed, restore from backup: ./scripts/restore-db.sh ${APP_DIR}/backups/sentinel-pre-migration.sql.gz"
    echo "      4. To revert code: git checkout ${PREV_SHA} && DEPLOY_PREV_SHA=\$(git rev-parse HEAD) bash scripts/deploy.sh"
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

trap 'rollback' ERR

echo "==> Ensuring Docker networks exist..."
docker network create gateway 2>/dev/null || true
docker network create shared-infra 2>/dev/null || true

echo "==> Building containers..."
# Include profile so the one-shot migrate image is built alongside api/worker/web.
docker compose -f "$COMPOSE_FILE" --profile migrate build

echo "==> Running database migrations and seed (migrate container)..."
set -a; source .env; set +a

# Back up the database before applying migrations so we can restore on failure.
# Skipped when there are no pending migration files to avoid slowing every deploy.
if [ "$HAS_MIGRATIONS" = true ]; then
  echo "==> Taking pre-migration database backup..."
  BACKUP_DIR="${APP_DIR}/backups" BACKUP_SINGLE=true bash ./scripts/backup-db.sh || { echo "ERROR: Pre-migration backup failed — aborting deploy"; exit 1; }
fi

docker compose -f "$COMPOSE_FILE" --profile migrate run --rm --no-deps migrate

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
