#!/usr/bin/env bash
# Perch — Tail nginx error log (RunCloud-aware)
set -uo pipefail

LOG=""
for candidate in /var/log/nginx-rc/error.log /var/log/nginx/error.log; do
  [ -f "$candidate" ] && LOG="$candidate" && break
done

if [ -z "$LOG" ]; then
  echo "ℹ  No nginx error log found at standard paths."
  exit 0
fi

echo "=== Last 30 lines of $LOG ==="
tail -30 "$LOG" 2>/dev/null | sed 's/^/  /'

# Highlight critical issues
echo ""
ERR_COUNT=$(grep -c '\[crit\]\|\[emerg\]\|\[error\]' "$LOG" 2>/dev/null || echo 0)
if [ "$ERR_COUNT" -gt 0 ]; then
  echo "Total errors in this log: $ERR_COUNT"
  echo "Most common error patterns:"
  grep -oE '\[(crit|emerg|error)\][^"]*' "$LOG" 2>/dev/null \
    | sort | uniq -c | sort -rn | head -5 | sed 's/^/  /'
fi
