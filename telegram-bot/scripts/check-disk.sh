#!/usr/bin/env bash
# Perch — Disk usage breakdown with growth context
set -uo pipefail

echo "=== Disk Usage ==="
df -h / | awk 'NR==2{printf "Root: %s / %s (%s used)\n",$3,$2,$5}'
echo ""

echo "--- Top Directories ---"
du -sh /home/* 2>/dev/null | sort -rh | head -10
du -sh /var/log 2>/dev/null
du -sh /tmp 2>/dev/null

echo ""
echo "--- Large Files (>100MB) ---"
find /home /var/log -size +100M 2>/dev/null -exec du -sh {} \; 2>/dev/null | sort -rh | head -15

echo ""
echo "--- Large Log Files (>10MB) ---"
find /var/log /home -name "*.log" -size +10M 2>/dev/null -exec du -sh {} \; 2>/dev/null | sort -rh | head -10

DISK_PCT=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
echo ""
if   [ "$DISK_PCT" -gt 90 ]; then echo "🔴 Disk at ${DISK_PCT}% — CRITICAL: clear logs or add storage"
elif [ "$DISK_PCT" -gt 80 ]; then echo "⚠️  Disk at ${DISK_PCT}% — getting full"
else echo "✅ Disk at ${DISK_PCT}% — OK"
fi
