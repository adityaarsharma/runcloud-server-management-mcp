#!/usr/bin/env bash
# Perch — Trigger SSL renewal via certbot or RunCloud's redeploy_ssl
# Tries certbot first (most common), falls back to RunCloud API redeploy if certbot not present.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SCRIPT_DIR/.env" ] && set -a && . "$SCRIPT_DIR/.env" && set +a

echo "=== SSL Renewal ==="
echo ""

if command -v certbot >/dev/null 2>&1; then
  echo "→ Running: certbot renew --quiet --no-self-upgrade"
  if certbot renew --quiet --no-self-upgrade 2>&1; then
    echo "✅ certbot renew completed."
    # Reload nginx-rc to pick up new certs
    NSVC="nginx-rc"
    systemctl list-units --all 2>/dev/null | grep -q nginx-rc || NSVC="nginx"
    if systemctl reload "$NSVC" 2>/dev/null; then
      echo "✅ Reloaded $NSVC to apply new certificates."
    fi
  else
    echo "⚠  certbot exited non-zero. Inspect /var/log/letsencrypt/letsencrypt.log"
  fi
elif [ -n "${RUNCLOUD_API_KEY:-}" ]; then
  echo "→ certbot not found. Falling back to RunCloud API redeploy_ssl."
  echo "   This requires server_id + ssl_id — use Perch MCP tool 'redeploy_ssl' instead."
  echo "   From Claude Code: /redeploy_ssl serverId=X webAppId=Y"
else
  echo "⚠  No certbot installed and no RUNCLOUD_API_KEY set."
  echo "   Install certbot: sudo apt-get install certbot"
fi
