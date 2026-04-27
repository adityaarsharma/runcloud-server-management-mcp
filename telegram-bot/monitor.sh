#!/usr/bin/env bash
# Perch — Comprehensive Automation Rule Engine
# Runs every 5 min via cron, evaluates 14 rules, sends friendly Telegram alerts.
# No external dependencies (no n8n, no Zapier). Fully self-contained.
#
# Add to cron with: crontab -e
#   */5 * * * * /home/user/Perch/telegram-bot/monitor.sh
#
# Reads config from .env in same directory.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SCRIPT_DIR/.env" ] && set -a && . "$SCRIPT_DIR/.env" && set +a

# ── Required tooling ──────────────────────────────────────────────────────────

for cmd in free df awk nproc curl jq md5sum ps systemctl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing: $cmd" >&2; exit 1; }
done

# ── Required config ───────────────────────────────────────────────────────────

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${TELEGRAM_CHAT_ID:-}"
[ -z "$BOT_TOKEN" ] && { echo "TELEGRAM_BOT_TOKEN not set" >&2; exit 1; }
[ -z "$CHAT_ID" ]   && { echo "TELEGRAM_CHAT_ID not set" >&2;   exit 1; }

# ── Optional config + thresholds (sensible defaults) ──────────────────────────

FIX_URL="${FIX_SERVER_URL:-http://127.0.0.1:3011}"
NGINX_SVC="${NGINX_SVC:-auto}"  # honour .env override
STATE_DIR="${MONITOR_STATE_DIR:-/tmp/perch-monitor}"
MUTE_FILE="${MONITOR_MUTE_FILE:-/tmp/perch-monitor-muted}"
SERVER_NAME="${MONITOR_SERVER_NAME:-$(hostname -s)}"
TZ_NAME="${MONITOR_TIMEZONE:-UTC}"

# Per-rule thresholds (override in .env)
RULE_RAM_WARN="${RULE_RAM_WARN:-85}"        # %
RULE_RAM_CRIT="${RULE_RAM_CRIT:-93}"        # %
RULE_DISK_WARN="${RULE_DISK_WARN:-80}"      # %
RULE_DISK_HIGH="${RULE_DISK_HIGH:-90}"      # %
RULE_DISK_CRIT="${RULE_DISK_CRIT:-95}"      # %
RULE_LOAD_PCT_WARN="${RULE_LOAD_PCT_WARN:-100}"  # % of nproc cores
RULE_LOAD_PCT_CRIT="${RULE_LOAD_PCT_CRIT:-200}"
RULE_ORPHAN_WARN="${RULE_ORPHAN_WARN:-10}"
RULE_SSL_DAYS_WARN="${RULE_SSL_DAYS_WARN:-30}"
RULE_SSL_DAYS_CRIT="${RULE_SSL_DAYS_CRIT:-7}"
RULE_FAIL2BAN_BAN_RATE="${RULE_FAIL2BAN_BAN_RATE:-50}"   # bans/hour
RULE_5XX_RATE="${RULE_5XX_RATE:-1}"          # % of requests
RULE_COOLDOWN="${RULE_COOLDOWN:-1800}"        # 30 min between repeat alerts

# Sites to HTTP-check (CSV of domains): MONITOR_SITES="example.com,api.example.com"
MONITOR_SITES="${MONITOR_SITES:-}"

# Custom ports to check (CSV): MONITOR_PORTS="3000,5678"
MONITOR_PORTS="${MONITOR_PORTS:-}"

# ── State directory ───────────────────────────────────────────────────────────

mkdir -p "$STATE_DIR" 2>/dev/null
chmod 700 "$STATE_DIR" 2>/dev/null || true

# ── Mute check ────────────────────────────────────────────────────────────────

if [ -f "$MUTE_FILE" ]; then
  MUTE_UNTIL=$(cat "$MUTE_FILE" 2>/dev/null)
  if [ -n "$MUTE_UNTIL" ] && [ "$(date +%s)" -lt "$MUTE_UNTIL" ]; then
    exit 0
  fi
fi

# ── Auto-detect nginx service (RunCloud uses nginx-rc) ────────────────────────

if [ "$NGINX_SVC" = "auto" ]; then
  if systemctl list-units --all 2>/dev/null | grep -q 'nginx-rc'; then
    NGINX_SVC="nginx-rc"
  else
    NGINX_SVC="nginx"
  fi
fi

