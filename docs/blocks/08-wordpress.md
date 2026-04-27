# Block 8 — WordPress Module

## Purpose

WP-specific intelligence layered on top of HTTP API (block 3). Each tool
inspects or mutates a WordPress installation by webapp name + domain.

## Files

- `src/modules/wordpress/db.ts` — WP-DB audit + transient/spam clean
- `src/modules/wordpress/plugins.ts` — list, update, deactivate
- `src/modules/wordpress/security.ts` — vulnerability scan
- `src/modules/wordpress/backup.ts` — on-demand snapshot
- `src/modules/wordpress/images.ts` — oversized image scan + optimize
- `src/modules/wordpress/perf.ts` — Lighthouse-style perf snapshot
- `src/modules/wordpress/errors.ts` — `wp_errors` (debug.log + plugin blame)

All wired as MCP/HTTP tools: `wp.db_audit`, `wp.db_clean`, `wp.plugins`,
`wp.plugin_update`, `wp.plugin_deactivate`, `wp.security`, `wp.backup`,
`wp.images_scan`, `wp.images_optimize`, `wp.perf`, plus the bash-driven
`wp_errors` script-tool.

## Current state

- ✅ All 7 modules have working implementations
- ✅ Read-side (`wp.db_audit`, `wp.plugins`, `wp.security`, `wp.images_scan`,
  `wp.perf`, `wp_errors`) returns structured data
- ⚠️ Write-side (`wp.db_clean`, `wp.plugin_update`, `wp.plugin_deactivate`,
  `wp.images_optimize`, `wp.backup`) currently runs without explicit
  confirm — relies on Claude Code's per-tool approval prompt for safety
- ✅ All operations write to `perch_actions_log` for audit + undo support
  where reversible (deactivate, transient clean)

## Gaps (toward vision)

- [ ] Confirm-flow for write tools (depends on block 3 next-ship)
- [ ] Per-plugin update strategies (test-on-staging-first)
- [ ] WP-CLI proxy tool (`wp.cli_exec` with whitelisted commands like
  `wp transient delete`, `wp option get`, `wp post list`)
- [ ] WooCommerce-specific health (`wp.woo_audit`)
- [ ] Multisite support
- [ ] Auto-detection of WP version mismatches across managed sites

## Next ship task

**Add `wp.cli_exec` with a regex-whitelisted command set** — let Niyati or
Claude run `wp transient delete --all`, `wp cache flush`, `wp option get
siteurl`, `wp post list --post_type=product --posts_per_page=5`. This unlocks
huge read-only and narrow-write capability without writing one tool per
WP feature. Whitelist: `^wp (transient|cache|option get|post list|user list|
plugin status|theme status|core version|core check-update)\\s`. ~2h.

## Boundaries

- WP module never writes outside the targeted webapp's directory
- Backup tool writes to a configured backup root (default
  `~/.perch/backups/`) — never overwrites existing
- `wp.security` consumes WPScan-style data; no remote API calls without
  user-set token
- Site path is resolved via Brain (block 1) webapp registry — domain
  fuzzy-resolution happens in caller, not here
