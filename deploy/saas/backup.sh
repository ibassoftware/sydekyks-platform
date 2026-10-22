#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/sydekyks
snapshot=$(mktemp -d /opt/sydekyks/backups/.staging-XXXXXXXX)
trap 'rm -rf "$snapshot"' EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose --env-file production.env exec -T postgres pg_dump -Fc -U sydekyks -d sydekyks > "$snapshot/database.pgdump"
docker compose --env-file production.env exec -T redis redis-cli --rdb /tmp/sydekyks-backup.rdb >/dev/null
docker cp sydekyks-saas-redis-1:/tmp/sydekyks-backup.rdb "$snapshot/redis.rdb" >/dev/null
docker compose --env-file production.env exec -T redis rm -f /tmp/sydekyks-backup.rdb
cp production.env compose.yaml "$snapshot/"
cp /etc/caddy/Caddyfile "$snapshot/Caddyfile"
if [ -f private/production-admin.json ]; then cp private/production-admin.json "$snapshot/production-admin.json"; fi
docker inspect sydekyks-saas-app-1 --format '{{.Image}}' > "$snapshot/image-id.txt"
(cd "$snapshot" && sha256sum database.pgdump redis.rdb production.env compose.yaml Caddyfile image-id.txt > SHA256SUMS)
recipient=$(cat /opt/sydekyks/backup-recipient.txt)
target="/opt/sydekyks/backups/sydekyks-$stamp.tar.gz.age"
tar -C "$snapshot" -czf - . | age -r "$recipient" -o "$target.partial"
mv "$target.partial" "$target"
chmod 600 "$target"
find /opt/sydekyks/backups -maxdepth 1 -type f -name 'sydekyks-*.tar.gz.age' -mtime +14 -delete
printf '%s\n' "$target"
