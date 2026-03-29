#!/usr/bin/env bash
# ── Postgres Restore (host-side) ────────────────────────────────────────────
# Restores a backup created by backup-db.sh using DATABASE_URL (preferred)
# or docker exec fallback.
#
# Usage:
#   ./scripts/restore-db.sh /backups/postgres/sentinel-backup-2026-03-28-020000.sql.gz
#
# Config (env vars or edit defaults below):
#   DATABASE_URL PostgreSQL connection URL (preferred)
#   CONTAINER   Docker container name (fallback mode only)
#   DB_USER     Postgres user (default: sentinel)
#   DB_NAME     Database name (default: sentinel)
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CONTAINER="${CONTAINER:-chainalert-postgres-1}"
DB_USER="${DB_USER:-sentinel}"
DB_NAME="${DB_NAME:-sentinel}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
die() { log "ERROR: $*"; exit 1; }

BACKUP_FILE="${1:-}"
[ -z "$BACKUP_FILE" ] && die "Usage: $0 <backup-file.sql.gz>"
[ ! -f "$BACKUP_FILE" ] && die "File not found: $BACKUP_FILE"

echo ""
if [ -n "${DATABASE_URL:-}" ]; then
  echo "  WARNING: This will DROP and RECREATE schema 'public' in the DATABASE_URL target."
else
  echo "  WARNING: This will DROP and RECREATE '${DB_NAME}' on container '${CONTAINER}'."
fi
echo "  Backup: ${BACKUP_FILE}"
echo ""
read -rp "  Type 'yes' to continue: " CONFIRM
[ "$CONFIRM" != "yes" ] && die "Cancelled"

if [ -n "${DATABASE_URL:-}" ]; then
  log "Resetting public schema via DATABASE_URL..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"

  log "Restoring from $(basename "$BACKUP_FILE")..."
  gunzip -c "$BACKUP_FILE" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q

  TABLE_COUNT=$(psql "$DATABASE_URL" -t -A -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")
else
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "Container '$CONTAINER' not found"

  log "Terminating connections..."
  docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" \
    >/dev/null 2>&1 || true

  log "Dropping and recreating ${DB_NAME}..."
  docker exec "$CONTAINER" dropdb -U "$DB_USER" --if-exists "$DB_NAME"
  docker exec "$CONTAINER" createdb -U "$DB_USER" -O "$DB_USER" "$DB_NAME"

  log "Restoring from $(basename "$BACKUP_FILE")..."
  gunzip -c "$BACKUP_FILE" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" --quiet

  TABLE_COUNT=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")
fi

if [ "$TABLE_COUNT" -gt 0 ] 2>/dev/null; then
  log "Verified: ${TABLE_COUNT} tables restored."
else
  die "Verification failed: no tables found"
fi

log "Restore complete!"
