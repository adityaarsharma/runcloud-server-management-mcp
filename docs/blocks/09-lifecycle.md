# Block 9 — Lifecycle Module

## Purpose

Bootstrap and maintenance of a Perch deployment: install, configure, update,
self-update, vault rotation, uninstall. The "first 5 minutes" UX matters
most here — it's what determines whether someone actually finishes setting
Perch up.

## Files

- `scripts/install.sh` — fresh-install bootstrapper
- `scripts/full-deploy.sh` — opinionated end-to-end deploy
- `scripts/update.sh` — pull + rebuild + restart
- `scripts/uninstall.sh` — clean teardown
- `scripts/perch-vault.ts` — vault CLI (block 2)
- `scripts/import-runcloud-servers.ts` — RunCloud bootstrap (block 7)
- `scripts/seed-from-server.ts` — seed Brain from local filesystem
- HTTP API tool: `perch_self_update` — git pull + rebuild + systemctl
  restart, callable from chat

## Current state

- ✅ install.sh exists and runs
- ✅ full-deploy.sh tested on Aditya's hetzner box
- ✅ update.sh works (`git pull` + `npm run build` + `systemctl restart
  perch-api`)
- ✅ vault rotation (`npm run vault rotate`)
- ✅ `perch_self_update` callable from MCP / HTTP API
- ⚠️ install.sh asks for: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `RUNCLOUD_API_TOKEN`, `FIX_SERVER_TOKEN` — does NOT yet ask for
  `GEMINI_API_KEY` (block 6)
- ❌ No idempotency guard — running install.sh twice can stomp `.env`
- ❌ No "first run" health check that confirms each block is alive

## Gaps (toward vision)

- [ ] Setup wizard adds `GEMINI_API_KEY` prompt (block 6 dependency)
- [ ] `perch doctor` command — check each block's health, print a status
  card
- [ ] Idempotent install (detect existing `.env`, ask before overwriting)
- [ ] Auto-detect existing RunCloud installation vs greenfield
- [ ] One-line install: `curl -fsSL perch.adityaarsharma.com/install | bash`
- [ ] Claude Code one-shot: `claude /plugin install runcloud-server`
- [ ] Update changelogs surfaced via Telegram on `perch_self_update` success

## Next ship task

**Add `perch doctor`** — a script that runs through each block and reports:

- Brain (block 1): `~/.perch/brain.db` exists, schema migrated, last
  problem logged
- Vault (block 2): `vault.json` valid, key derives, N entries
- HTTP API (block 3): GET /health returns 200, GET /api/tools lists 20+
  tools
- Monitor (block 4): cron entry present, last run < 6 min ago, no muted
- Notifier (block 5): bot.py PM2 status, last poll < 60s ago
- LLM (block 6): GEMINI_API_KEY set? if yes, test call returns YES
- RunCloud (block 7): RUNCLOUD_API_TOKEN in vault, API reachable
- WP (block 8): each registered webapp's wp-config.php readable

One script, prints a 10-row status table. ~2h. Massive UX win.

## Boundaries

- Lifecycle scripts ONLY mutate `~/.perch/`, the systemd service files,
  and the cron entry. Nothing outside.
- `uninstall.sh` is reversible up to the vault — vault.json gets a
  timestamped backup before removal.
