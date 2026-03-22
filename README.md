# RunCloud Server Management MCP

**Control your entire RunCloud infrastructure through Claude.** Manage servers, web applications, databases, SSL certificates, deployments, firewall rules, run live SSH commands, and get cross-server search and dashboards — all from a single AI conversation.

[![RunCloud](https://img.shields.io/badge/RunCloud-API%20v3-0066CC?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0tMSAxNy45M1Y0LjA3YzMuOTQuNDkgNyAzLjg1IDcgNy45M3MtMy4wNiA3LjQ0LTcgNy45M3oiLz48L3N2Zz4=)](https://runcloud.io)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-Compatible-blueviolet?style=flat-square)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](https://opensource.org/licenses/MIT)

---

## What Is This?

[RunCloud](https://runcloud.io) is a server management panel for deploying and managing web applications on cloud servers (DigitalOcean, AWS, Hetzner, Vultr, etc.). It has a powerful REST API — but using it requires manually crafting API calls, reading docs, and switching between tools.

This MCP server bridges RunCloud's API directly into **Claude Desktop**, giving you a conversational interface to your entire server infrastructure. Ask Claude to deploy a WordPress site, check which SSL certs are expiring, restart nginx, or run a WP-CLI command — and it just happens.

---

## What Makes This Powerful

### 128 Tools Across Every RunCloud Feature

This is one of the most complete RunCloud API implementations available. Every documented endpoint is covered — nothing left out.

### SSH Execution Built In

The biggest differentiator. Claude can SSH directly into your servers and run real commands:

- **Any shell command** via `ssh_run_command`
- **WP-CLI** for WordPress management via `ssh_wp_cli`
- **Laravel Artisan** commands via `ssh_artisan`
- **Live log tailing** via `ssh_tail_log`

The server IP is fetched automatically from RunCloud — you just provide the username and password. Workflow: set a known password via `change_system_user_password`, then SSH in.

### Compound Tools (One Prompt = Multiple API Calls)

Instead of chaining 5 tool calls, compound tools do the heavy lifting in parallel:

| Tool | What Happens Behind the Scenes |
|---|---|
| `server_overview` | Fetches server info + health + hardware + services + web apps **simultaneously** |
| `webapp_full_info` | Fetches web app + domains + SSL + git + settings **simultaneously** |
| `all_servers_health` | Checks health across **every server** in your account at once |
| `ssl_expiry_check` | Scans all web apps on a server, flags EXPIRED and EXPIRING_SOON certs |
| `wordpress_quickstart` | Creates system user → database → DB user → grants access → web app → installs WordPress — **all in one command** |
| `server_health_score` | Calculates a 0–100 score + letter grade based on memory, disk, load, and services |
| `multi_server_dashboard` | Every server: name, IP, health score, webapp count, memory %, disk % — one view |
| `webapp_inventory` | Every webapp across every server — domain, PHP version, stack mode — one table |
| `find_webapp_by_domain` | Search ALL servers for a domain, returns which server and webapp it belongs to |
| `failed_services_scan` | Scans all servers, returns only stopped/failed services — instant incident detection |
| `security_audit` | Firewall rules + SSH keys + Fail2Ban IPs + external APIs — full security snapshot |
| `open_ports_report` | Ports open to 0.0.0.0 only — highlights exposure before going live |
| `deploy_and_verify` | Force git deploy + check webapp status + tail logs — full deploy cycle in one command |

### Auto-Pagination

List tools support `all: true` to automatically fetch every page of results. No more `page=1`, `page=2` manual loops.

---

## Tool Categories

| Category | Tools | Highlights |
|---|---|---|
| 🖥️ **Servers** | 17 | List, create, delete, SSH config, PHP versions, auto-update, logs |
| 🌐 **Web Applications** | 12 | Full CRUD, rebuild, set default, create alias, PHP-FPM settings |
| 🔧 **PHP Installer** | 3 | Install WordPress, Joomla, Drupal, phpMyAdmin, and more |
| 🌿 **Git** | 6 | Clone repo, change branch, deploy script, force deploy |
| 🌍 **Domains** | 3 | Add, list, delete domain names |
| 🔒 **SSL** | 10 | Let's Encrypt, custom certs, CSR, advanced per-domain SSL, auto-renew |
| 🗄️ **Databases** | 12 | Databases + users + grant/revoke access |
| 👤 **System Users** | 6 | Create, password change, deployment key generation |
| 🔑 **SSH Keys** | 4 | Add, list, delete public keys |
| ⏰ **Cron Jobs** | 5 | Full crontab management |
| 📋 **Supervisor** | 8 | Background workers, status, reload, binaries |
| 🛡️ **Firewall** | 6 | Global + rich rules, deploy, Fail2Ban unblock |
| ⚙️ **Services** | 2 | Start/stop/restart/reload nginx, mysql, redis, etc. |
| 🔗 **External APIs** | 5 | Cloudflare, DigitalOcean, Linode API keys |
| 📊 **Static Data** | 4 | Timezones, collations, installers, SSL protocols |
| 🖥️ **SSH Execution** | 4 | Shell commands, WP-CLI, Artisan, log tailing |
| 🔍 **Search** | 2 | find_webapp_by_domain, webapp_inventory across all servers |
| 📈 **Health & Monitoring** | 4 | Health score, multi-server dashboard, failed service scan |
| 🔐 **Security** | 2 | Full security audit, open ports report |
| 🚀 **Deployment** | 1 | Deploy and verify in one command |
| 🟦 **WordPress SSH** | 4 | Health check, outdated plugins, admin audit, cache clear |
| ⚡ **Performance SSH** | 3 | Load report, nginx top IPs, PHP error summary |
| 🔗 **Compound Tools** | 5 | server_overview, wordpress_quickstart, ssl_expiry_check, and more |

---

## Installation

### Prerequisites

- [Node.js 18+](https://nodejs.org)
- [Claude Desktop](https://claude.ai/download)
- A [RunCloud](https://runcloud.io) account with at least one server
- Your RunCloud API key (Settings → API Management in your RunCloud workspace)

### Setup

**1. Clone and build**

```bash
git clone https://github.com/adityaarsharma/runcloud-server-management-mcp.git
cd runcloud-server-management-mcp
npm install
npm run build
```

**2. Add to Claude Desktop**

Open your Claude Desktop config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add this to the `mcpServers` section:

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

**3. Restart Claude Desktop**

That's it. Claude now has full access to your RunCloud infrastructure.

---

## Example Prompts

Once connected, just talk to Claude naturally:

### Server Management
```
"Give me a full overview of server ID 12345"
"Check health across all my servers"
"Which server has the most disk usage?"
"Restart nginx on server 12345"
```

### WordPress
```
"Set up a new WordPress site called myblog.com on server 12345
 with PHP 8.2 — create the database and system user too"

"Run wp plugin list on /home/myuser/myblog"
"Flush the WordPress cache on my site"
"Update all WordPress plugins via WP-CLI"
```

### SSL Certificates
```
"Check which SSL certs are expiring in the next 30 days on server 12345"
"Install a Let's Encrypt certificate for myblog.com"
"Renew the SSL for webapp 456"
```

### Deployments
```
"Deploy the latest changes from the main branch on webapp 789"
"Change the git branch for my app from staging to production"
"Set up auto-deploy on commit for my GitHub repo"
```

### Database Management
```
"List all databases on server 12345"
"Create a new database called shop_db with utf8mb4 collation"
"Create a database user and grant them access to shop_db"
```

### Security
```
"Show me all firewall rules on server 12345"
"Block all traffic except from IP 1.2.3.4 on port 8080"
"List IPs currently blocked by Fail2Ban"
"Unblock IP 5.6.7.8 from Fail2Ban"
```

### SSH Commands
```
"Run df -h on server 12345 as user myapp"
"Show me the last 200 lines of the nginx error log"
"Run php artisan migrate on my Laravel app"
"Check disk usage on /home/myapp"
```

### Search & Cross-Server
```
"Which server is myblog.com on?"
"Give me a full inventory of every web app across all my servers"
"Are there any stopped services across any of my servers?"
"Show me a dashboard of all my servers with health scores"
```

### Health & Security
```
"Give me a health score for server 12345"
"Run a full security audit on server 12345 — firewall, SSH keys, blocked IPs"
"Which ports are open to everyone? I want to review before going live"
```

### WordPress SSH Power Tools
```
"Run a full WordPress health check on /home/myuser/myapp/public"
"Which plugins have updates available on my WordPress site?"
"List all admin users — check for any suspicious accounts"
"Clear all caches on my WordPress site including Redis"
```

### Performance Debugging
```
"Give me a full load report for server 12345"
"Show me the top IPs hitting nginx — I think we're being scraped"
"Summarize PHP errors from /home/myuser/myapp/logs/php-error.log"
```

### Works Across Claude Desktop, Claude Code, and n8n
```
# Claude Code (terminal) — register with:
claude mcp add runcloud node /path/to/dist/index.js -e RUNCLOUD_API_KEY=xxx

# Combined with n8n MCP in one conversation:
"Set up a new WordPress site on RunCloud server 12345, then create an n8n
 workflow that pings it every 5 minutes and sends a Telegram alert if it's down"
```

---

## SSH Execution — How It Works

The SSH tools automatically resolve the server IP from RunCloud, so you never need to look it up.

**Typical workflow:**

1. **Set a known password** (if needed):
   ```
   "Set system user password for userId 99 on server 12345 to MyP@ss123"
   ```

2. **Run commands:**
   ```
   "SSH into server 12345 as myuser with password MyP@ss123
    and run: du -sh /home/myuser/*"
   ```

3. **WP-CLI shortcut:**
   ```
   "Run wp user list on /home/myuser/myblog as myuser"
   ```

All SSH connections are direct from your machine to your server — no relay, no third party.

---

## WordPress Quickstart — Full Setup in One Prompt

The `wordpress_quickstart` compound tool chains 6 API calls automatically:

```
"Set up a full WordPress site on server 12345:
 - Domain: mynewsite.com
 - PHP: 8.2
 - System user: siteuser (password: SecurePass123)
 - Database: mynewsite_db
 - DB user: mynewsite_user (password: DbPass456)
 - Timezone: Asia/Kolkata"
```

Claude will:
1. Create the system user
2. Create the database
3. Create the database user
4. Grant the user access to the database
5. Create the web application with optimised PHP-FPM settings
6. Install WordPress

Then gives you the next steps: visit the WP install URL, install SSL, etc.

---

## Security

- Your API key is stored only in your local Claude Desktop config file
- All API calls go directly from your machine to `manage.runcloud.io`
- SSH connections go directly from your machine to your server — no relay
- Nothing is sent to any third party
- Read and write access — be mindful of who has access to your Claude Desktop

---

## Project Structure

```
runcloud-server-management-mcp/
├── src/
│   └── index.ts          # Full MCP server (128 tools)
├── dist/                 # Compiled JavaScript (auto-generated)
├── package.json
├── tsconfig.json
└── README.md
```

---

## Built With

- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server framework
- [ssh2](https://github.com/mscdex/ssh2) — SSH client for Node.js
- [RunCloud API v3](https://runcloud.io/docs/api/v3) — Official RunCloud REST API
- TypeScript + Node.js

---

## Related Projects

- **[YouTube Channel Data MCP](https://github.com/adityaarsharma/youtube-channel-data-mcp)** — Connect Claude to your YouTube Analytics data

---

## License

MIT — use it, modify it, build on it.

---

*Not an official RunCloud product. Built independently using the [RunCloud public API](https://runcloud.io/docs/api/v3).*
