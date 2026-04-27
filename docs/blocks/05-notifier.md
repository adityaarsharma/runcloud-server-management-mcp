# Block 5 — Notifier (Telegram + Slack)

## Purpose

The user-facing chat surface. Receives alerts from Monitor (block 4),
exposes button + slash interactions, calls HTTP API (block 3) for fixes,
optionally uses LLM (block 6) for conversational mode.

Two channels:
- **Telegram** — full bot (polling, callbacks, slash commands)
- **Slack** — currently webhook-only mirror; full app pending (C.1)

## Files

- `telegram-bot/bot.py` — Python polling bot (414 lines)
- `telegram-bot/fix-server.py` — local action executor (port 3011), called
  by bot.py + monitor.sh button callbacks
- `telegram-bot/.env` — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `SLACK_WEBHOOK_URL` (optional), `FIX_SERVER_TOKEN`
- `src/core/gateway.ts` — `formatTelegramAlert`, `formatSlackAlert`,
  `buildButtons`, `severityEmoji`

## Current state

### Telegram (bundled bot.py)
- ✅ Polling loop with `chat_id` whitelist
- ✅ Full button keyboard: status, fix, fix-nginx, fix-php-fpm, fix-mysql,
  fix-services, ports, disk, clear-logs, logs-nginx, logs-php, ssl-status,
  renew-ssl, top-procs
- ✅ Slash commands: `/help`, `/test`, `/mute`, `/unmute`, `/reboot` (with
  confirm flow)
- ✅ Mute file shared with monitor.sh (`/tmp/perch-monitor-muted`)
- ✅ `perch:ack` callback handler (added today)
- ❌ **No LLM — bot.py is command-driven only** (Niyati has it; needs backport)
- ❌ Reboot is the only confirm-flow; other writes don't have it

### Slack
- ✅ One-way webhook mirror — set `SLACK_WEBHOOK_URL` in `.env`, alerts
  post in parallel with Telegram
- ✅ Block Kit formatting with severity color
- ❌ No interactive buttons (webhook can't receive callbacks)
- ❌ No slash commands

## Gaps (toward vision)

- [ ] Backport Niyati's Gemini intent routing into `bot.py` as **optional**
  (BYOK) — biggest leverage move, gives public users conversational mode
- [ ] Slack interactive app (full bot, slash commands, buttons) — C.1
- [ ] Multi-user / team roles (vision V2)
- [ ] Per-channel scoping (`#client-acme` only sees Acme servers) — V2
- [ ] Discord/Mattermost adapter (V2)

## Next ship task

**Pull Niyati's Gemini intent gate + tool router into a standalone
`telegram-bot/llm.py`** (block 6 actually owns this — see that doc).
Then in `bot.py`'s `handle_message`, BEFORE the unknown-command fall-through,
call `llm.route_intent(text)` if `GEMINI_API_KEY` is set. ~3h with block 6.

## Boundaries

- Notifier never shells out directly — every action goes through fix-server
  (port 3011) or HTTP API (port 3013).
- Notifier writes the mute file; Monitor reads it. That's the only file
  shared between them.
- DESTRUCTIVE_RE-equivalent guard runs at the top of every Telegram message
  in `handle_message` — block any "rm -rf" / "shutdown" / "wipe" patterns
  before reaching tool dispatch.
