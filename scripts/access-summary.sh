#!/usr/bin/env bash
# Per-domain access log summary: total, top URLs, status codes, peak hour.
set -uo pipefail
QUERY="${DOMAIN:-${1:-}}"
[ -z "$QUERY" ] && { echo "Missing DOMAIN"; exit 1; }
CONF=$(sudo find /etc/nginx-rc/conf.d -type f -name "${QUERY}.conf" 2>/dev/null | head -1)
[ -z "$CONF" ] && CONF=$(sudo grep -rl -E "server_name[[:space:]]+(www\\.)?${QUERY}\\b" /etc/nginx-rc/conf.d/ 2>/dev/null | head -1)
[ -z "$CONF" ] && { echo "Domain not found in nginx confs"; exit 1; }
WEBAPP=$(basename "$(dirname "$CONF")" | sed 's/\.domains\.d$//')
LOG=""
for C in "/etc/nginx-rc/conf.d/${WEBAPP}.d/main.conf" "/etc/nginx-rc/conf.d/${WEBAPP}.conf"; do
  L=$(sudo grep -h "access_log" "$C" 2>/dev/null | grep -v "off;" | grep -v "/var/log/nginx-rc" | awk '{print $2}' | sed 's/;$//' | head -1)
  [ -n "$L" ] && sudo test -f "$L" && LOG="$L" && break
done
[ -z "$LOG" ] && LOG=$(sudo find /home -name "${WEBAPP}_access.log" 2>/dev/null | head -1)
[ -z "$LOG" ] || ! sudo test -f "$LOG" && { echo "access_log unresolvable for $WEBAPP"; exit 1; }

echo "Domain: $QUERY  ·  Webapp: $WEBAPP"
echo "Log: $LOG"
echo ""

TOTAL=$(sudo cat "$LOG" 2>/dev/null | wc -l)
TODAY=$(date +%d/%b/%Y)
TODAY_HITS=$(sudo grep -c "$TODAY" "$LOG" 2>/dev/null || echo 0)
echo "Total log lines: $TOTAL  ·  Today: $TODAY_HITS hits"
echo ""

echo "Status code breakdown (last 10K):"
sudo tail -n 10000 "$LOG" 2>/dev/null | awk '{print $9}' | sort | uniq -c | sort -rn | head -10 | awk '{printf "  %5d  %s\n", $1, $2}'
echo ""

echo "Top 10 URLs (last 10K):"
sudo tail -n 10000 "$LOG" 2>/dev/null | awk '{print $7}' | sort | uniq -c | sort -rn | head -10 | awk '{printf "  %5d  %s\n", $1, substr($2,1,80)}'
echo ""

echo "Top 5 user-agents (last 5K):"
sudo tail -n 5000 "$LOG" 2>/dev/null | awk -F'"' '{print $6}' | sort | uniq -c | sort -rn | head -5 | awk '{printf "  %5d  %s\n", $1, substr($0,index($0,$2),80)}'
echo ""

echo "Peak hour (last 10K):"
sudo tail -n 10000 "$LOG" 2>/dev/null | awk '{print $4}' | cut -c14-15 | sort | uniq -c | sort -rn | head -3 | awk '{printf "  %5d hits at hour %s\n", $1, $2}'
