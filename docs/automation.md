# Automation Rules

Perch's automation lives in one self-contained shell script: `telegram-bot/monitor.sh`. It runs every 5 minutes via cron, evaluates 14 rules, and sends friendly Telegram alerts (and Slack alerts if a webhook is configured) with one-tap action buttons.

No n8n. No Zapier. No SaaS dependency. The whole automation engine is ~400 lines of POSIX-friendly shell that lives on your server and works without an internet connection (except for sending alerts to Telegram, obviously).

---

## How it works

```
cron (every 5 min)
   ↓
monitor.sh
   ↓
   Reads ~/.perch/.env for thresholds + tokens
   ↓
   Runs 14 rules sequentially
   ↓
   For each rule that triggers:
      ↓
      Check cooldown (default 30 min between repeat alerts)
      ↓
      Format friendly message with severity emoji
      ↓
      Send Telegram alert with inline action buttons
```

Each rule is a bash function. Adding a new rule means adding a function and calling it at the bottom of the script — no framework, no plugin system, no learning curve.

---

## The 14 Rules

| # | Rule | Severity | Default Threshold | Trigger Action |
|---|------|----------|-------------------|---------------|
| 1 | nginx / nginx-rc down | 🔴 critical | service inactive | Restart button |
| 2 | PHP-FPM down (any version) | 🔴 critical | any php\*-fpm-rc inactive | Restart PHP-FPM button |
| 3 | MySQL / MariaDB down | 🔴 critical | service inactive | Restart MySQL button |
| 4 | Disk tiered | ℹ️ → ⚠️ → 🔴 | 80% / 90% / 95% | Clear logs button |
| 5 | RAM tiered | ⚠️ → 🔴 | 85% / 93% | Top procs / Smart fix |
| 6 | CPU sustained load | ⚠️ → 🔴 | 100% / 200% of cores | Top procs |
| 7 | Orphan processes (PPID=1) | ⚠️ warning | >10 orphans | Smart fix |
| 8 | Failed systemd services | ⚠️ warning | any in `systemctl --failed` | Smart fix |
| 9 | SSL expiry (per site) | ⚠️ → 🔴 | 30 / 7 days remaining | Renew SSL |
| 10 | Site HTTP availability | 🔴 critical | 5xx or unreachable | nginx / PHP buttons |
| 11 | Custom ports unreachable | ⚠️ warning | any configured port closed | Smart fix |
| 12 | fail2ban ban-rate spike | ⚠️ warning | >50 bans/hour | Acknowledge |
| 13 | Backup age | ⚠️ warning | >36h since last backup log | Acknowledge |
| 14 | Daily heartbeat | ℹ️ info | 09:00 local time daily | None |

Every threshold is overridable in `~/.perch/.env`.

---

## Configuration

All settings live in `~/.perch/.env`. Defaults are in parentheses.

### Required for alerts
```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### Optional — Telegram fix-server
```bash
FIX_SERVER_URL=http://127.0.0.1:3011    # Where action buttons send POST
FIX_SERVER_TOKEN=...                     # Bearer auth for fix-server
```

### Optional — Slack mirror
```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

### Server identity
```bash
MONITOR_SERVER_NAME=production-1         # (hostname -s)
MONITOR_TIMEZONE=Asia/Kolkata            # (UTC)
NGINX_SERVICE=auto                        # auto | nginx | nginx-rc
```

### Monitor state
```bash
MONITOR_STATE_DIR=/tmp/perch-monitor      # where cooldown state is kept
RULE_COOLDOWN=1800                         # seconds between repeat alerts
```

### Per-rule thresholds
```bash
RULE_RAM_WARN=85          # %
RULE_RAM_CRIT=93          # %

RULE_DISK_WARN=80         # %  (info)
RULE_DISK_HIGH=90         # %  (warning)
RULE_DISK_CRIT=95         # %  (critical)

RULE_LOAD_PCT_WARN=100    # % of nproc cores
RULE_LOAD_PCT_CRIT=200    # %

RULE_ORPHAN_WARN=10       # number of orphan procs

RULE_SSL_DAYS_WARN=30     # days remaining
RULE_SSL_DAYS_CRIT=7

RULE_FAIL2BAN_BAN_RATE=50 # bans/hour
```

