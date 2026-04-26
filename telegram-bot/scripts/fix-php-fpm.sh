#!/usr/bin/env bash
# Perch — Restart any failed PHP-FPM service (RunCloud-aware: php{ver}-fpm-rc)
set -uo pipefail

echo "=== PHP-FPM Restart ==="

DOWN=()
RESTARTED=()
ALL=()

while IFS= read -r unit; do
  [ -z "$unit" ] && continue
  ALL+=("$unit")
  status="$(systemctl is-active "$unit" 2>/dev/null)"
  if [ "$status" != "active" ]; then
    DOWN+=("$unit:$status")
    if systemctl restart "$unit" 2>/dev/null; then
      sleep 1
      new_status="$(systemctl is-active "$unit" 2>/dev/null)"
      if [ "$new_status" = "active" ]; then
        RESTARTED+=("$unit")
      else
        echo "⚠  $unit still $new_status after restart — check journalctl -u $unit -n 50"
      fi
    fi
  fi
done < <(systemctl list-units --all --plain --no-legend 2>/dev/null \
          | awk '/php[0-9]+-fpm(-rc)?\.service/{print $1}')

if [ ${#ALL[@]} -eq 0 ]; then
  echo "ℹ  No PHP-FPM services found on this system."
  exit 0
fi

echo "Found PHP-FPM units: ${ALL[*]}"
echo ""

if [ ${#DOWN[@]} -eq 0 ]; then
  echo "✅ All PHP-FPM services are active."
else
  echo "Was down: ${DOWN[*]}"
  if [ ${#RESTARTED[@]} -gt 0 ]; then
    echo "✅ Restarted: ${RESTARTED[*]}"
  fi
fi

# Show current PHP error log lines for context
LOG=""
for candidate in /var/log/php*-fpm*.log /home/*/logs/php_error*.log; do
  [ -f "$candidate" ] && LOG="$candidate" && break
done
if [ -n "$LOG" ]; then
  echo ""
  echo "Recent PHP-FPM errors ($LOG):"
  tail -8 "$LOG" 2>/dev/null | sed 's/^/  /' || true
fi
