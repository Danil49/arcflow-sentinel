#!/usr/bin/env sh
# Nightly Postgres backup for a compose deployment. Usage (from the repo directory):
#   ./deploy/backup.sh [backup-dir] [days-to-keep]
# Cron example (02:17 every night):
#   17 2 * * * cd /opt/arcflow-sentinel && ./deploy/backup.sh /var/backups/arcflow-sentinel 14 >> /var/log/arcflow-backup.log 2>&1
set -eu

DIR="${1:-./backups}"
KEEP_DAYS="${2:-14}"
COMPOSE="${COMPOSE:-docker compose -f compose.yaml -f compose.prod.yaml}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DIR/sentinel-$STAMP.sql.gz"

mkdir -p "$DIR"
umask 077
# Plain SQL dump: restorable with psql into any Postgres >= 17.
$COMPOSE exec -T postgres pg_dump -U sentinel --no-owner --clean --if-exists sentinel | gzip -9 > "$FILE.partial"
mv "$FILE.partial" "$FILE"
find "$DIR" -name 'sentinel-*.sql.gz' -type f -mtime "+$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
