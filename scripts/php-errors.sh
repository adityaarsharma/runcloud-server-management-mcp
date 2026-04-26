#!/usr/bin/env bash
# PHP-FPM error logs across versions, grouped + deduped.
set -uo pipefail
LOGS=$(sudo find /var/log -name "php*fpm*.log*" 2>/dev/null | head -10)
[ -z "$LOGS" ] && { echo "No PHP-FPM logs found"; exit 0; }

for L in $LOGS; do
  echo "═══ $L"
  echo ""
  echo "Last 5 errors per type:"
  sudo tail -n 500 "$L" 2>/dev/null | grep -iE "ERROR|WARNING|FATAL" \
    | sed -E 's/^\[[^]]+\] //' \
    | sort | uniq -c | sort -rn | head -5 | awk '{n=$1; $1=""; printf "  %4d×  %s\n", n, substr($0,2,200)}'
  echo ""
done

echo "═══ Per-pool errors (RunCloud user pools)"
USER_LOGS=$(sudo find /home -path "*/logs/*.log" -name "*php*" 2>/dev/null | head -10)
for L in $USER_LOGS; do
  N=$(sudo wc -l < "$L" 2>/dev/null || echo 0)
  [ "$N" -gt 0 ] && echo "  $L  ($N lines)"
done
