# RunCloud Server Management MCP — Manage, Monitor & Fix Servers from Claude

Manage your RunCloud servers, monitor server health in real time, and auto-fix issues — all through a single AI conversation. No dashboard switching. No terminal commands. Just tell Claude what you need.

**135 tools. Three powerful modes. One MCP server.**

[![RunCloud](https://img.shields.io/badge/RunCloud-API%20v3-0066CC?style=flat-square)](https://runcloud.io)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-Compatible-blueviolet?style=flat-square)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![Tools](https://img.shields.io/badge/Tools-135-orange?style=flat-square)](#full-tool-catalog-135-tools)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

---

## Why This Exists

[RunCloud](https://runcloud.io) is a server management panel for deploying web apps on any cloud — DigitalOcean, Hetzner, AWS, Vultr, Linode, or bare metal. It has a powerful REST API, but using it means reading docs, writing curl commands, and switching between tabs.

This MCP server connects RunCloud's full API — plus live SSH access and a Telegram monitoring bot — directly into Claude. You describe what you want in plain English. Claude handles the API calls, SSH commands, and server fixes automatically.

**Example:**

> *"Set up a WordPress site on my production server with PHP 8.2, create the database, system user, and install SSL."*

Claude executes 6 API calls in the right order, with the right parameters. Done.

---

## Three Modes — Pick What You Need

| Mode | What It Does | Requires |
|------|-------------|----------|
| **RunCloud API** | Full server management — web apps, databases, SSL, domains, firewall, deployments, cron jobs, and more. 128 tools. | RunCloud API key |
| **SSH Monitoring & Self-Healing** | Real-time health checks, auto-fix broken services, kill orphan processes, clean disk space. 7 tools. | SSH access only (any Linux server) |
| **Telegram Bot** | Automated alerts every 10 minutes, inline fix buttons, 15+ commands for remote control from your phone. | Telegram bot token |

**All three work independently.** Use just one, or combine all three. No RunCloud account needed for SSH monitoring. No SSH needed for RunCloud API tools.

---

## What Can You Do With This?

### For Non-Technical Users

- **Ask about your servers in plain English** — "How's my server doing?" "Is anything broken?" "Which sites need SSL renewal?"
- **Fix problems without touching a terminal** — Claude detects issues and repairs them automatically
- **Get Telegram alerts on your phone** — Know when something goes wrong, tap a button to fix it
- **Set up WordPress sites in one sentence** — Domain, database, user, SSL — all created automatically
- **Monitor all servers from one place** — Health scores, disk usage, memory — across every server you own

### For Developers & DevOps

- **135 tools covering the entire RunCloud API** — Everything the dashboard can do, Claude can do programmatically
- **SSH execution built in** — Run any command on any server directly from Claude
- **Compound operations** — WordPress quickstart (6 API calls), multi-server dashboard, cross-server domain search
- **Self-healing automation** — Detects nginx down, high memory, orphan processes, full disks — and fixes them
- **Works with Claude Desktop and Claude Code** — GUI or terminal, your choice

---

## RunCloud MCP — Full Server Management (128 Tools)

Everything the RunCloud dashboard can do, Claude can do — faster, in bulk, across all servers at once.

### Not Just an API Wrapper

Most integrations wrap the API 1:1. This goes further with **compound tools** that chain multiple API calls into single operations:

| Tool | What Happens Behind The Scenes |
|------|-------------------------------|
| `wordpress_quickstart` | Creates system user → database → DB user → grants access → creates web app → installs WordPress. **Six API calls. One prompt.** |
| `server_overview` | Server info + health + hardware + services + web apps — fetched simultaneously |
| `all_servers_health` | Health check across **every server** in your account at once |
| `multi_server_dashboard` | Every server: name, IP, health score, webapp count, memory %, disk % — one view |
| `webapp_inventory` | Every webapp across every server — domain, PHP, stack mode — one table |
| `ssl_expiry_check` | Scans all web apps on a server, flags expired and expiring-soon certs |
| `find_webapp_by_domain` | Searches **all servers** for a domain — returns which server it's on |
| `failed_services_scan` | Scans all servers, returns only stopped/failed services — instant incident detection |
| `deploy_and_verify` | Force deploy + check webapp status + tail logs — full deploy cycle in one step |
| `server_health_score` | Calculates a 0–100 score with letter grade (A–F) based on memory, disk, load, services |

### Example Prompts — RunCloud API

```
"Give me a full dashboard of all my servers"
"Which servers have memory above 80%?"
"Are there any stopped services across any of my servers?"
"Set up a WordPress site on server 12345 with domain myblog.com, PHP 8.2, and SSL"
"Deploy the latest changes from main branch to webapp 789 and verify it worked"
"Which server is example.com on?"
"Install a Let's Encrypt certificate for myblog.com"
"Block all traffic to port 8080 except from IP 203.0.113.5"
"Show me the full security audit for server 12345"
```

---

## Server Monitoring & Self-Healing (7 SSH Tools)

These work on **any Linux server** — RunCloud-managed or not. No API key needed. Just SSH access.

### What It Monitors

| Tool | What It Does |
|------|-------------|
| `ssh_server_status` | Full health report: RAM, disk, CPU load, nginx status, orphan process count, top 5 processes by memory |
| `ssh_smart_fix` | Detects and auto-fixes: nginx down, orphan processes, high memory, full disk. Reports exactly what was fixed. |
| `ssh_restart_service` | Restart any service via SSH. Auto-detects `nginx-rc` (RunCloud) vs `nginx`. Handles `n8n`, `pm2`, any systemd service. |
| `ssh_kill_orphans` | Finds processes with PPID=1 (true orphans). Dry-run by default. Filter by process name. Safe — skips system processes. |
| `ssh_disk_cleanup` | Lists large log files. Dry-run by default. Pass `dryRun: false` to clear. Configurable minimum size. |
| `ssh_check_ports` | All listening ports with PID and process name. Optional filter to specific ports. |
| `telegram_send_alert` | Send a Markdown message to any Telegram chat. Optionally include action buttons (Status, Smart Fix, Nginx, Disk, Ignore). |

### What `ssh_smart_fix` Detects and Repairs

```
Problem detected               →  Action taken
─────────────────────────────────────────────────
nginx-rc / nginx is not active →  sudo systemctl restart nginx-rc (or nginx)
Orphan procs (PPID=1) > 10    →  Kill all orphan PIDs
Memory usage > 88%             →  pm2 restart all (finds pm2 automatically)
Disk usage > 88%               →  truncate -s 0 on log files > 50MB
All clear                      →  Reports "healthy — nothing needed fixing"
```

### RunCloud-Specific: nginx-rc Detection

RunCloud installs its own nginx binary (`nginx-rc`) instead of standard `nginx`. Most monitoring tools check the wrong service name and report "inactive" even when the web server is running fine.

All SSH tools in this MCP auto-detect which one is running:

```
systemctl is-active nginx-rc   →  active  →  use nginx-rc
systemctl is-active nginx-rc   →  inactive →  fall back to nginx
```

You can also pass `nginxService: "nginx-rc"` explicitly to skip detection.

### Example Prompts — Monitoring

```
"Check the status of my server at 95.216.156.89"
"Run a smart fix on my server — detect and repair any issues"
"Kill orphan processes on my server (dry run first)"
"Restart nginx on my server — it uses RunCloud so try nginx-rc first"
"Show me all listening ports on my server"
"Find log files over 100MB and clear them"
```

---

## Telegram Bot — Monitor & Fix from Your Phone

A complete standalone monitoring and alerting stack. Runs on your server with zero external dependencies beyond Python.

### How It Works

```
Your Server
├── monitor.sh        ← Cron every 10 min → detects issues → sends Telegram alerts
├── fix-server.py     ← Local HTTP API on 127.0.0.1:3011 → executes fix scripts
├── bot.py            ← Telegram bot (polling) → handles commands + button callbacks
└── .env              ← All config in one file
```

**monitor.sh** runs every 10 minutes via cron. If it detects a problem (nginx down, high memory, disk full), it sends a Telegram message with inline action buttons. Tap a button → the fix runs instantly → you see the result in chat.

### Telegram Commands

| Command | What It Does |
|---------|-------------|
| `/status` | Full RAM, Disk, CPU, nginx, services status |
| `/brief` | One-liner quick status |
| `/fix` | Smart fix — auto-detect and repair all issues |
| `/nginx` | Restart nginx / nginx-rc |
| `/n8n` | Restart n8n |
| `/services` | Restart all custom services |
| `/disk` | Disk usage breakdown |
| `/logs` | Clear large log files |
| `/ports` | Check which service ports are responding |
| `/mute 2h` | Silence alerts for 2 hours |
| `/mute 30m` | Silence for 30 minutes |
| `/unmute` | Re-enable alerts |
| `/test` | Send a test alert |
| `/reboot` | Reboot server (inline confirmation required) |
| `/menu` | Show action button keyboard |
| `/help` | All commands |

### Alert Buttons

When monitor.sh detects a problem, the Telegram message includes inline buttons:

```
🔧 Smart Fix    📊 Status
🌐 Nginx        💾 Disk    ✅ Ignore
```

Tap a button → fix runs → result appears in the same chat. Works even when the Telegram bot service is stopped — the fix server handles callbacks independently.

### Telegram Setup

```bash
cd telegram-bot
cp config.example.env .env
nano .env   # Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
bash setup.sh
```

`setup.sh` handles everything:
1. Writes `.env` with all config
2. Generates a random auth token for the fix server
3. Installs Python `requests` dependency
4. Sets up the cron for `monitor.sh`
5. Creates and starts systemd services for `bot.py` and `fix-server.py`
6. Sends a test Telegram message to confirm it works

**To get Telegram credentials:**
- **Bot token:** Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
- **Chat ID:** Message [@userinfobot](https://t.me/userinfobot) → it replies with your chat ID

---

## Installation

### MCP Server (Claude Desktop or Claude Code)

**1. Clone and build**

```bash
git clone https://github.com/adityaarsharma/runcloud-server-management-mcp.git
cd runcloud-server-management-mcp
npm install
npm run build
```

**2. Configure Claude Desktop**

Open the config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "runcloud": {
      "command": "node",
      "args": ["/absolute/path/to/runcloud-server-management-mcp/dist/index.js"],
      "env": {
        "RUNCLOUD_API_KEY": "your_runcloud_api_key_here"
      }
    }
  }
}
```

> **No RunCloud API key?** Remove the `RUNCLOUD_API_KEY` line entirely. The 7 SSH monitoring/self-healing tools still work. You'll only get an error if you try to use a RunCloud API tool.

**3. Restart Claude Desktop**

The MCP server starts automatically. You'll see a hammer icon in Claude Desktop confirming tools are loaded.

**4. Claude Code (terminal)**

```bash
claude mcp add runcloud node /absolute/path/to/dist/index.js \
  -e RUNCLOUD_API_KEY=your_runcloud_api_key_here
```

Or without API key (SSH tools only):

```bash
claude mcp add runcloud node /absolute/path/to/dist/index.js
```

**5. Via supergateway (for remote/shared access)**

```bash
npm install -g supergateway
supergateway --stdio "node /path/to/dist/index.js" \
  --port 3020 \
  --outputTransport streamableHttp \
  --path /mcp \
  --oauth2Bearer your_secret_token \
  --logLevel none
```

Then in Claude Desktop config:

```json
{
  "mcpServers": {
    "runcloud": {
      "type": "streamable-http",
      "url": "https://your-server.com:3020/mcp",
      "headers": {
        "Authorization": "Bearer your_secret_token"
      }
    }
  }
}
```

### Getting Your RunCloud API Key

1. Log into [RunCloud](https://runcloud.io)
2. Go to **Settings → API Management**
3. Create a new API key
4. Copy the key — you won't see it again

The API key gives full read/write access to everything in your RunCloud account. Store it only in your local Claude config file — never commit it to Git.

---

## Full Tool Catalog (135 Tools)

<details>
<summary><strong>Servers — 17 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `list_servers` | List all servers. Supports `all: true` for auto-pagination. |
| `list_shared_servers` | Servers shared with your account |
| `get_server` | Full server details by ID |
| `create_server` | Add a new server (works with any provider) |
| `delete_server` | Remove a server from RunCloud |
| `get_server_stats` | Web app count, database count, cron count, geo location |
| `get_server_hardware_info` | CPU, RAM, disk, load average, kernel version, uptime |
| `get_server_health` | Latest health data snapshot from RunCloud agent |
| `clean_server_disk` | Trigger disk cleanup via RunCloud |
| `get_installation_script` | Get the RunCloud agent install script for a server |
| `get_server_logs` | Action and change logs for a server |
| `get_ssh_settings` | SSH config: passwordless login, DNS, root login settings |
| `update_ssh_settings` | Modify SSH configuration |
| `update_server_meta` | Rename server or change provider label |
| `update_server_autoupdate` | Configure automatic OS and security updates |
| `list_php_versions` | Available PHP versions installed on a server |
| `change_php_cli` | Set the default PHP CLI version |

</details>

<details>
<summary><strong>Web Applications — 12 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `list_webapps` | All web apps on a server. Supports `all: true`. |
| `get_webapp` | Full details for a specific web app |
| `create_webapp` | Create a web app (Native, Custom, or WordPress stack) |
| `delete_webapp` | Delete a web app |
| `rebuild_webapp` | Rebuild nginx + PHP config for a web app |
| `get_webapp_settings` | PHP-FPM settings, memory, upload size |
| `update_webapp_fpm_settings` | Update PHP-FPM pool settings |
| `get_webapp_logs` | Recent logs for a web app |
| `set_webapp_default` | Set a web app as the server's default |
| `remove_webapp_default` | Remove the default flag |
| `create_webapp_alias` | Add an alias/subdomain to a web app |
| `change_webapp_php_version` | Switch PHP version for a web app |

</details>

<details>
<summary><strong>PHP Script Installer — 3 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `list_script_installers` | Available one-click installers (WordPress, Joomla, Drupal, phpMyAdmin, etc.) |
| `install_php_script` | Run a one-click installer on a web app |
| `remove_php_installer` | Remove a script installer from a web app |

</details>

<details>
<summary><strong>Git & Deployments — 6 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `get_git_info` | Current git connection details for a web app |
| `clone_git_repo` | Connect a git repository to a web app |
| `remove_git_repo` | Disconnect git from a web app |
| `change_git_branch` | Switch the active branch |
| `force_git_deploy` | Force a git pull and deploy |
| `update_git_deploy_script` | Modify the post-deploy script |
| `generate_deployment_key` | Generate an SSH deploy key for private repos |

</details>

<details>
<summary><strong>Domains — 3 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `list_domains` | All domain names attached to a web app |
| `add_domain` | Add a domain or subdomain to a web app |
| `delete_domain` | Remove a domain from a web app |

</details>

<details>
<summary><strong>SSL Certificates — 10 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `get_ssl` | Current SSL cert info for a web app |
| `install_ssl` | Install Let's Encrypt or custom SSL |
| `delete_ssl` | Remove SSL from a web app |
| `redeploy_ssl` | Force SSL redeployment |
| `get_domain_ssl` | Per-domain SSL info |
| `install_domain_ssl` | Install SSL for a specific domain |
| `delete_domain_ssl` | Remove domain-level SSL |
| `redeploy_domain_ssl` | Force redeploy domain SSL |
| `get_advanced_ssl` | Advanced SSL config details |
| `switch_advanced_ssl` | Toggle advanced SSL settings |

</details>

<details>
<summary><strong>Databases — 12 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `list_databases` | All databases on a server |
| `get_database` | Details for a specific database |
| `create_database` | Create a new database |
| `delete_database` | Delete a database |
| `list_database_users` | All database users on a server |
| `get_database_user` | Details for a specific DB user |
| `create_database_user` | Create a database user |
| `delete_database_user` | Delete a database user |
| `update_database_user_password` | Change a DB user's password |
| `list_granted_database_users` | Users with access to a specific database |
| `grant_database_user` | Grant a user access to a database |
| `revoke_database_user` | Revoke user access from a database |
| `list_database_collations` | Available character sets and collations |

</details>

<details>
<summary><strong>System Users — 6 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `list_system_users` | All system users on a server |
| `get_system_user` | Details for a specific system user |
| `create_system_user` | Create a system user (for web apps) |
| `delete_system_user` | Delete a system user |
| `change_system_user_password` | Set or change password (also needed for SSH login) |
| `generate_deployment_key` | Generate SSH deploy key for a system user |

</details>

<details>
<summary><strong>SSH Keys — 4 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `list_ssh_keys` | All public SSH keys on a server |
| `get_ssh_key` | Details for a specific SSH key |
| `add_ssh_key` | Add a public SSH key to a server |
| `delete_ssh_key` | Remove an SSH key |

</details>

<details>
<summary><strong>Cron Jobs — 5 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `list_cronjobs` | All cron jobs on a server |
| `get_cronjob` | Details for a specific cron job |
| `create_cronjob` | Create a new cron job |
| `delete_cronjob` | Delete a cron job |
| `rebuild_cronjobs` | Rebuild the crontab file |

</details>

<details>
<summary><strong>Supervisor — 8 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `list_supervisor_jobs` | All Supervisor background workers |
| `get_supervisor_job` | Details for a specific worker |
| `create_supervisor_job` | Create a new background worker |
| `delete_supervisor_job` | Delete a worker |
| `reload_supervisor_job` | Reload a specific worker |
| `rebuild_supervisor_jobs` | Rebuild all Supervisor configs |
| `get_supervisor_status` | Current status of all workers |
| `list_supervisor_binaries` | Available binary paths for Supervisor |

</details>

<details>
<summary><strong>Firewall & Security — 9 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `list_firewall_rules` | All firewall rules on a server |
| `create_firewall_rule` | Add a firewall rule (IP whitelist, port block, etc.) |
| `delete_firewall_rule` | Remove a firewall rule |
| `deploy_firewall_rules` | Apply pending firewall changes |
| `list_fail2ban_blocked_ips` | IPs currently blocked by Fail2Ban |
| `unblock_fail2ban_ip` | Unblock a specific IP from Fail2Ban |
| `security_audit` | Full snapshot: firewall + SSH keys + Fail2Ban + external APIs |
| `open_ports_report` | Ports open to 0.0.0.0 — review before going live |
| `list_ssl_protocols` | Available SSL/TLS protocol versions |

</details>

<details>
<summary><strong>Services — 2 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `list_services` | All services (nginx, mysql, redis, etc.) with CPU, memory, version |
| `control_service` | Start, stop, restart, or reload any service via RunCloud API |

</details>

<details>
<summary><strong>External APIs — 5 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `list_external_apis` | All connected third-party API keys |
| `get_external_api` | Details for a specific external API |
| `create_external_api` | Add a new external API (Cloudflare, DigitalOcean, etc.) |
| `update_external_api` | Update an external API connection |
| `delete_external_api` | Remove an external API |

</details>

<details>
<summary><strong>Cross-Server Search & Inventory — 4 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `find_webapp_by_domain` | Search all servers for a domain name — returns server + webapp |
| `webapp_inventory` | Full inventory: every webapp across all servers in one table |
| `multi_server_dashboard` | All servers: health score, webapp count, memory%, disk% |
| `failed_services_scan` | All servers: only stopped/failed services — instant incident detection |

</details>

<details>
<summary><strong>Health, Monitoring & Performance — 7 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `server_overview` | Full server snapshot: info + health + hardware + services + webapps |
| `server_health_score` | 0–100 score + letter grade (A–F) based on RAM, disk, load, services |
| `all_servers_health` | Health status across every server in your account |
| `server_load_report` | CPU, memory, disk, and load trends via SSH |
| `nginx_top_ips` | Top IPs hitting nginx — detect scrapers and attackers |
| `php_error_summary` | PHP error counts by type + last 20 lines from error log |
| `ssl_expiry_check` | Scans all web apps, flags EXPIRED and EXPIRING_SOON certs |

</details>

<details>
<summary><strong>Deployments — 2 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `deploy_and_verify` | Force deploy + check webapp status + tail logs — one step |
| `wordpress_quickstart` | Full WordPress setup: user + DB + web app + install — one prompt |

</details>

<details>
<summary><strong>WordPress Management (SSH) — 5 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_wp_cli` | Run any WP-CLI command on any web app |
| `wp_health_check` | WP core checksums + active plugins + cron status |
| `wp_outdated_plugins` | List plugins with available updates |
| `wp_admin_audit` | All admin users — detect unexpected accounts |
| `wp_clear_all_caches` | Flush WordPress + Redis + OPcache |

</details>

<details>
<summary><strong>SSH Direct Execution — 4 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_run_command` | Run any shell command on any server via SSH |
| `ssh_artisan` | Run Laravel Artisan commands |
| `ssh_tail_log` | Live tail a log file (returns last N lines) |
| `ping` | Test API authentication |

</details>

<details>
<summary><strong>Server Monitoring & Self-Healing (SSH-direct) — 7 tools</strong></summary>

| Tool | Description |
|------|-------------|
| `ssh_server_status` | Full health report: RAM, disk, CPU load, nginx/nginx-rc status, orphan count, top 5 processes |
| `ssh_smart_fix` | Auto-detect and fix: nginx down, orphan procs, high memory, full disk |
| `ssh_restart_service` | Restart any service. Auto-detects nginx-rc vs nginx. |
| `ssh_kill_orphans` | Find and kill orphan processes (PPID=1). Dry-run by default. |
| `ssh_disk_cleanup` | Find and clear large log files. Dry-run by default. |
| `ssh_check_ports` | All listening ports with PID and process name. |
| `telegram_send_alert` | Send Markdown message to Telegram with optional action buttons. |

</details>

---

## SSH Tools — How Server Connections Work

**With RunCloud API:** Pass a `serverId` — the server IP is fetched automatically from RunCloud. You never need to look it up.

**Without RunCloud API:** Pass `host` directly to any SSH monitoring tool. No API key needed.

```
With API:    "List my servers" → "SSH into server 12345 as deploy and run ls"
Without API: "Check server status at 95.216.156.89 — SSH as runcloud / mypassword"
```

### System Users Are Required for SSH

RunCloud uses isolated system users per web app. SSH tools need a username and password:

```
"Set the password for system user 99 on server 12345 to MyPass123"
```

Then use that username and password in all SSH tool calls.

### RunCloud Agent vs SSH — Two Ways to Check Health

- `get_server_health` — Uses RunCloud's agent data (polled every minute by RunCloud). Slight delay.
- `ssh_server_status` — Runs commands directly on the server. Real-time. Works even if the RunCloud agent is slow.

---

## Project Structure

```
runcloud-server-management-mcp/
│
├── src/
│   └── index.ts              ← Full MCP server — all 135 tools
│
├── dist/                     ← Compiled JavaScript (auto-generated)
│   └── index.js
│
├── telegram-bot/             ← Standalone Telegram monitoring stack
│   ├── bot.py                ← Telegram bot (polling, no library needed)
│   ├── fix-server.py         ← Local HTTP fix API (127.0.0.1:3011)
│   ├── monitor.sh            ← Cron monitor (alerts + dedup + mute)
│   ├── setup.sh              ← One-command setup wizard
│   └── config.example.env    ← All config documented
│
├── package.json
├── tsconfig.json
└── README.md
```

---

## Dependencies

### MCP Server

| Dependency | Version | Purpose |
|------------|---------|---------|
| **Node.js** | 18+ | Runtime (built-in `fetch()`) |
| **npm** | 8+ | Package manager |
| `@modelcontextprotocol/sdk` | latest | MCP protocol — how Claude talks to this server |
| `ssh2` | ^1.x | SSH client — enables direct server connections |
| **TypeScript** | 5.x | Source language |
| **Claude Desktop or Claude Code** | latest | The AI client |

No database. No background services. No port forwarding. The MCP server is a process Claude spawns when you open it.

### Telegram Bot (optional)

| Dependency | Version | Purpose |
|------------|---------|---------|
| **Python** | 3.8+ | Runtime for bot and fix server |
| `requests` | any | HTTP calls to Telegram API |
| **bash** | 4+ | For monitor.sh |
| `jq` | any | JSON formatting |
| `curl` | any | HTTP in monitor.sh |
| `nc` (netcat) | any | Port checking |
| **systemd** | any | Runs bot and fix server as services |
| **cron** | any | Runs monitor.sh every 10 minutes |

No Telegram bot library needed — uses the raw Telegram Bot API.

---

## Security

- **RunCloud API key** — stored only in your local Claude config. Never leaves your machine.
- **SSH credentials** — passed per-call. Never stored by this MCP.
- **API traffic** — direct HTTPS to `manage.runcloud.io`. No relay, no third party.
- **SSH traffic** — direct to your server. No relay, no third party.
- **Telegram bot** — runs on your server, only responds to your chat ID.
- **Fix server** — binds to `127.0.0.1` only. Not accessible from outside.
- **API key scope** — full read/write access. Protect the machine where Claude is configured.

---

## Built With

| Library | Purpose |
|---------|---------|
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) | MCP protocol implementation |
| [`ssh2`](https://github.com/mscdex/ssh2) | SSH client for Node.js |
| [RunCloud API v3](https://runcloud.io/docs/api/v3) | Server management REST API |
| TypeScript 5 + Node.js 18 | Language and runtime |
| Python 3 + requests | Telegram bot and monitoring |

---

## Contributing

PRs welcome. Ideas:

- More compound tools (e.g. `migrate_webapp` — clone a webapp to another server)
- Discord notification support in monitor.sh
- RunCloud webhook receiver
- Multi-account support (multiple API keys)
- Health history tracking

---

## Related Projects

- **[YouTube Channel Data MCP](https://github.com/adityaarsharma/youtube-channel-data-mcp)** — Connect Claude to your YouTube Analytics data

---

## License

MIT — use it, modify it, ship it.

---

## About

Built by **[Aditya Sharma](https://adityaarsharma.com)** — marketing and growth at [POSIMYTH](https://posimyth.com), makers of WordPress tools.

- [adityaarsharma.com](https://adityaarsharma.com)
- [@adityaarsharma on X](https://twitter.com/adityaarsharma)
- [github.com/adityaarsharma](https://github.com/adityaarsharma)

If this saved you time — **star the repo**

---

*Not an official RunCloud product. Built independently using the [RunCloud public API v3](https://runcloud.io/docs/api/v3).*
