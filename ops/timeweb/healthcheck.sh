#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/online-backgammon-supabase}"
PUBLIC_URL="${PUBLIC_URL:-https://api.201-51-7-193.sslip.io}"

cd "$PROJECT_DIR"

unhealthy="$(docker compose ps --format json | jq -r 'select(.Health != "" and .Health != "healthy") | .Name + ":" + .Health')"
if [[ -n "$unhealthy" ]]; then
  printf 'Unhealthy containers:\n%s\n' "$unhealthy" >&2
  exit 1
fi

status="$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_URL/auth/v1/")"
if [[ "$status" != "401" ]]; then
  printf 'Unexpected Auth status: %s\n' "$status" >&2
  exit 1
fi

printf 'Backend healthy: %s\n' "$PUBLIC_URL"
