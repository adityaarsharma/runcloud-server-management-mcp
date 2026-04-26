#!/usr/bin/env bash
# Perch — Tail PHP error logs (across versions + WP debug.log)
set -uo pipefail

echo "=== Recent PHP errors ==="

FOUND=0
for path in /var/log/php*-fpm*.log /home/*/logs/php_error*.log /home/*/webapps/*/wp-content/debug.log; do
  [ -f "$path" ] || continue
  FOUND=$((FOUND + 1))
  echo ""
  echo "--- $path ---"
  tail -15 "$path" 2>/dev/null | sed 's/^/  /'
done

if [ "$FOUND" -eq 0 ]; then
  echo "ℹ  No PHP error logs found."
  echo "   For WordPress sites, enable WP_DEBUG_LOG in wp-config.php to capture errors."
  exit 0
fi

echo ""
echo "=== Most common error types (last 500 lines, all logs) ==="
for path in /var/log/php*-fpm*.log /home/*/logs/php_error*.log /home/*/webapps/*/wp-content/debug.log; do
  [ -f "$path" ] || continue
  tail -500 "$path" 2>/dev/null
done | grep -oE 'PHP (Fatal error|Parse error|Warning|Notice|Deprecated)[^:]*:[^:]*' \
     | sort | uniq -c | sort -rn | head -8 | sed 's/^/  /'
