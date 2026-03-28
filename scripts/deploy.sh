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

echo "==> Pulling latest code..."
git pull origin main

echo "==> Ensuring Docker networks exist..."
docker network create gateway 2>/dev/null || true
docker network create shared-infra 2>/dev/null || true

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
    exit 1
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
    exit 1
  fi
  sleep "$RETRY_INTERVAL"
done

echo "==> Reloading Nginx gateway..."
docker exec gateway nginx -s reload || echo "    WARNING: Gateway reload failed (may not be running)"

echo "==> Deploy complete!"
docker compose -f "$COMPOSE_FILE" ps