# ── Telegram send helper ──────────────────────────────────────────────────────

send_alert() {
  # send_alert <rule_id> <severity> <title> <body> <button_json>
  local rule_id="$1" severity="$2" title="$3" body="$4" buttons="${5:-[]}"
  body="$(printf '%b' "$body")"  # expand \n escape sequences

  # Mark Perch session active (kind=alert, 24h timeout) so Niyati can route
  # cross-questions to handle_server until user clicks Acknowledge.
  if [ -w /tmp ]; then
    local now_iso; now_iso="$(date -u +%Y-%m-%dT%H:%M:%S)"
    cat > /tmp/perch_session.json << SESSEOF
{"active": true, "kind": "alert", "started": "${now_iso}", "last_activity": "${now_iso}", "alert_rule": "${rule_id}"}
SESSEOF
    chmod 666 /tmp/perch_session.json 2>/dev/null || true
  fi

  local state_file="$STATE_DIR/$rule_id"
  local now hash last_hash last_time elapsed
  now="$(date +%s)"
  hash="$(printf '%s%s' "$title" "$body" | md5sum | awk '{print $1}')"

  # Cooldown — don't repeat the same alert
  if [ -f "$state_file" ]; then
    last_hash="$(cut -d: -f1 "$state_file" 2>/dev/null)"
    last_time="$(cut -d: -f2 "$state_file" 2>/dev/null || echo 0)"
    elapsed=$((now - last_time))
    if [ "$last_hash" = "$hash" ] && [ "$elapsed" -lt "$RULE_COOLDOWN" ]; then
      return 0
    fi
  fi
  printf '%s:%s\n' "$hash" "$now" > "$state_file"

  local emoji
  case "$severity" in
    info)     emoji="ℹ️" ;;
    warning)  emoji="⚠️" ;;
    critical) emoji="🔴" ;;
    *)        emoji="•"  ;;
  esac

  local timestamp; timestamp="$(TZ="$TZ_NAME" date '+%H:%M %Z')"
  local server_ip; server_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"

  local text
  text=$(printf '%s *%s — %s*\n%s\n\n%s\n\n_Server: %s · %s_' \
    "$emoji" "$SERVER_NAME" "$title" "$server_ip" "$body" "$SERVER_NAME" "$timestamp")

  # SECURITY [H5]: keep BOT_TOKEN out of curl's argv (visible in `ps`).
  # Build the full URL into a curl --config block fed via stdin.
  local url_config
  url_config="$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$BOT_TOKEN")"

  jq -n \
    --arg c "$CHAT_ID" \
    --arg t "$text" \
    --argjson k "{\"inline_keyboard\":$buttons}" \
    '{"chat_id":$c,"text":$t,"parse_mode":"Markdown","reply_markup":$k}' \
  | curl -sf -X POST -K <(printf '%s\n' "$url_config") \
      -H 'Content-Type: application/json' -d @- > /dev/null 2>&1 || true

  # ── Slack mirror — fires when SLACK_WEBHOOK_URL is set ────────────────────
  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    local sev_color
    case "$severity" in
      critical) sev_color="#dc2626" ;;
      warning)  sev_color="#f59e0b" ;;
      *)        sev_color="#3b82f6" ;;
    esac
    local slack_text
    slack_text=$(printf "%s %s — %s\n%s\n\n_Server: %s · %s_" \
      "$emoji" "$SERVER_NAME" "$title" "$body" "$SERVER_NAME" "$timestamp")
    jq -n \
      --arg c "$sev_color" \
      --arg t "$slack_text" \
      --arg fb "$emoji $SERVER_NAME — $title" \
      '{ "attachments": [{ "color": $c, "fallback": $fb, "blocks": [
          { "type": "section", "text": { "type": "mrkdwn", "text": $t } }
        ]}]}' \
    | curl -sf -X POST -H 'Content-Type: application/json' \
        -d @- "$SLACK_WEBHOOK_URL" > /dev/null 2>&1 || true
  fi
}

