#!/usr/bin/env bash
# Perch — Full server status check
set -euo pipefail

# Detect nginx service (RunCloud uses nginx-rc)
if systemctl list-units --all 2>/dev/null | grep -q 'nginx-rc'; then
  NSVC=nginx-rc
else
  NSVC=nginx
fi

# RAM
MEM_TOTAL=$(free -m | awk 'NR==2{print $2}')
MEM_USED=$(free -m  | awk 'NR==2{print $3}')
MEM_PCT=$(free      | awk 'NR==2{printf "%d",($3/$2)*100}')

# Disk
DISK_PCT=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
DISK_USED=$(df -h / | awk 'NR==2{print $3}')
DISK_TOTAL=$(df -h / | awk 'NR==2{print $2}')

# CPU load
LOAD=$(uptime | awk -F'load average:' '{print $2}' | awk '{print $1}' | tr -d ',')
CPUS=$(nproc)

# Services
NGINX_STATUS=$(systemctl is-active "$NSVC" 2>/dev/null || echo "unknown")
MYSQL_STATUS=$(systemctl is-active mysql 2>/dev/null || systemctl is-active mariadb 2>/dev/null || echo "unknown")
PHP_VERS=$(ls /etc/php 2>/dev/null | tr '\n' ' ' | sed 's/ $//')

# Orphan processes
ORPHAN_N=$(ps -eo ppid,comm 2>/dev/null \
  | awk '$1==1 && $2!="init" && $2!="systemd" && $2!="(sd-pam)" && $2!="dbus-daemon"' \
  | wc -l | tr -d ' ')

# Redis / object cache
REDIS_STATUS=$(systemctl is-active redis 2>/dev/null || echo "off")

# Uptime
UPTIME=$(uptime -p 2>/dev/null || uptime | awk -F'up ' '{print $2}' | cut -d',' -f1)

echo "=== Perch Server Status ==="
echo ""
echo "RAM:    ${MEM_USED}MB / ${MEM_TOTAL}MB (${MEM_PCT}%)"
echo "Disk:   ${DISK_USED} / ${DISK_TOTAL} (${DISK_PCT}%)"
echo "Load:   ${LOAD} (${CPUS} CPUs)"
echo "Uptime: ${UPTIME}"
echo ""
echo "--- Services ---"
echo "${NSVC}:  ${NGINX_STATUS}"
echo "MySQL:  ${MYSQL_STATUS}"
echo "Redis:  ${REDIS_STATUS}"
[ -n "${PHP_VERS}" ] && echo "PHP:    ${PHP_VERS}"
echo ""

# Warnings
WARN=0
[ "$MEM_PCT"   -gt 85 ] && echo "⚠️  RAM at ${MEM_PCT}% — getting high" && WARN=1
[ "$DISK_PCT"  -gt 80 ] && echo "⚠️  Disk at ${DISK_PCT}% — watch this" && WARN=1
[ "$ORPHAN_N"  -gt 10 ] && echo "⚠️  ${ORPHAN_N} orphan processes found" && WARN=1
[ "$NGINX_STATUS" != "active" ] && echo "🔴 ${NSVC} is ${NGINX_STATUS}" && WARN=1
[ "$MYSQL_STATUS" != "active" ] && echo "🔴 MySQL is ${MYSQL_STATUS}" && WARN=1
[ "$WARN" -eq 0 ] && echo "✅ All systems healthy"
