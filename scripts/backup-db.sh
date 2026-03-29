#!/usr/bin/env bash
# ── Postgres Backup (host-side) ─────────────────────────────────────────────
# Dumps via DATABASE_URL (preferred) or docker exec fallback, compresses,
# optionally uploads to S3, and cleans old backups.
#
# Usage:
#   ./scripts/backup-db.sh                    # manual run
#   # crontab -e:
#   # 0 2 * * * /path/to/scripts/backup-db.sh >> /var/log/sentinel-backup.log 2>&1
#
# Config (env vars or edit defaults below):
#   DATABASE_URL      PostgreSQL connection URL (preferred)
#   CONTAINER         Docker container name (fallback mode only)
#   DB_USER           Postgres user (default: sentinel)
#   DB_NAME           Database name (default: sentinel)
#   BACKUP_DIR        Local backup dir (default: /backups/postgres)
#   BACKUP_S3_BUCKET  S3 bucket (optional, e.g. s3://my-bucket/sentinel)
#   LOCAL_RETENTION   Days to keep local backups (default: 7)
#   S3_RETENTION      Days to keep S3 backups (default: 30)
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CONTAINER="${CONTAINER:-chainalert-postgres-1}"
DB_USER="${DB_USER:-sentinel}"
DB_NAME="${DB_NAME:-sentinel}"
BACKUP_DIR="${BACKUP_DIR:-/backups/postgres}"
LOCAL_RETENTION="${LOCAL_RETENTION:-7}"
S3_RETENTION="${S3_RETENTION:-30}"

TIMESTAMP="$(date -u +%Y-%m-%d-%H%M%S)"
FILENAME="${DB_NAME}-backup-${TIMESTAMP}.sql.gz"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
die() { log "ERROR: $*"; exit 1; }

# ── Preflight ───────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR" || die "Cannot create $BACKUP_DIR"

MODE="container"
if [ -n "${DATABASE_URL:-}" ]; then
  MODE="url"
  log "Using DATABASE_URL (direct connection)"
else
  log "Using docker exec fallback (container: ${CONTAINER})"
fi

if [ "$MODE" = "container" ]; then
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "Container '$CONTAINER' not found — set DATABASE_URL or CONTAINER env var"
fi

# ── Dump ────────────────────────────────────────────────────────────────────
if [ "$MODE" = "url" ]; then
  log "Backing up database from DATABASE_URL..."
  pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip > "$FILEPATH"
else
  log "Backing up ${DB_NAME} from ${CONTAINER}..."
  docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges | gzip > "$FILEPATH"
fi

if [ ! -s "$FILEPATH" ]; then
  rm -f "$FILEPATH"
  die "Dump produced empty file"
fi

log "Saved: ${FILENAME} ($(du -h "$FILEPATH" | cut -f1))"

# ── S3 upload (optional) ───────────────────────────────────────────────────
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  log "Uploading to ${BACKUP_S3_BUCKET%/}/${FILENAME}..."
  aws s3 cp "$FILEPATH" "${BACKUP_S3_BUCKET%/}/${FILENAME}" --only-show-errors \
    && log "S3 upload done" \
    || log "WARNING: S3 upload failed (local copy preserved)"
fi

# ── Cleanup old local backups ──────────────────────────────────────────────
find "$BACKUP_DIR" -name "${DB_NAME}-backup-*.sql.gz" -type f -mtime "+${LOCAL_RETENTION}" -delete -print \
  | while read -r f; do log "Removed: $(basename "$f")"; done

# ── Cleanup old S3 backups ─────────────────────────────────────────────────
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  CUTOFF="$(date -u -d "-${S3_RETENTION} days" +%Y-%m-%d 2>/dev/null || date -u -v-${S3_RETENTION}d +%Y-%m-%d)"
  aws s3 ls "${BACKUP_S3_BUCKET%/}/" 2>/dev/null | while read -r line; do
    file="$(echo "$line" | awk '{print $4}')"
    fdate="$(echo "$line" | awk '{print $1}')"
    case "$file" in
      ${DB_NAME}-backup-*.sql.gz)
        [[ "$fdate" < "$CUTOFF" ]] && aws s3 rm "${BACKUP_S3_BUCKET%/}/${file}" --only-show-errors && log "S3 removed: $file"
        ;;
    esac
  done
fi

log "Done. $(find "$BACKUP_DIR" -name "${DB_NAME}-backup-*.sql.gz" | wc -l | tr -d ' ') local backup(s)."
