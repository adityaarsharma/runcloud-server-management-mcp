#!/usr/bin/env bash
# Perch — Restart n8n (systemd or PM2)
set -uo pipefail

echo "=== n8n Restart ==="

if systemctl list-units --all 2>/dev/null | grep -q ' n8n\.'; then
  echo "Found: n8n systemd service"
  systemctl restart n8n 2>&1
  sleep 2
  STATUS=$(systemctl is-active n8n 2>/dev/null)
  echo "Status: ${STATUS}"
  [ "$STATUS" = "active" ] && echo "✅ n8n restarted via systemd" || echo "⚠️  n8n still ${STATUS}"
else
  PM2=$(which pm2 2>/dev/null || find /home -name pm2 -maxdepth 6 2>/dev/null | head -1)
  if [ -n "$PM2" ]; then
    echo "Found: n8n via PM2"
    $PM2 restart n8n 2>&1 | tail -5
    sleep 2
    echo "✅ n8n restart via PM2 completed"
  else
    echo "⚠️  n8n not found via systemd or PM2"
    echo "Check: ps aux | grep n8n"
  fi
fi
