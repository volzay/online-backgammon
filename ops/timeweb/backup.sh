#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/online-backgammon}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/online-backgammon-$timestamp.dump"

install -d -m 700 "$BACKUP_DIR"
umask 077

docker exec supabase-db pg_dump -U postgres -d postgres -Fc > "$target"
gzip -9 "$target"
find "$BACKUP_DIR" -type f -name 'online-backgammon-*.dump.gz' -mtime "+$RETENTION_DAYS" -delete

printf 'Backup created: %s.gz\n' "$target"
