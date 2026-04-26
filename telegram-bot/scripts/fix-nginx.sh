#!/usr/bin/env bash
# Perch — Diagnose and restart nginx / nginx-rc with root cause analysis
set -uo pipefail

NSVC=$(systemctl list-units --all 2>/dev/null | grep -q 'nginx-rc' && echo nginx-rc || echo nginx)
STATUS=$(systemctl is-active "$NSVC" 2>/dev/null || echo inactive)

echo "=== Nginx Diagnosis ==="
echo "Service: ${NSVC} (${STATUS})"
echo ""

# Config test
CONFIG_TEST=$(nginx -t 2>&1)
if echo "$CONFIG_TEST" | grep -q "successful"; then
  echo "✅ Config: OK"
  CONFIG_OK=true
else
  echo "❌ Config has errors:"
  echo "$CONFIG_TEST" | grep -v "^$" | head -10
  CONFIG_OK=false
  # Try to identify which file
  BAD_FILE=$(echo "$CONFIG_TEST" | grep "open failed\|in /etc/nginx" | head -3)
  [ -n "$BAD_FILE" ] && echo "" && echo "Problem file(s):" && echo "$BAD_FILE"
fi

# Last error log lines
echo ""
echo "--- Recent errors ---"
if [ -f /var/log/nginx/error.log ]; then
  tail -20 /var/log/nginx/error.log | grep -i "error\|crit\|emerg" | tail -10 || echo "(no recent errors)"
elif [ -f /var/log/nginx-rc/error.log ]; then
  tail -20 /var/log/nginx-rc/error.log | grep -i "error\|crit\|emerg" | tail -10 || echo "(no recent errors)"
else
  echo "(log file not found)"
fi

echo ""
if $CONFIG_OK; then
  echo "Restarting ${NSVC}..."
  systemctl restart "$NSVC" 2>&1
  sleep 1
  NEW_STATUS=$(systemctl is-active "$NSVC" 2>/dev/null)
  echo "Status: ${NEW_STATUS}"
  [ "$NEW_STATUS" = "active" ] && echo "✅ ${NSVC} is back up" || echo "⚠️  Still not active — check full logs with: journalctl -u ${NSVC} -n 50"
else
  echo "⚠️  NOT restarting — config errors must be fixed first"
  echo "Run: nginx -t"
  echo "Then: systemctl restart ${NSVC}"
fi
