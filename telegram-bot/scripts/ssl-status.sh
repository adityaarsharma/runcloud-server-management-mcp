#!/usr/bin/env bash
# Perch — SSL expiry summary for all monitored sites
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SCRIPT_DIR/.env" ] && set -a && . "$SCRIPT_DIR/.env" && set +a

if [ -z "${MONITOR_SITES:-}" ]; then
  echo "ℹ  No sites configured."
  echo "   Set MONITOR_SITES=site1.com,site2.com in .env to track SSL."
  exit 0
fi

echo "=== SSL Certificate Status ==="
echo ""

NOW=$(date +%s)
IFS=',' read -ra SITES <<< "$MONITOR_SITES"

for raw in "${SITES[@]}"; do
  site="$(echo "$raw" | tr -d ' ')"
  [ -z "$site" ] && continue

  end_date="$(echo | timeout 8 openssl s_client -servername "$site" -connect "$site:443" 2>/dev/null \
                | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')"

  if [ -z "$end_date" ]; then
    printf "  %-32s  %s\n" "$site" "✗ unable to read certificate"
    continue
  fi

  end_epoch="$(date -d "$end_date" +%s 2>/dev/null || echo 0)"
  if [ "$end_epoch" = 0 ]; then
    printf "  %-32s  %s\n" "$site" "✗ unparseable expiry"
    continue
  fi
  days=$(( (end_epoch - NOW) / 86400 ))

  if [ "$days" -lt 7 ]; then
    icon="🔴"
  elif [ "$days" -lt 30 ]; then
    icon="⚠️ "
  else
    icon="✅"
  fi

  printf "  %s  %-32s  %d days  (until %s)\n" "$icon" "$site" "$days" "$end_date"
done