### Site monitoring (rules 9, 10)
```bash
MONITOR_SITES=example.com,api.example.com,admin.example.com
```
Comma-separated domains. Used for HTTPS availability + SSL expiry checks.

### Custom ports (rule 11)
```bash
MONITOR_PORTS=3000,5678,8080
```
Comma-separated TCP ports — checked on `127.0.0.1` only.

### Daily heartbeat (rule 14)
```bash
RULE_HEARTBEAT=on    # on | off
```
A friendly "all systems good" message every morning at 09:00 in your `MONITOR_TIMEZONE`.

---

## Cooldown logic

Without cooldown, a flapping service would spam your Telegram. Perch's cooldown:

- Per-rule state file at `$MONITOR_STATE_DIR/<rule_id>`
- Stores `<md5_of_alert_body>:<unix_timestamp>`
- If the same alert (identical body hash) was sent within `RULE_COOLDOWN` seconds → skip
- If the alert body changes (e.g., a different file is now the disk hog), a new alert fires immediately

This means:
- Repeated identical issues → one alert per 30 min
- Issue changes → new alert immediately
- Issue resolves and re-occurs → new alert (cooldown only suppresses identical messages)

---

## Adding a custom rule

Open `telegram-bot/monitor.sh`, add a function, call it at the bottom:

```bash
rule_my_thing() {
  local value
  value="$(your_check_command)"
  if [ "$value" = "bad" ]; then
    send_alert "my_thing" "warning" "Custom thing is wrong" \
      "Body of the alert with markdown supported.\n\nDetails: $value" \
      "$BTN_ACK"
  fi
}

# At the bottom, alongside the other rules:
rule_my_thing
```

The signature for `send_alert` is:
```
send_alert <rule_id> <severity> <title> <body> <button_json>
```

- `rule_id`: stable string for cooldown tracking (e.g., `disk_critical`)
- `severity`: `info` / `warning` / `critical` — controls the emoji
- `title`: short headline
- `body`: full message body (Markdown OK)
- `button_json`: JSON array of inline_keyboard rows (or use a constant from the script: `$BTN_ACK`, `$BTN_DISK`, etc.)

---

## Disabling rules

Two ways:

1. Comment out the rule call at the bottom of `monitor.sh`:
   ```bash
   # rule_orphans   # I don't care about orphans
   ```

2. Set its threshold so high it never fires:
   ```bash
   RULE_ORPHAN_WARN=99999
   ```

---

## Testing rules manually

Run monitor.sh once from the command line to see what it would do:

```bash
cd /opt/perch
bash telegram-bot/monitor.sh

# Watch the cron log
tail -f /tmp/perch-monitor.log
```

Send a test alert without waiting for a real failure:

```bash
# In Telegram chat
/test
```

Trigger a specific rule to test cooldown:

```bash
# Force a high disk warning (only on a non-prod test machine!)
dd if=/dev/zero of=/tmp/big.bin bs=1M count=2000
bash telegram-bot/monitor.sh    # should fire disk_warn
bash telegram-bot/monitor.sh    # should NOT fire (cooldown)
rm /tmp/big.bin
```

---

## Why one big shell script vs. many small ones?

This is a deliberate Karpathy-style choice: simple correct mental model > clever framework.

- **One file = one thing to read.** Anyone can audit all 14 rules in ~5 minutes.
- **No framework lock-in.** Want to add a Python rule? Call it from the shell function. Want to migrate the whole engine? You're moving 400 lines, not a 5,000-line plugin system.
- **No runtime dependency on Node.js for monitoring.** If `npm install` ever breaks, your alerts still fire.
- **Fast.** A full 14-rule scan finishes in well under 2 seconds on a small VPS.
- **Cron-friendly.** No daemons, no reconnection logic, no state machines beyond per-rule cooldown files.

---

## Next steps

- [Telegram setup](./telegram.md) — wire the bot
- [Slack setup](./slack.md) — webhook alerts
- [Safety](./safety.md) — what Perch will and won't auto-fix
- [Master key](./master-key.md) — keep your vault safe
