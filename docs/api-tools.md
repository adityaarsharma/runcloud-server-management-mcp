# Perch HTTP API — Tool Catalog

All 55 tools exposed by `perch-api` over HTTP.

**Endpoint shape:** `POST /api/<tool_name>` with body `{"args": {...}}` and `Authorization: Bearer <PERCH_API_TOKEN>`.

Live discovery: `GET /api/tools` returns the array of names; `GET /health` is the liveness probe.

Last revised: 2026-04-28 (Perch v2.5).

---

## How to call

```bash
curl -s -X POST \
  -H "Authorization: Bearer $PERCH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"args": {"chat_id": "demo", "message": "kya server status hai?"}}' \
  http://127.0.0.1:3013/api/chat
```

Response shape: `{ ok: true, tool: "<name>", result: <handler output> }` on success; `{ ok: false, error: "..." }` on failure.

Network defaults: bind `127.0.0.1:3013`, body cap 64 KB, per-IP rate limit 60 req/min sliding window. Override host with `PERCH_API_HOST`, port with `PERCH_API_PORT`.

---

## Brain (2)

| Tool | What it returns |
|---|---|
| `brain` | Full snapshot — server count, webapp count, problem count, top problem types, top patterns, server inventory |
| `brain.history` | Per-domain problem history. Args: `domain` |

---

## Conversation (1) — v2.5

| Tool | What it does |
|---|---|
| `chat` | Sysadmin-voice conversational reply. Memory-backed via `BRAIN.conversations`, fires read-only tools heuristically (top IPs / WP errors / server pulse / etc.). Args: `chat_id`, `message`, optional `channel`, `llm_key`, `llm_model`. Read-only — refuses mutating asks. |

---

## Read-only diagnostics (6) — runs whitelisted bash scripts

| Tool | Script | Use |
|---|---|---|
| `access_top_ips` | `access-top-ips.sh` | Top N visitor IPs for a domain. Args: `domain` (required), `count` (default 10) |
| `access_summary` | `access-summary.sh` | Traffic + URLs + status codes for a domain. Args: `domain` |
| `wp_errors` | `wp-errors.sh` | WordPress debug.log + plugin errors. Args: `domain` (optional) |
| `php_errors` | `php-errors.sh` | PHP-FPM errors across all sites |
| `mysql_errors` | `mysql-errors.sh` | MariaDB error + slow query logs |
| `server_pulse` | `server-pulse.sh` | Load · disk · RAM · top procs · failed services |

---

## SSH + audit primitives (3)

| Tool | What it does |
|---|---|
| `ssh.detect_webapp` | Identify webapp framework at a path (WordPress / Laravel / Node / static / unknown) |
| `ssh.exec` | Raw whitelisted shell commands over SSH. Used by other tools internally |
| `log_action` | Record an action to `BRAIN.actions_log` (used by `fix-server.py` to log shell-side fixes alongside MCP-side actions) |

---

## Vault (1)

| Tool | What it does |
|---|---|
| `vault.list` | List vault keys (read-only over HTTP — put/delete deliberately not exposed) |

---

## WordPress — audit (read-only) (28)

