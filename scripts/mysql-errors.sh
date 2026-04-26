#!/usr/bin/env bash
# MariaDB / MySQL error + slow query summary.
set -uo pipefail

ERR_LOG=""
for C in /var/log/mysql/error.log /var/log/mariadb/mariadb.log /var/log/mysql.err /var/log/mysqld.log; do
  if sudo test -f "$C"; then ERR_LOG="$C"; break; fi
done

if [ -n "$ERR_LOG" ]; then
  echo "═══ Error log: $ERR_LOG"
  echo "Last 10 distinct errors:"
  sudo tail -n 500 "$ERR_LOG" 2>/dev/null | grep -iE "ERROR|\\[Warning\\]" \
    | sed -E 's/^[0-9-]+ +[0-9:]+ +[0-9]+ +//' \
    | sort | uniq -c | sort -rn | head -10 | awk '{n=$1; $1=""; printf "  %4d×  %s\n", n, substr($0,2,180)}'
  echo ""
fi

SLOW=""
for C in /var/log/mysql/mysql-slow.log /var/log/mysql/slow.log /var/lib/mysql/*-slow.log; do
  if sudo test -f "$C" 2>/dev/null; then SLOW="$C"; break; fi
done
if [ -n "$SLOW" ]; then
  echo "═══ Slow query log: $SLOW"
  echo "Recent slow queries (last 200 lines):"
  sudo tail -n 200 "$SLOW" 2>/dev/null | grep -E "Query_time|^# User" | head -20
fi

echo ""
echo "═══ Service status"
sudo systemctl is-active mariadb mysql 2>/dev/null | head -2
