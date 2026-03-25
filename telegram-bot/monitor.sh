#!/bin/bash
# Server Monitor — Cron-based Telegram alerting
# Add to cron: */10 * * * * /path/to/monitor.sh
# Reads config from .env in same directory

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SCRIPT_DIR/.env" ] && source "$SCRIPT_DIR/.env"

# Required config
BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
CHAT_ID="${TELEGRAM_CHAT_ID}"
FIX_URL="${FIX_SERVER_URL:-http://127.0.0.1:3011}"
NGINX_SVC="${NGINX_SERVICE:-auto}"
MCP_PORTS="${MONITOR_PORTS:-}"
STATE_FILE="${MONITOR_STATE_FILE:-/tmp/server-monitor-state}"
COOLDOWN="${MONITOR_COOLDOWN:-1800}"
MUTE_FILE="/tmp/server-monitor-muted"
TIMESTAMP=$(TZ="${MONITOR_TIMEZONE:-UTC}" date '+%H:%M %Z')

# Check mute
[ -f "$MUTE_FILE" ] && MUTE_UNTIL=$(cat "$MUTE_FILE" 2>/dev/null) && [ "$(date +%s)" -lt "$MUTE_UNTIL" ] && exit 0

# Auto-detect nginx service
if [ "$NGINX_SVC" = "auto" ]; then
    systemctl list-units --all 2>/dev/null | grep -q nginx-rc && NGINX_SVC=nginx-rc || NGINX_SVC=nginx
fi

# Collect metrics
AVAIL_MB=$(free -m | awk 'NR==2{print $7}')
TOTAL_MB=$(free -m | awk 'NR==2{print $2}')
DISK_PCT=$(df / | awk 'NR==2{gsub(/%/,""); print $5}')
DISK_USED=$(df -h / | awk 'NR==2{print $3}')
LOAD1=$(awk '{print $1}' /proc/loadavg)
CORES=$(nproc)
LOAD_PCT=$(echo "$LOAD1 $CORES" | awk '{printf "%d", $1/$2*100}')
NGINX_UP=$(systemctl is-active "$NGINX_SVC" 2>/dev/null)
ORPHANS=$(ps -eo ppid,comm 2>/dev/null | awk '$1==1 && $2!="init" && $2!="systemd" && $2!="(sd-pam)" && $2!="dbus-daemon"' | wc -l | tr -d ' ')
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
SERVER_NAME="${MONITOR_SERVER_NAME:-$(hostname -s)}"

ALERT=0; ISSUES=""

# Thresholds (override in .env)
RAM_THRESHOLD="${MONITOR_RAM_THRESHOLD:-800}"
DISK_THRESHOLD="${MONITOR_DISK_THRESHOLD:-85}"
ORPHAN_THRESHOLD="${MONITOR_ORPHAN_THRESHOLD:-5}"
LOAD_THRESHOLD="${MONITOR_LOAD_THRESHOLD:-150}"

[ "$AVAIL_MB" -lt "$RAM_THRESHOLD" ]   && ALERT=1 && ISSUES="${ISSUES}⚠️ Low RAM: ${AVAIL_MB}MB free\n"
[ "$DISK_PCT" -gt "$DISK_THRESHOLD" ]  && ALERT=1 && ISSUES="${ISSUES}💾 Disk ${DISK_PCT}% full (${DISK_USED})\n"
[ "$ORPHANS"  -gt "$ORPHAN_THRESHOLD" ] && ALERT=1 && ISSUES="${ISSUES}👻 ${ORPHANS} orphan procs (PPID=1)\n"
[ "$LOAD_PCT" -gt "$LOAD_THRESHOLD" ]  && ALERT=1 && ISSUES="${ISSUES}🔥 CPU load ${LOAD_PCT}%\n"
[ "$NGINX_UP" != "active" ]            && ALERT=1 && ISSUES="${ISSUES}🌐 ${NGINX_SVC} is ${NGINX_UP}\n"

# Check custom ports if configured
if [ -n "$MCP_PORTS" ]; then
    IFS=',' read -ra PORTS <<< "$MCP_PORTS"
    DOWN=0
    for PORT in "${PORTS[@]}"; do
        PORT=$(echo "$PORT" | tr -d ' ')
        nc -z 127.0.0.1 "$PORT" 2>/dev/null || DOWN=$((DOWN+1))
    done
    [ "$DOWN" -gt 0 ] && ALERT=1 && ISSUES="${ISSUES}🔴 ${DOWN}/${#PORTS[@]} services unreachable\n"
fi

if [ "$ALERT" -eq 1 ]; then
    ISSUE_HASH=$(echo "$ISSUES" | md5sum | awk '{print $1}')
    NOW=$(date +%s)
    if [ -f "$STATE_FILE" ]; then
        LAST_HASH=$(cut -d: -f1 "$STATE_FILE" 2>/dev/null)
        LAST_TIME=$(cut -d: -f2 "$STATE_FILE" 2>/dev/null || echo 0)
        ELAPSED=$(( NOW - LAST_TIME ))
        [ "$LAST_HASH" = "$ISSUE_HASH" ] && [ "$ELAPSED" -lt "$COOLDOWN" ] && exit 0
    fi
    echo "${ISSUE_HASH}:${NOW}" > "$STATE_FILE"

    TEXT=$(printf "🖥️ *%s* (%s)\n━━━━━━━━━━━━━━━\n%b\nRAM: %sMB free | Disk: %s%% | Load: %s%%\n🕐 %s" \
        "$SERVER_NAME" "$SERVER_IP" "$ISSUES" "$AVAIL_MB" "$DISK_PCT" "$LOAD_PCT" "$TIMESTAMP")

    KEYBOARD='{"inline_keyboard":[[{"text":"🔧 Smart Fix","callback_data":"fix"},{"text":"📊 Status","callback_data":"status"}],[{"text":"🌐 Nginx","callback_data":"fix-nginx"},{"text":"💾 Disk","callback_data":"disk"},{"text":"✅ Ignore","callback_data":"ignore"}]]}'

    jq -n --arg c "$CHAT_ID" --arg t "$TEXT" --argjson k "$KEYBOARD" \
        '{"chat_id":$c,"text":$t,"parse_mode":"Markdown","reply_markup":$k}' | \
    curl -sf -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -H "Content-Type: application/json" -d @- > /dev/null 2>&1
fi