| Tool | What it audits |
|---|---|
| `wp.db_audit` | Database size, autoload, transients, fragmentation |
| `wp.db_clean` *(mutating)* | (listed below in mutating section) |
| `wp.plugins` | Installed plugins, versions, last-update gap |
| `wp.security` | Security baseline check |
| `wp.backup` | Backup health and last-run age |
| `wp.perf` | Performance audit baseline |
| `wp.errors` | Error log scan |
| `wp.images_scan` | Image inventory (count, size, formats) |
| `wp.images_compress_bulk_status` | Status of a running compression job |
| `wp.images_compress_bulk_list` | Active/historical bulk compression jobs |
| `wp.audit_disk` | Disk usage per webapp dir |
| `wp.scan_malware` | Static malware signature scan |
| `wp.thumbnails_audit` | Thumbnail bloat detection |
| `wp.plugins_perf_profile` | Per-plugin performance profile |
| `wp.plugins_cleanup_audit` | Identify removable plugins |
| `wp.media_orphans_audit` | Find orphan media (DB-unreferenced uploads) |
| `wp.revisions_audit` | Post revision count + size |
| `wp.translations_audit` | Unused translation files |
| `wp.htaccess_audit` | .htaccess rule audit |
| `wp.core_status` | WordPress core version + checksums |
| `wp.cron_audit` | WP-Cron health |
| `wp.ssl_audit` | SSL config audit |
| `wp.wp_config_audit` | wp-config.php sanity |
| `wp.multisite_audit` | Multisite-specific checks |
| `wp.caching_audit` | Object cache + page cache detection |
| `wp.woocommerce_audit` | WooCommerce-specific audit |
| `wp.yoast_audit` | Yoast SEO config audit |
| `wp.lighthouse_audit` | Lighthouse score baseline |
| `wp.recommend` | Top-level aggregator — runs the right specialists for an intent |

---

## WordPress — mutating (gated, require `confirm: true`) (14)

| Tool | What it changes |
|---|---|
| `wp.db_clean` | Apply DB cleanup (transients, autoload trim, fragmentation) |
| `wp.images_optimize` | Single-pass image optimisation |
| `wp.images_compress_bulk_start` | Launch tmux-based bulk image compression (returns `jobId`) |
| `wp.images_compress_bulk_cancel` | Cancel a running bulk compression job |
| `wp.images_compress_bulk_cleanup` | Remove temp state files after a finished job |
| `wp.thumbnails_clean` | Remove orphan thumbnails |
| `wp.plugins_cleanup_apply` | Apply the plugin-cleanup audit's deactivations |
| `wp.revisions_clean` | Trim post revisions |
| `wp.translations_clean` | Delete unused .mo/.po files |
| `wp.core_update` | WordPress core update |
| `wp.search_replace` | wp-cli search-replace (DB rewrite) |
| `wp.cron_run` | Force-run due WP-Cron events |
| `wp.rewrite_flush` | Flush rewrite rules (hard or soft) |
| `wp.email_test` | Send a real test email from the site |

> **All 14 mutating tools require `args.confirm: true`** — the API throws otherwise. This is enforced at the `runScript` boundary, not just at the LLM layer, so no client (Niyati, MCP, custom) can bypass it. See [`docs/guardrails.md`](./guardrails.md) for the rule layer.

---

## Categories at a glance

```
Brain                   2
Conversation (v2.5)     1
Read-only diagnostics   6
SSH + audit primitives  3
Vault (read-only)       1
WordPress — audit       28
WordPress — mutating    14    (each gated by confirm:true)
─────────────────────────
Total                   55
```

---

## Where each tool's code lives

- `src/api/server.ts` — the dispatcher (`HANDLERS` map + `runScript` whitelist)
- `src/modules/stack/wordpress/` — every `wp.*` tool's implementation, organised into `performance/ · security/ · cleanup/ · operations/ · diagnostics/ · plugins/`
- `src/modules/platform/runcloud/` — RunCloud REST wrapper (called inside some `wp.*` tools)
- `scripts/` — bash scripts the read-only diagnostics call (whitelisted via `SCRIPT_WHITELIST`)
- `src/core/brain.ts` — the SQLite brain (rooms table)
- `src/core/ssh-enhanced.ts` — SSH layer with ControlMaster + wp-cli wrapping
- `src/core/vault.ts` — encrypted credential storage
- `src/reasoning/specialists/` — domain specialists that compose plans of these tools

---

## Discovery from the running API

```bash
curl -s -H "Authorization: Bearer $PERCH_API_TOKEN" \
  http://127.0.0.1:3013/api/tools | jq .
```

Returns:
```json
{
  "tools": ["access_summary", "access_top_ips", "brain", "brain.history", "chat", ...],
  "docs": "POST /api/<tool> with body {args: {...}}"
}
```
