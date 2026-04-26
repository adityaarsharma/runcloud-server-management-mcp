#!/usr/bin/env bash
# Conversational server pulse: load, disk, ram, top procs, failed services.
set -uo pipefail

echo "═══ Uptime / Load"
uptime
echo ""

echo "═══ Memory"
free -h | awk 'NR==1 || NR==2'
echo ""

echo "═══ Disk (top 5 mounts)"
df -hT --total 2>/dev/null | grep -vE "tmpfs|udev|devtmpfs" | head -8
echo ""

echo "═══ Top 5 by CPU"
ps aux --sort=-%cpu | head -6 | awk '{printf "  %5s%%  %5s%%  %s\n", $3, $4, substr($11,1,40)}'
echo ""

echo "═══ Top 5 by RAM"
ps aux --sort=-%mem | head -6 | awk '{printf "  %5s%%  %5s%%  %s\n", $3, $4, substr($11,1,40)}'
echo ""

echo "═══ Failed services"
F=$(systemctl --failed --no-legend --no-pager 2>/dev/null | head -10)
[ -z "$F" ] && echo "  none" || echo "$F"
echo ""

echo "═══ Listening ports (top 10)"
ss -lntH 2>/dev/null | awk '{print $4}' | head -15
