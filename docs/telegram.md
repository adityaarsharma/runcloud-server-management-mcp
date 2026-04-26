# Telegram bot setup

The Telegram bot is Perch's pager. It watches your server, posts alerts with tap-to-fix buttons, and lets you run safe operations without ever opening a terminal.

## What the bot does

- Pushes alerts when `monitor.sh` spots trouble (high load, failed services, disk pressure, SSL nearing expiry)
- Renders inline keyboards so common fixes are one tap away
- Runs a small set of whitelisted operations through a localhost-only fix-server
- Holds a quiet-hours mute so 3am noise doesn't wake the household for a non-issue
- Does not require SSH access for non-developers — designers and account leads can be in the chat without server keys

It's a polling bot, not a webhook bot. That means no public URL, no inbound firewall rules — it dials Telegram out, not the other way around.

## Creating the bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Pick a name (`Acme Servers Bot`) and a username (`acme_servers_bot`)
4. Save the token BotFather hands back — it looks like `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`
5. Optional: `/setdescription`, `/setuserpic`, `/setcommands` to make it look intentional

## Getting your chat ID

Create a chat (DM or group), then ask Telegram who it is.

**Easiest:** Open [@userinfobot](https://t.me/userinfobot) and forward any message from the chat. It replies with the ID.

**Group chats:** Add [@RawDataBot](https://t.me/RawDataBot) to the group, send any message, copy the `chat.id` field. It will be a negative number, e.g. `-1001234567890`.

**Verification:** From the server, run

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

Send a message in the chat first; you'll see the chat object in the response.

## Configuring `.env`

`telegram-bot/setup.sh` writes this file. Here's the full reference:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | From @BotFather |
| `TELEGRAM_CHAT_ID` | yes | — | DM ID or group ID (negative) |
| `FIX_SERVER_URL` | yes | `http://127.0.0.1:3011` | Where bot.py talks to fix-server.py |
| `FIX_SERVER_TOKEN` | yes | — | Random 32+ char string, must match on both sides |
| `FIX_SERVER_PORT` | no | `3011` | Change if port is taken |
| `FIX_SERVER_HOST` | no | `127.0.0.1` | Leave as localhost — see Security below |
| `LOG_LEVEL` | no | `INFO` | `DEBUG` for troubleshooting |
| `MUTE_FILE` | no | `/tmp/perch.muted` | Where mute state lives |

## The fix-server architecture

`fix-server.py` is a tiny HTTP service running locally on the server. Only `bot.py` talks to it, and both processes live on the same box.

Why bother with HTTP at all? Two reasons. First, the bot runs as the unprivileged `runcloud` user; the fix scripts need to call `sudo` for narrow, whitelisted commands. Splitting the layers means the bot never holds elevated privileges directly. Second, it gives you one clear surface to audit and test.

It binds to `127.0.0.1` only. Never to `0.0.0.0`. Never expose port 3011 publicly.

Endpoints, all `POST` and all bearer-token authenticated:

| Endpoint | What it runs |
|---|---|
| `/status` | `scripts/check-status.sh` — full server card |
| `/status-brief` | One-line summary for inline taps |
| `/fix` | `scripts/smart-fix.sh` — pick the right fix for the alert |
| `/fix-nginx` | `scripts/fix-nginx.sh` — restart nginx-rc safely |
| `/fix-php-fpm` | `scripts/fix-php-fpm.sh` — restart any failed PHP-FPM service |
| `/fix-mysql` | `scripts/fix-mysql.sh` — restart MySQL/MariaDB with OOM context |
| `/fix-services` | Restart common stuck services (php-fpm, redis, etc.) |
| `/fix-n8n` | optional — restart n8n if you happen to run it |
| `/top-procs` | `scripts/top-procs.sh` — top 10 processes by RAM and CPU |
| `/disk` | Disk usage breakdown, biggest offenders |
| `/clear-logs` | Truncate large log files (never delete) |
| `/check-ports` | List listening ports and their owners |
| `/logs-nginx` | `scripts/logs-nginx.sh` — recent nginx errors with summary |
| `/logs-php` | `scripts/logs-php.sh` — PHP errors across versions + WP debug.log |
| `/ssl-status` | `scripts/ssl-status.sh` — SSL expiry per monitored site |
| `/renew-ssl` | `scripts/renew-ssl.sh` — certbot renew + nginx reload |

Every call needs `Authorization: Bearer $FIX_SERVER_TOKEN`. Mismatched tokens return 401.

## Bot commands

| Command | What it does | Underlying script |
|---|---|---|
| `/status` | Full server health card | `check-status.sh` |
| `/disk` | Disk usage and top offenders | fix-server `/disk` |
| `/ports` | Listening ports table | `/check-ports` |
| `/fix` | Pick a fix from a button menu | router |
| `/nginx` | Restart nginx-rc | `fix-nginx.sh` |
| `/phpfpm` | Restart PHP-FPM (any version) | `fix-php-fpm.sh` |
| `/mysql` | Restart MySQL / MariaDB | `fix-mysql.sh` |
| `/services` | Restart all common services | `fix-services.sh` |
| `/n8n` | Restart n8n if you run it | `fix-n8n.sh` |
| `/top` | Top 10 processes | `top-procs.sh` |
| `/lognginx` | nginx error log + summary | `logs-nginx.sh` |
| `/logphp` | PHP error log + top errors | `logs-php.sh` |
| `/ssl` | SSL expiry per site | `ssl-status.sh` |
| `/renewssl` | Run certbot renew | `renew-ssl.sh` |
| `/clearlogs` | Truncate log files >50MB | `/clear-logs` |
| `/mute 2h` | Silence alerts for 2 hours | mute file |
| `/unmute` | Resume alerts | mute file |
| `/reboot` | Confirm-then-reboot the box | `sudo reboot` |
| `/help` | List commands | inline |

## Inline buttons

When `monitor.sh` detects an issue, the alert message ships with a button row. The button text and the `callback_data` map to fix-server endpoints:

```
[Fix nginx]  -> callback_data = "fix:nginx"   -> POST /fix-nginx
[Restart PHP]-> callback_data = "fix:php"     -> POST /fix-services?svc=php-fpm
[Status]     -> callback_data = "status:full" -> POST /status
[Mute 2h]    -> callback_data = "mute:2h"     -> writes mute file
```

The bot edits the original message in place to show "Working..." while the call runs, then replaces it with the result. No new spam in the chat.

## Mute and unmute

Use `/mute 2h` for two hours, `/mute 30m` for thirty minutes, `/mute 1d` for a day.

```
/mute 2h
> Muted until 14:32 UTC. /unmute to resume.
```

The mute state is a tiny file at `/tmp/perch.muted` with an expiry timestamp. It lives in `/tmp` deliberately — a server reboot clears it, so a muted-and-forgotten state can never silence a fresh boot. `monitor.sh` checks the file on every run and skips outbound alerts if it's still active. Status commands always work, mute or not.

## The reboot flow

`/reboot` is the one command that takes a confirm step:

```
/reboot
> About to reboot the server. This will drop all connections.
> Tap CONFIRM within 60 seconds.
> [CONFIRM] [Cancel]
```

Tapping CONFIRM calls `subprocess.run(['sudo', 'reboot'])`. After 60 seconds the buttons stop responding and you have to issue `/reboot` again. There's no "schedule reboot" — if you want delay, sleep first then reboot.

## Running as a systemd service

`setup.sh` can install this for you, or drop it in by hand at `/etc/systemd/system/perch-bot.service`:

```ini
[Unit]
Description=Perch Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=runcloud
WorkingDirectory=/home/runcloud/perch/telegram-bot
EnvironmentFile=/home/runcloud/perch/telegram-bot/.env
ExecStart=/home/runcloud/perch/telegram-bot/.venv/bin/python3 bot.py
Restart=always
RestartSec=5
StandardOutput=append:/var/log/perch-bot.log
StandardError=append:/var/log/perch-bot.log

[Install]
WantedBy=multi-user.target
```

A matching `perch-fix-server.service` runs `fix-server.py` the same way. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now perch-bot perch-fix-server
sudo journalctl -u perch-bot -f
```

## Multi-server setups

The simple model is one bot per server. Each server has its own bot username, its own token, and its own chat. Alerts make it instantly clear which box is talking.

The advanced model is one bot for many servers via SSH. The bot runs on a control host, holds an SSH key for each managed server, and routes commands by chat. This is more work to set up and harder to keep secure — start with one-bot-per-server and only consolidate when you have ten-plus boxes.

## Group chats vs DMs

For solo operators, a DM is fine. For agencies, use a group:

- Add the bot to the group
- Promote it to admin if you want it to delete its own messages cleanly
- Use the negative chat ID (e.g. `-1001234567890`)
- Anyone in the group can tap buttons — set the bot's privacy mode in @BotFather to control whether it reads non-command messages

## Alerts from `monitor.sh`

`scripts/monitor.sh` runs every 10 minutes via cron:

```
*/10 * * * * /home/runcloud/perch/telegram-bot/scripts/monitor.sh
```

Each run:

1. Calls `check-status.sh` to gather metrics
2. Compares against thresholds in `monitor.conf`
3. If something's wrong and the mute file isn't active, POSTs an alert payload to the bot's internal endpoint
4. The bot formats the alert and ships it with the right button row

To tune thresholds, edit `telegram-bot/monitor.conf`:

```
LOAD_THRESHOLD=4.0
DISK_WARN=80
DISK_CRIT=90
SSL_DAYS_WARN=14
```

## Security

- The bot token is loaded from `.env` and never logged. Errors redact it.
- The chat_id whitelist is enforced in `bot.py` — messages from any other chat are silently ignored.
- The fix-server binds to `127.0.0.1` only. Confirm with `ss -lntp | grep 3011`.
- The fix-server token is required on every call. A wrong token returns 401 and is logged.
- Shell parameters from button taps go through `validatePath`, `validateServiceName`, and `shellEscape` before reaching the script layer.
- Never expose port 3011 externally. There is no reason to.

## Common issues

**Bot doesn't respond at all.** Check the token and that the network can reach `api.telegram.org`:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"
```

A 200 with `"ok": true` means the token is good. If that works but the bot is still silent, it's the chat_id.

**Buttons spin forever.** The fix-server is down or the tokens don't match.

```bash
sudo systemctl status perch-fix-server
curl -s -X POST http://127.0.0.1:3011/status-brief \
  -H "Authorization: Bearer $FIX_SERVER_TOKEN"
```

**`Conflict: terminated by other getUpdates request`.** Two processes are polling the same bot token. Find and stop the duplicate:

```bash
ps aux | grep bot.py
sudo systemctl restart perch-bot
```

**Alerts never arrive even when load is high.** Check the mute file and the cron:

```bash
cat /tmp/perch.muted 2>/dev/null
crontab -l | grep monitor.sh
```

## Next steps

- [safety.md](./safety.md) — exactly what the bot will and won't do without a confirm
- [runcloud.md](../runcloud.md) — RunCloud-specific behaviours and webapp context
- [slack.md](./slack.md) — mirror or replace Telegram with Slack
