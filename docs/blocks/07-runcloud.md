# Block 7 — RunCloud Module

## Purpose

Make Perch genuinely RunCloud-aware. Two layers:

1. **Filesystem awareness** — every script and rule uses RunCloud's
   conventions (nginx-rc, phpXXrc-fpm, mariadb, /etc/nginx-rc/conf.d/
   layout, /home/{user}/logs/nginx/, /home/{user}/webapps/{App}/)
2. **API integration** — talk to RunCloud's REST API to list servers,
   webapps, deploy, manage backups, switch PHP version per app

## Files (current + target)

- `scripts/import-runcloud-servers.ts` — CLI to seed brain.db from a
  RunCloud account ✅
- `scripts/access-top-ips.sh`, `access-summary.sh`, `wp-errors.sh` — all
  use RunCloud nginx-conf layout ✅
- `src/modules/runcloud/` — **target** for API tools (not yet built)

## Current state

### Filesystem awareness ✅
- `nginx-rc.service` (NOT nginx) — rule_nginx, fix-nginx
- `phpXXrc-fpm.service` (NOT php-fpm) — rule_php_fpm, fix-php-fpm
- `mariadb.service` — rule_database, fix-mysql
- `/etc/nginx-rc/conf.d/<Webapp>.d/main.conf` — has the real `access_log`
- `/etc/nginx-rc/conf.d/<Webapp>.domains.d/<domain>.conf` — usually
  `access_log off`, used to map domain → webapp
- `/home/<user>/logs/nginx/<Webapp>_access.log` — per-webapp access logs
- `/home/<user>/webapps/<App>/` — webapp roots (WordPress and others)

These are now **explicitly** referenced in scripts — no auto-detect that
falls through to wrong defaults.

### API integration ❌
- `import-runcloud-servers.ts` is the only thing that talks to the
  RunCloud API today, and it runs once at setup
- No live tools like `runcloud.list_servers`, `runcloud.list_apps`,
  `runcloud.deploy`, `runcloud.create_backup`, `runcloud.switch_php`,
  `runcloud.create_app`, `runcloud.ssl_install`

## Gaps (toward vision)

- [ ] Build `src/modules/runcloud/api.ts` — typed RunCloud REST client
  (auth, pagination, error handling)
- [ ] Wire 8 MCP/HTTP API tools:
  - `runcloud.list_servers`
  - `runcloud.list_apps`
  - `runcloud.app_detail` (PHP version, domains, SSL, deploy info)
  - `runcloud.deploy` (trigger git deploy)
  - `runcloud.create_backup`
  - `runcloud.list_backups`
  - `runcloud.switch_php` (per-app, with confirm)
  - `runcloud.ssl_install` (Let's Encrypt toggle)
- [ ] Multi-RunCloud-account support (vault stores N tokens, brain.db has
  account_id column)
- [ ] Webhook receiver (`/api/runcloud/webhook`) for deploy events
  triggered outside Perch

## Next ship task

**Add `runcloud.list_servers` and `runcloud.list_apps` MCP tools** as the
first read-only RunCloud API integration. Read `RUNCLOUD_API_TOKEN` from
vault, paginate through `/api/v3/servers` and `/api/v3/servers/{id}/webapps`,
return the structured list. ~2h. Lays the foundation for the rest.

## Boundaries

- RunCloud API token lives in Vault (block 2), never in plain `.env`
- Server/webapp data syncs into Brain (block 1) — RunCloud is not the
  source of truth at runtime, the local Brain is (synced periodically)
- Write operations (deploy, switch_php) MUST go through HTTP API confirm
  flow (block 3 next-ship-task)
