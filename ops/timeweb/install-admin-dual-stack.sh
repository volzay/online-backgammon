#!/bin/sh
set -eu

# Run as root AFTER copying admin-dual-stack.caddy into the mounted Caddy
# directory as Caddyfile.admin-dual-stack.pending. No service restart, auth
# secret, database write or change to the existing portal hostname is needed.
task_target=/opt/online-backgammon-supabase/volumes/proxy/caddy/Caddyfile
task_pending=/opt/online-backgammon-supabase/volumes/proxy/caddy/Caddyfile.admin-dual-stack.pending
task_backup=/var/backups/online-backgammon/Caddyfile-before-admin-dual-stack-20261019

test "$(id -u)" = 0
test -f "$task_target" && test ! -L "$task_target"
test -f "$task_pending" && test ! -L "$task_pending"
if test -e "$task_backup"; then
  echo 'Original backup already exists; inspect it before reapplying.' >&2
  exit 1
fi
docker exec supabase-caddy caddy validate --config /etc/caddy/Caddyfile.admin-dual-stack.pending --adapter caddyfile
install -m 600 "$task_target" "$task_backup"
cmp "$task_target" "$task_backup"
install -m 644 "$task_pending" "$task_target"
if docker exec supabase-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
  echo 'Dual-stack admin alias installed; original portal hostname retained.'
else
  install -m 644 "$task_backup" "$task_target"
  docker exec supabase-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  echo 'Reload failed; restored original Caddy configuration.' >&2
  exit 1
fi
