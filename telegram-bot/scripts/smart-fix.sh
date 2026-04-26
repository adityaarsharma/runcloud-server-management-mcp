#!/usr/bin/env bash
# Perch — Smart Fix: diagnose and auto-repair common issues
set -uo pipefail

NSVC=$(systemctl list-units --all 2>/dev/null | grep -q 'nginx-rc' && echo nginx-rc || echo nginx)
ISSUES=()
FIXES=()

# --- Check nginx ---
NGINX_UP=$(systemctl is-active "$NSVC" 2>/dev/null || echo inactive)
if [ "$NGINX_UP" != "active" ]; then
  ISSUES+=("${NSVC} was ${NGINX_UP}")
  # Check config first
  if nginx -t 2>&1 | grep -q "successful"; then
    systemctl restart "$NSVC" 2>/dev/null
    sleep 1
    NEW_STATUS=$(systemctl is-active "$NSVC" 2>/dev/null)
    if [ "$NEW_STATUS" = "active" ]; then
      FIXES+=("Restarted ${NSVC} — now active")
    else
      FIXES+=("⚠️  ${NSVC} restart attempted but still ${NEW_STATUS} — check logs")
    fi
  else
    NGINX_ERR=$(nginx -t 2>&1 | grep "error" | head -3)
    FIXES+=("⚠️  ${NSVC} config has errors — NOT restarting: ${NGINX_ERR}")
  fi
fi

# --- Check MySQL ---
MYSQL_SVC=""
systemctl is-active mysql &>/dev/null && MYSQL_SVC=mysql
systemctl is-active mariadb &>/dev/null && MYSQL_SVC=mariadb
if [ -n "$MYSQL_SVC" ]; then
  MYSQL_UP=$(systemctl is-active "$MYSQL_SVC" 2>/dev/null)
  if [ "$MYSQL_UP" != "active" ]; then
    ISSUES+=("MySQL (${MYSQL_SVC}) was ${MYSQL_UP}")
    systemctl restart "$MYSQL_SVC" 2>/dev/null
    sleep 2
    NEW_MYSQL=$(systemctl is-active "$MYSQL_SVC" 2>/dev/null)
    FIXES+=("Restarted ${MYSQL_SVC} — now ${NEW_MYSQL}")
  fi
fi

# --- Check memory ---
MEM_PCT=$(free | awk 'NR==2{printf "%d",($3/$2)*100}')
if [ "$MEM_PCT" -gt 88 ]; then
  ISSUES+=("Memory at ${MEM_PCT}%")
  # Try PM2 restart first (usually the leaker on RunCloud setups)
  PM2=$(which pm2 2>/dev/null || find /home -name pm2 -maxdepth 6 2>/dev/null | head -1)
  if [ -n "$PM2" ]; then
    $PM2 restart all 2>/dev/null
    sleep 3
    NEW_MEM=$(free | awk 'NR==2{printf "%d",($3/$2)*100}')
    FIXES+=("Restarted PM2 processes — memory now ${NEW_MEM}%")
  else
    FIXES+=("⚠️  Memory at ${MEM_PCT}% but no PM2 found — manual investigation needed")
  fi
fi

# --- Check disk ---
DISK_PCT=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
if [ "$DISK_PCT" -gt 88 ]; then
  ISSUES+=("Disk at ${DISK_PCT}%")
  # Clear large log files (>50MB)
  CLEARED=$(find /var/log /home -name "*.log" -size +50M 2>/dev/null \
    -exec sh -c 'sz=$(du -sh "$1" 2>/dev/null|cut -f1); truncate -s 0 "$1" && echo "$sz: $1"' _ {} \; | head -10)
  NEW_DISK=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
  if [ -n "$CLEARED" ]; then
    FIXES+=("Cleared large logs — disk now ${NEW_DISK}%: ${CLEARED}")
  else
    FIXES+=("⚠️  Disk at ${NEW_DISK}% but no large logs found — check /home for large files")
  fi
fi

# --- Check orphan processes ---
ORPHAN_N=$(ps -eo ppid,comm 2>/dev/null \
  | awk '$1==1 && $2!="init" && $2!="systemd" && $2!="(sd-pam)" && $2!="dbus-daemon"' \
  | wc -l | tr -d ' ')
if [ "$ORPHAN_N" -gt 15 ]; then
  ISSUES+=("${ORPHAN_N} orphan processes (PPID=1)")
  ps -eo ppid,pid,comm 2>/dev/null \
    | awk '$1==1 && $3!="init" && $3!="systemd" && $3!="(sd-pam)"' \
    | awk '{print $2}' | xargs kill -9 2>/dev/null || true
  FIXES+=("Killed ${ORPHAN_N} orphan processes")
fi

# --- Report ---
FINAL_MEM=$(free | awk 'NR==2{printf "%d",($3/$2)*100}')
FINAL_DISK=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
FINAL_NGINX=$(systemctl is-active "$NSVC" 2>/dev/null || echo unknown)

if [ ${#ISSUES[@]} -eq 0 ]; then
  echo "✅ All systems healthy — nothing needed fixing"
  echo "RAM: ${FINAL_MEM}% | Disk: ${FINAL_DISK}% | ${NSVC}: ${FINAL_NGINX}"
else
  echo "${#ISSUES[@]} issue(s) found:"
  for i in "${ISSUES[@]}"; do echo "  • $i"; done
  echo ""
  echo "Actions taken:"
  for f in "${FIXES[@]}"; do echo "  ✓ $f"; done
  echo ""
  echo "After fix: RAM ${FINAL_MEM}% | Disk ${FINAL_DISK}% | ${NSVC}: ${FINAL_NGINX}"
fi