# Common button sets
BTN_FIX_STATUS='[[{"text":"🔧 Smart Fix","callback_data":"perch:fix"},{"text":"📊 Status","callback_data":"perch:status"}],[{"text":"🔇 Mute 1h","callback_data":"perch:mute_1h"},{"text":"✅ Ack","callback_data":"perch:ack"}]]'
BTN_NGINX='[[{"text":"🌐 Restart nginx","callback_data":"perch:fix-nginx"},{"text":"📋 Logs","callback_data":"perch:logs-nginx"}],[{"text":"✅ Ack","callback_data":"perch:ack"}]]'
BTN_DISK='[[{"text":"🧹 Clear logs","callback_data":"perch:clear-logs"},{"text":"💾 Show disk","callback_data":"perch:disk"}],[{"text":"✅ Ack","callback_data":"perch:ack"}]]'
BTN_RAM='[[{"text":"🔧 Smart Fix","callback_data":"perch:fix"},{"text":"📊 Top Procs","callback_data":"perch:top-procs"}],[{"text":"✅ Ack","callback_data":"perch:ack"}]]'
BTN_PHP='[[{"text":"🔄 Restart PHP-FPM","callback_data":"perch:fix-php-fpm"},{"text":"📋 PHP errors","callback_data":"perch:logs-php"}],[{"text":"✅ Ack","callback_data":"perch:ack"}]]'
BTN_DB='[[{"text":"🔄 Restart MySQL","callback_data":"perch:fix-mysql"},{"text":"📊 Status","callback_data":"perch:status"}],[{"text":"✅ Ack","callback_data":"perch:ack"}]]'
BTN_SSL='[[{"text":"🔄 Renew SSL","callback_data":"perch:renew-ssl"},{"text":"📋 SSL Status","callback_data":"perch:ssl-status"}],[{"text":"✅ Ack","callback_data":"perch:ack"}]]'
BTN_ACK='[[{"text":"✅ Acknowledge","callback_data":"perch:ack"}]]'

# ────────────────────────────────────────────────────────────────────────────────
# RULE 1 — nginx / nginx-rc service down
# ────────────────────────────────────────────────────────────────────────────────

