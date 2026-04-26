#!/usr/bin/env bash
# Top N visitor IPs for a domain — uses RunCloud nginx-conf layout to map
# domain → webapp → access_log path.
# Inputs (env vars): DOMAIN (required), COUNT (default 10)
set -uo pipefail
DEBUG_LOG=/tmp/perch-script-debug.log
{
  echo "----"
  echo "DATE=$(date)"
  echo "USER=$(whoami)"
  echo "PATH=$PATH"
  echo "DOMAIN=${DOMAIN:-UNSET}"
  echo "QUERY=${1:-NONE}"
  echo "TEST sudo: $(sudo -n true 2>&1 || echo SUDO_FAIL)"
  echo "TEST find: $(sudo -n find /etc/nginx-rc/conf.d -maxdepth 1 -name '*.conf' 2>&1 | head -1)"
} >> "$DEBUG_LOG" 2>&1


QUERY="${DOMAIN:-${1:-}}"
COUNT="${COUNT:-${2:-10}}"

if [ -z "$QUERY" ]; then echo "Missing DOMAIN"; exit 1; fi

# RunCloud stores per-domain confs at: /etc/nginx-rc/conf.d/<Webapp>.domains.d/<domain>.conf
DOMAIN_CONF=$(sudo find /etc/nginx-rc/conf.d -type f -name "${QUERY}.conf" 2>/dev/null | head -1)

if [ -z "$DOMAIN_CONF" ]; then
  # Fallback: any conf with matching server_name
  DOMAIN_CONF=$(sudo grep -rl -E "server_name[[:space:]]+(www\\.)?${QUERY}[[:space:]]*;" /etc/nginx-rc/conf.d/ 2>/dev/null | head -1)
fi

if [ -z "$DOMAIN_CONF" ]; then
  echo "Domain '${QUERY}' not found in nginx confs."
  exit 1
fi

# Webapp name = parent dir name minus ".domains.d"
WEBAPP=$(basename "$(dirname "$DOMAIN_CONF")" | sed 's/\.domains\.d$//')

# Pull access_log: RunCloud puts the real one in <Webapp>.d/main.conf
LOG=""
for CANDIDATE in "/etc/nginx-rc/conf.d/${WEBAPP}.d/main.conf" "/etc/nginx-rc/conf.d/${WEBAPP}.conf"; do
  L=$(sudo grep -h "access_log" "$CANDIDATE" 2>/dev/null \
      | grep -v "off;" \
      | grep -v "/var/log/nginx-rc" \
      | awk '{print $2}' | sed 's/;$//' | head -1)
  if [ -n "$L" ] && sudo test -f "$L"; then LOG="$L"; break; fi
done

# Last resort: search by webapp name
if [ -z "$LOG" ] || ! sudo test -f "$LOG"; then
  LOG=$(sudo find /home -name "${WEBAPP}_access.log" 2>/dev/null | head -1)
fi

if [ -z "$LOG" ] || ! sudo test -f "$LOG"; then
  echo "Webapp '${WEBAPP}' found for ${QUERY} but access_log not resolvable."
  exit 1
fi

TOTAL=$(sudo cat "$LOG" 2>/dev/null | wc -l 2>/dev/null || echo 0)
LAST=$(sudo tail -1 "$LOG" 2>/dev/null | awk '{print $4, $5}' | tr -d '[]')

echo "Domain: $QUERY"
echo "Webapp: $WEBAPP"
echo "Total log lines: $TOTAL"
echo "Last hit: $LAST"
echo ""
echo "Top $COUNT IPs (last 10000 entries):"
echo "----"
sudo tail -n 10000 "$LOG" 2>/dev/null | awk '{print $1}' | sort | uniq -c | sort -rn | head -n "$COUNT" | awk '{printf "%6d  %s\n", $1, $2}'
echo "----"

CF_COUNT=$(sudo tail -n 1000 "$LOG" 2>/dev/null | awk '{print $1}' | grep -E "^(172\\.6[4-9]|172\\.7[0-1]|162\\.158|141\\.101|108\\.162|173\\.245|104\\.2[0-3])\\." | wc -l)
if [ "$CF_COUNT" -gt 500 ]; then
  echo ""
  echo "NOTE: site is behind Cloudflare — real visitor IPs masked. Top IPs above are CF edge nodes."
  echo "Fix: log \$http_cf_connecting_ip in nginx access format."
fi
