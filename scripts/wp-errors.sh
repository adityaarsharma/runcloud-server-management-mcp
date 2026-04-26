#!/usr/bin/env bash
# WordPress debug.log + plugin error analysis.
set -uo pipefail
QUERY="${DOMAIN:-${1:-}}"

if [ -n "$QUERY" ]; then
  CONF=$(sudo find /etc/nginx-rc/conf.d -type f -name "${QUERY}.conf" 2>/dev/null | head -1)
  [ -z "$CONF" ] && CONF=$(sudo grep -rl -E "server_name[[:space:]]+${QUERY}\\b" /etc/nginx-rc/conf.d/ 2>/dev/null | head -1)
  [ -z "$CONF" ] && { echo "Domain not found"; exit 1; }
  WEBAPP=$(basename "$(dirname "$CONF")" | sed 's/\.domains\.d$//')
  ROOT=$(sudo grep -h "root " "/etc/nginx-rc/conf.d/${WEBAPP}.d/main.conf" 2>/dev/null | awk '{print $2}' | sed 's/;$//' | head -1)
  DEBUG_LOGS=$(sudo find "$ROOT" -name "debug.log" -path "*wp-content*" 2>/dev/null | head -3)
else
  DEBUG_LOGS=$(sudo find /home -name "debug.log" -path "*wp-content*" 2>/dev/null | head -10)
fi

if [ -z "$DEBUG_LOGS" ]; then
  echo "No WordPress debug.log files found for: ${QUERY:-all sites}"
  exit 0
fi

for L in $DEBUG_LOGS; do
  SITE=$(echo "$L" | sed 's|.*/home/\([^/]*\)/.*|\1|')
  SIZE=$(sudo wc -l < "$L" 2>/dev/null || sudo cat "$L" | wc -l)
  echo "═══ $L"
  echo "User: $SITE  ·  Lines: $SIZE"
  echo ""
  echo "Last 10 errors (deduped + counted):"
  sudo tail -n 500 "$L" 2>/dev/null | grep -iE "PHP (Fatal|Warning|Notice|Parse|Deprecated)|Uncaught" \
    | sed -E 's/^\[[^]]+\] //; s|/wp-content/plugins/([^/]+)/.*|/wp-content/plugins/\1/...|; s|/wp-content/themes/([^/]+)/.*|/wp-content/themes/\1/...|' \
    | sort | uniq -c | sort -rn | head -10 | awk '{n=$1; $1=""; printf "  %4d×  %s\n", n, substr($0,2,200)}'
  echo ""
  echo "Plugins blamed (last 1K):"
  sudo tail -n 1000 "$L" 2>/dev/null | grep -oE "wp-content/plugins/[^/]+" | sort | uniq -c | sort -rn | head -5 | awk '{printf "  %4d×  %s\n", $1, $2}'
  echo ""
done
