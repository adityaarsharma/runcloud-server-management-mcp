#!/usr/bin/env bash
# Perch — Top 10 processes by CPU and memory
set -uo pipefail

echo "=== Top by Memory ==="
ps -eo rss,pid,user,comm --sort=-rss 2>/dev/null | head -11 \
  | awk 'NR==1{printf "%-10s %-7s %-12s %s\n",$1,$2,$3,$4} NR>1{printf "%6dMB    %-7s %-12s %s\n",$1/1024,$2,$3,$4}'

echo ""
echo "=== Top by CPU ==="
ps -eo pcpu,pid,user,comm --sort=-pcpu 2>/dev/null | head -11 \
  | awk 'NR==1{printf "%-7s %-7s %-12s %s\n",$1,$2,$3,$4} NR>1{printf "%5s%%   %-7s %-12s %s\n",$1,$2,$3,$4}'

echo ""
echo "=== Counts ==="
TOTAL=$(ps -e --no-headers 2>/dev/null | wc -l | tr -d ' ')
PHP=$(pgrep -c php 2>/dev/null || echo 0)
NODE=$(pgrep -c node 2>/dev/null || echo 0)
NGINX=$(pgrep -c nginx 2>/dev/null || echo 0)
MYSQL=$(pgrep -c mysql 2>/dev/null || echo 0)
echo "Total processes: $TOTAL"
echo "  php-fpm: $PHP   node: $NODE   nginx: $NGINX   mysql: $MYSQL"
