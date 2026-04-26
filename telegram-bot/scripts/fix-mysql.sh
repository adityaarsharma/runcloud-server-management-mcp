#!/usr/bin/env bash
# Perch — Restart MySQL or MariaDB safely (with OOM context)
set -uo pipefail

echo "=== Database Restart ==="

SVC=""
for s in mysql mariadb; do
  if systemctl list-units --all 2>/dev/null | grep -q " ${s}\."; then
    SVC="$s"; break
  fi
done

if [ -z "$SVC" ]; then
  echo "ℹ  No MySQL or MariaDB service found."
  exit 0
fi

STATUS="$(systemctl is-active "$SVC" 2>/dev/null)"
echo "Service: $SVC ($STATUS)"

# Look for OOM kills in the last 1 hour
OOM_HITS="$(journalctl --since '1 hour ago' --no-pager 2>/dev/null | grep -ci "killed process.*mysqld\|out of memory.*mysql" || echo 0)"
if [ "$OOM_HITS" -gt 0 ]; then
  echo "⚠  MySQL was OOM-killed $OOM_HITS time(s) in the last hour."
  echo "   Consider tuning innodb_buffer_pool_size or adding swap before restarting again."
fi

if [ "$STATUS" = "active" ]; then
  echo "✅ Already active. (Pass force=1 to restart anyway.)"
  exit 0
fi

echo "Restarting $SVC..."
if systemctl restart "$SVC" 2>&1; then
  sleep 2
  NEW_STATUS="$(systemctl is-active "$SVC" 2>/dev/null)"
  if [ "$NEW_STATUS" = "active" ]; then
    echo "✅ $SVC is back up."
    # Quick sanity check
    if command -v mysql >/dev/null 2>&1; then
      mysql -e 'SELECT 1' 2>/dev/null >/dev/null \
        && echo "✅ Database accepts queries." \
        || echo "⚠  Service active but query failed — check credentials / sockets."
    fi
  else
    echo "⚠  $SVC still $NEW_STATUS after restart"
    echo "   Last 5 errors:"
    journalctl -u "$SVC" -n 5 --no-pager 2>/dev/null | sed 's/^/    /'
  fi
else
  echo "✗  Restart failed."
  journalctl -u "$SVC" -n 5 --no-pager 2>/dev/null | sed 's/^/    /'
fi
