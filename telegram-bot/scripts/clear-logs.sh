#!/usr/bin/env bash
# Perch — Clear large log files safely (truncate, not delete)
set -uo pipefail

BEFORE=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
CLEARED=()

echo "=== Clearing Large Logs ==="
echo "Disk before: ${BEFORE}%"
echo ""

# Truncate (not delete) log files >50MB — safe for running processes
while IFS= read -r -d '' f; do
  SZ=$(du -sh "$f" 2>/dev/null | cut -f1)
  truncate -s 0 "$f" 2>/dev/null && CLEARED+=("${SZ}: $f")
done < <(find /var/log /home -name "*.log" -size +50M -print0 2>/dev/null)

# Clear /tmp PHP sessions older than 24h
find /tmp -name "sess_*" -mtime +1 -delete 2>/dev/null
SESS_COUNT=$(find /tmp -name "sess_*" -mtime +1 2>/dev/null | wc -l)

AFTER=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')

if [ ${#CLEARED[@]} -gt 0 ]; then
  echo "Cleared ${#CLEARED[@]} log file(s):"
  for c in "${CLEARED[@]}"; do echo "  ✓ $c"; done
else
  echo "No large log files found (>50MB)"
fi

[ "$SESS_COUNT" -gt 0 ] && echo "Cleared ${SESS_COUNT} old PHP session files"
echo ""
echo "Disk: ${BEFORE}% → ${AFTER}%"
