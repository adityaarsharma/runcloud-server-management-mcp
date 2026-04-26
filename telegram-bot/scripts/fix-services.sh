#!/usr/bin/env bash
# Perch — Restart all custom services (nginx, PHP-FPM, MySQL, Redis)
set -uo pipefail

NSVC=$(systemctl list-units --all 2>/dev/null | grep -q 'nginx-rc' && echo nginx-rc || echo nginx)
RESTARTED=()
FAILED=()

restart_if_active() {
  local svc="$1"
  if systemctl list-units --all 2>/dev/null | grep -q " ${svc}\."; then
    systemctl restart "$svc" 2>/dev/null && RESTARTED+=("$svc") || FAILED+=("$svc")
  fi
}

echo "=== Restarting Services ==="
restart_if_active "$NSVC"
restart_if_active "mysql"
restart_if_active "mariadb"
restart_if_active "redis"
restart_if_active "memcached"

# PHP-FPM (all versions)
for phpfpm in /lib/systemd/system/php*-fpm.service; do
  svc=$(basename "$phpfpm" .service)
  restart_if_active "$svc"
done

sleep 2

echo ""
[ ${#RESTARTED[@]} -gt 0 ] && echo "✅ Restarted: ${RESTARTED[*]}"
[ ${#FAILED[@]} -gt 0 ]    && echo "⚠️  Failed: ${FAILED[*]}"

echo ""
echo "--- Final Status ---"
for svc in "$NSVC" mysql mariadb redis; do
  STATUS=$(systemctl is-active "$svc" 2>/dev/null) && echo "$svc: $STATUS" || true
done