rule_nginx() {
  local status; status="$(systemctl is-active "$NGINX_SVC" 2>/dev/null)"; status="${status:-unknown}"
  if [ "$status" != "active" ]; then
    local error_summary=""
    if [ -f /var/log/nginx-rc/error.log ]; then
      error_summary="$(tail -3 /var/log/nginx-rc/error.log 2>/dev/null | head -200)"
    elif [ -f /var/log/nginx/error.log ]; then
      error_summary="$(tail -3 /var/log/nginx/error.log 2>/dev/null | head -200)"
    fi

    local body="${NGINX_SVC} is currently *${status}*.
Websites on this server may be unreachable."
    [ -n "$error_summary" ] && body="${body}

Last errors:
\`\`\`
${error_summary}
\`\`\`"

    send_alert "nginx_down" "critical" "Web server is down" "$body" "$BTN_NGINX"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 2 — PHP-FPM service(s) down
# ────────────────────────────────────────────────────────────────────────────────

rule_php_fpm() {
  local down_services=()
  while IFS= read -r unit; do
    [ -z "$unit" ] && continue
    local status; status="$(systemctl is-active "$unit" 2>/dev/null)"
    [ "$status" != "active" ] && [ "$status" != "" ] && down_services+=("$unit:$status")
  done < <(systemctl list-units --all --plain --no-legend 2>/dev/null \
            | awk '/php[0-9]+-fpm(-rc)?\.service/{print $1}')

  if [ ${#down_services[@]} -gt 0 ]; then
    local listing
    listing="$(printf -- '- %s\n' "${down_services[@]}")"
    send_alert "php_fpm_down" "critical" "PHP-FPM is down" \
      "PHP-FPM service(s) are not running:\n${listing}\n\nWordPress and PHP sites cannot serve requests." \
      "$BTN_PHP"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 3 — MySQL / MariaDB down
# ────────────────────────────────────────────────────────────────────────────────

rule_database() {
  local svc=""
  for s in mysql mariadb; do
    if systemctl list-units --all 2>/dev/null | grep -q " ${s}\."; then
      svc="$s"; break
    fi
  done
  [ -z "$svc" ] && return 0

  local status; status="$(systemctl is-active "$svc" 2>/dev/null)"
  if [ "$status" != "active" ]; then
    send_alert "mysql_down" "critical" "Database is down" \
      "${svc} is *${status}*. WordPress, Laravel, and any DB-backed site cannot run.\n\nThis often happens after an out-of-memory event. I can restart it for you." \
      "$BTN_DB"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 4 — Disk usage tiered (warn → high → critical)
# ────────────────────────────────────────────────────────────────────────────────

rule_disk() {
  local pct used total
  pct="$(df / | awk 'NR==2{gsub(/%/,""); print $5}')"
  used="$(df -h / | awk 'NR==2{print $3}')"
  total="$(df -h / | awk 'NR==2{print $2}')"

  if [ "$pct" -ge "$RULE_DISK_CRIT" ]; then
    local top
    top="$(du -sh /home/* /var/log /tmp 2>/dev/null | sort -rh | head -5 | awk '{printf "  %s  %s\n",$1,$2}')"
    send_alert "disk_critical" "critical" "Disk almost full ($pct%)" \
      "$used / $total used. Sites will start failing soon — log writes fail, MySQL can't write, uploads break.\n\nTop offenders:\n\`\`\`\n${top}\n\`\`\`" \
      "$BTN_DISK"
  elif [ "$pct" -ge "$RULE_DISK_HIGH" ]; then
    send_alert "disk_high" "warning" "Disk getting full ($pct%)" \
      "$used / $total used. Time to clean up old logs and rotate backups." \
      "$BTN_DISK"
  elif [ "$pct" -ge "$RULE_DISK_WARN" ]; then
    send_alert "disk_warn" "info" "Disk usage rising ($pct%)" \
      "$used / $total used. Just keeping an eye on this — no action needed yet." \
      "$BTN_ACK"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 5 — RAM usage tiered
# ────────────────────────────────────────────────────────────────────────────────

rule_ram() {
  local total used pct
  total="$(free -m | awk 'NR==2{print $2}')"
  used="$(free -m | awk 'NR==2{print $3}')"
  [ "$total" -le 0 ] && return 0
  pct=$((used * 100 / total))

  if [ "$pct" -ge "$RULE_RAM_CRIT" ]; then
    local top
    top="$(ps -eo rss,comm --sort=-rss 2>/dev/null | head -6 | tail -5 \
            | awk '{printf "  %dMB  %s\n",$1/1024,$2}')"
    send_alert "ram_critical" "critical" "Memory critical ($pct%)" \
      "${used}MB / ${total}MB used. The kernel is about to start killing processes (OOM).\n\nTop consumers:\n\`\`\`\n${top}\n\`\`\`" \
      "$BTN_RAM"
  elif [ "$pct" -ge "$RULE_RAM_WARN" ]; then
    send_alert "ram_warn" "warning" "Memory pressure ($pct%)" \
      "${used}MB / ${total}MB used. Consider restarting heavy processes (PHP-FPM, PM2)." \
      "$BTN_RAM"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 6 — CPU sustained high load
# ────────────────────────────────────────────────────────────────────────────────

rule_cpu_load() {
  local load1 cores pct
  load1="$(awk '{print $1}' /proc/loadavg)"
  cores="$(nproc)"
  [ "$cores" -le 0 ] && cores=1
  pct="$(awk "BEGIN{printf \"%d\", ($load1 / $cores) * 100}")"

  if [ "$pct" -ge "$RULE_LOAD_PCT_CRIT" ]; then
    local top_cpu
    top_cpu="$(ps -eo pcpu,comm --sort=-pcpu 2>/dev/null | head -6 | tail -5 \
                | awk '{printf "  %s%%  %s\n",$1,$2}')"
    send_alert "cpu_critical" "critical" "CPU overloaded ($pct%)" \
      "Load average $load1 with only $cores core(s).\n\nTop processes:\n\`\`\`\n${top_cpu}\n\`\`\`" \
      "$BTN_FIX_STATUS"
  elif [ "$pct" -ge "$RULE_LOAD_PCT_WARN" ]; then
    send_alert "cpu_warn" "warning" "CPU under load ($pct%)" \
      "Load average $load1 across $cores core(s). Could be a traffic spike or runaway process." \
      "$BTN_FIX_STATUS"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 7 — Orphan processes (PPID=1)
# ────────────────────────────────────────────────────────────────────────────────

rule_orphans() {
  local count
  count="$(ps -eo ppid,comm 2>/dev/null \
           | awk '$1==1 && $2!="init" && $2!="systemd" && $2!="(sd-pam)" && $2!="dbus-daemon"' \
           | wc -l | tr -d ' ')"

  if [ "$count" -gt "$RULE_ORPHAN_WARN" ]; then
    send_alert "orphans" "warning" "Orphan processes: $count" \
      "$count processes are reparented to PID 1. Usually safe to kill — they're often crashed/abandoned children." \
      "$BTN_FIX_STATUS"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 8 — Failed systemd services
# ────────────────────────────────────────────────────────────────────────────────

rule_failed_services() {
  local failed
  failed="$(systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}' | head -10)"
  if [ -n "$failed" ]; then
    local list; list="$(printf -- '- %s\n' $failed)"
    send_alert "failed_svc" "warning" "Failed services" \
      "These systemd units are in a failed state:\n\`\`\`\n${list}\n\`\`\`" \
      "$BTN_FIX_STATUS"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 9 — SSL certificate expiry per site
# ────────────────────────────────────────────────────────────────────────────────

rule_ssl_expiry() {
  [ -z "$MONITOR_SITES" ] && return 0
  command -v openssl >/dev/null 2>&1 || return 0
  IFS=',' read -ra SITES <<< "$MONITOR_SITES"

  local now_epoch; now_epoch="$(date +%s)"
  for raw in "${SITES[@]}"; do
    local site; site="$(echo "$raw" | tr -d ' ')"
    [ -z "$site" ] && continue
    local end_date
    end_date="$(echo | timeout 10 openssl s_client -servername "$site" -connect "$site:443" 2>/dev/null \
                  | openssl x509 -noout -enddate 2>/dev/null \
                  | sed 's/notAfter=//')"
    [ -z "$end_date" ] && continue
    local end_epoch; end_epoch="$(date -d "$end_date" +%s 2>/dev/null || echo 0)"
    [ "$end_epoch" = 0 ] && continue
    local days_left=$(( (end_epoch - now_epoch) / 86400 ))

    if [ "$days_left" -le "$RULE_SSL_DAYS_CRIT" ]; then
      send_alert "ssl_${site}" "critical" "SSL expiring soon: $site" \
        "Certificate for *${site}* expires in *${days_left} day(s)*. Browser warnings will start showing." \
        "$BTN_SSL"
    elif [ "$days_left" -le "$RULE_SSL_DAYS_WARN" ]; then
      send_alert "ssl_${site}_warn" "warning" "SSL renewal due: $site" \
        "Certificate for ${site} expires in ${days_left} days. Time to renew." \
        "$BTN_SSL"
    fi
  done
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 10 — Site HTTP availability (5xx / unreachable)
# ────────────────────────────────────────────────────────────────────────────────

rule_http_availability() {
  [ -z "$MONITOR_SITES" ] && return 0
  IFS=',' read -ra SITES <<< "$MONITOR_SITES"

  for raw in "${SITES[@]}"; do
    local site; site="$(echo "$raw" | tr -d ' ')"
    [ -z "$site" ] && continue
    local code
    code="$(curl -sk -o /dev/null --max-time 15 -w '%{http_code}' "https://${site}/" 2>/dev/null \
            || curl -s -o /dev/null --max-time 15 -w '%{http_code}' "http://${site}/" 2>/dev/null \
            || echo 0)"

    if [ "$code" = "0" ]; then
      send_alert "http_${site}" "critical" "Site unreachable: $site" \
        "Could not connect to https://${site}/ or http://${site}/. DNS, firewall, or web server may be down." \
        "$BTN_NGINX"
    elif [ "$code" -ge 500 ] && [ "$code" -lt 600 ]; then
      send_alert "http_${site}_${code}" "critical" "Site returning $code: $site" \
        "https://${site}/ returns HTTP $code.\n\nLikely cause: PHP fatal error, plugin conflict, or stack overflow. I can pull the error log for you." \
        "$BTN_PHP"
    fi
  done
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 11 — Custom port checks (CSV of TCP ports)
# ────────────────────────────────────────────────────────────────────────────────

rule_custom_ports() {
  [ -z "$MONITOR_PORTS" ] && return 0
  command -v nc >/dev/null 2>&1 || return 0
  IFS=',' read -ra PORTS <<< "$MONITOR_PORTS"
  local down=()

  for raw in "${PORTS[@]}"; do
    local port; port="$(echo "$raw" | tr -d ' ')"
    [ -z "$port" ] && continue
    nc -z 127.0.0.1 "$port" 2>/dev/null || down+=("$port")
  done

  if [ ${#down[@]} -gt 0 ]; then
    local list; list="$(printf -- '- 127.0.0.1:%s\n' "${down[@]}")"
    send_alert "ports_down" "warning" "Custom ports unreachable" \
      "These ports are not listening on localhost:\n\`\`\`\n${list}\n\`\`\`\nApps bound to these ports may have crashed." \
      "$BTN_FIX_STATUS"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 12 — fail2ban ban-rate spike
# ────────────────────────────────────────────────────────────────────────────────

rule_fail2ban_spike() {
  command -v fail2ban-client >/dev/null 2>&1 || return 0
  systemctl is-active fail2ban &>/dev/null || return 0

  local since="1 hour ago"
  local bans
  bans=$(journalctl -u fail2ban --since "$since" --no-pager 2>/dev/null | grep -c ' Ban ' 2>/dev/null || true)
  # Defensive: command-substitution quirks under cron can leave multi-line / whitespace residue here.
  bans="${bans//[^0-9]/}"
  bans="${bans:-0}"
  local rate; rate="${RULE_FAIL2BAN_BAN_RATE//[^0-9]/}"; rate="${rate:-50}"
  if [ "$bans" -gt "$rate" ]; then
    send_alert "fail2ban_spike" "warning" "Brute force surge" \
      "fail2ban banned *${bans}* IP(s) in the last hour. You may be under a brute-force or scanner sweep.\n\nIf this is sustained, consider tightening rate limits or enabling additional jails." \
      "$BTN_ACK"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 13 — Backup age (RunCloud backup logs)
# ────────────────────────────────────────────────────────────────────────────────

rule_backup_age() {
  local newest=0
  shopt -s nullglob
  for log in /var/log/runcloud/backup* /home/*/logs/backup*; do
    [ ! -f "$log" ] && continue
    local mtime; mtime="$(stat -c %Y "$log" 2>/dev/null || echo 0)"
    [ "$mtime" -gt "$newest" ] && newest="$mtime"
  done
  shopt -u nullglob

  [ "$newest" -eq 0 ] && return 0  # no backup logs found at all → silent
  local now hours
  now="$(date +%s)"
  hours=$(( (now - newest) / 3600 ))
  if [ "$hours" -gt 36 ]; then
    send_alert "backup_stale" "warning" "Backup may be stalled" \
      "No fresh backup activity detected in the last *${hours}h*. Last RunCloud backup log was $hours hours ago. Check the backup destination is reachable." \
      "$BTN_ACK"
  fi
}

# ────────────────────────────────────────────────────────────────────────────────
# RULE 14 — Heartbeat (daily proof-of-life summary, 09:00 local)
# ────────────────────────────────────────────────────────────────────────────────

rule_heartbeat() {
  [ "${RULE_HEARTBEAT:-on}" != "on" ] && return 0
  local hour minute
  hour="$(TZ="$TZ_NAME" date +%H)"
  minute="$(TZ="$TZ_NAME" date +%M)"
  # Only fire between 09:00 and 09:09 local
  [ "$hour" != "09" ] && return 0
  [ "$minute" -gt 9 ] && return 0

  local stamp
  stamp="$STATE_DIR/heartbeat_$(TZ="$TZ_NAME" date +%Y%m%d)"
  [ -f "$stamp" ] && return 0
  touch "$stamp"

  local total used pct disk_pct load1 cores ngx
  total="$(free -m | awk 'NR==2{print $2}')"
  used="$(free -m  | awk 'NR==2{print $3}')"
  pct=$((used * 100 / (total > 0 ? total : 1)))
  disk_pct="$(df / | awk 'NR==2{gsub(/%/,""); print $5}')"
  load1="$(awk '{print $1}' /proc/loadavg)"
  cores="$(nproc)"
  ngx="$(systemctl is-active "$NGINX_SVC" 2>/dev/null || echo unknown)"

  send_alert "heartbeat_$(date +%Y%m%d)" "info" "Daily check-in" \
    "All systems good 🪶\n\n• RAM ${pct}% (${used}MB/${total}MB)\n• Disk ${disk_pct}%\n• Load ${load1} on ${cores} core(s)\n• ${NGINX_SVC}: ${ngx}" \
    "$BTN_ACK"
}

# ── Run all rules ─────────────────────────────────────────────────────────────

rule_nginx
rule_php_fpm
rule_database
rule_disk
rule_ram
rule_cpu_load
rule_orphans
rule_failed_services
rule_ssl_expiry
rule_http_availability
rule_custom_ports
rule_fail2ban_spike
rule_backup_age
rule_heartbeat

exit 0
