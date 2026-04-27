# Block 3 — HTTP API + MCP

## Purpose

The single canonical action surface for Perch. Every other surface (Telegram
bot, Slack adapter, Claude Code, monitor.sh callbacks) calls these tools.
Two front doors, same backend:

- **HTTP API** — `POST /api/<tool>` on `127.0.0.1:3013`, Bearer auth
- **MCP** — stdio transport for Claude Code via `skills/perch/SKILL.md`

## Files

- `src/index.ts` — MCP server entry + tool definitions (~3,750 lines)
- `src/api/server.ts` — HTTP wrapper around the same handlers
- `~/.perch/.env` — `PERCH_API_TOKEN` for Bearer auth

## Current state

20 tools exposed, grouped:

- **Brain** (block 1): `brain`, `brain.history`, `brain_search`, `log_action`,
  `perch_actions_log`, `perch_undo`, `perch_multi_server_dashboard`
- **Vault** (block 2): `vault.list`, `vault.get`, `vault.put`
- **SSH**: `ssh.exec` (regex-whitelisted read-only), `ssh.detect_webapp`
- **WordPress** (block 8): `wp.db_audit`, `wp.db_clean`, `wp.plugins`,
  `wp.plugin_update`, `wp.plugin_deactivate`, `wp.security`, `wp.backup`,
  `wp.images_scan`, `wp.images_optimize`, `wp.perf`
- **Server intelligence** (added): `access_top_ips`, `access_summary`,
  `wp_errors`, `php_errors`, `mysql_errors`, `server_pulse`
- **Lifecycle** (block 9): `perch_self_update`

Service: `perch-api.service` (systemd). `ProtectSystem=strict`,
`User=serverbrain`, `NoNewPrivileges=false` (needed for narrow sudo to read
cross-user logs — see block 4).

## Gaps (toward vision)

- [ ] Confirmation flow for write operations (currently no built-in
  "show diff, ask CONFIRM" — Claude users approve every call manually,
  but Telegram/Slack callers don't get a confirm prompt)
- [ ] "What changed" follow-up after a write tool runs
- [ ] Per-tool rate limiting (currently global)
- [ ] Tool deprecation flow

## Next ship task

**Add a `confirm` parameter to all WRITE tools** (`wp.plugin_update`,
`wp.plugin_deactivate`, `wp.db_clean`, `perch_self_update`, etc.) — when
absent, return a structured "preview" object describing what WOULD happen
plus a `confirm_token`. Caller passes the token back to actually execute.
~3h. Touches `src/index.ts`, `src/api/server.ts`, every WP write module.

## Boundaries

- Read tools never need confirm. Write tools always need confirm.
- This block is the only thing that calls block 4 (Monitor) or block 8 (WP)
  externally. Notifier (block 5) and Claude Plugin both go through HERE.
