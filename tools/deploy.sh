#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
umask 077
if [[ -e .env ]]; then
  printf '%s\n' 'An existing .env was preserved. Edit it directly to change settings.' >&2
  exit 1
fi
task_encryption_key=$(openssl rand -hex 16)
task_jwt_secret=$(openssl rand -hex 32)
task_postgres_password=$(openssl rand -hex 24)
task_env_temp=$(mktemp .env.tmp.XXXXXX)
trap 'rm -f "$task_env_temp"' EXIT
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    AP_ENCRYPTION_KEY=*) printf 'AP_ENCRYPTION_KEY=%s\n' "$task_encryption_key" ;;
    AP_JWT_SECRET=*) printf 'AP_JWT_SECRET=%s\n' "$task_jwt_secret" ;;
    AP_POSTGRES_PASSWORD=*) printf 'AP_POSTGRES_PASSWORD=%s\n' "$task_postgres_password" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < .env.example > "$task_env_temp"
ln "$task_env_temp" .env
printf '%s\n' 'Created private .env with generated secrets. Review AP_FRONTEND_URL, then run docker compose up -d --wait.'
