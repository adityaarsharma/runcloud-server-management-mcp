<div align="center">

# 🪶 Perch

### Server intelligence layer. Watches, diagnoses, heals.

**The Claude Code plugin + Telegram bot that makes server management feel like having a smart engineer on call — free, forever, on your own server.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Always Free](https://img.shields.io/badge/Always-Free-brightgreen?style=flat-square)]()
[![RunCloud](https://img.shields.io/badge/RunCloud-API%20v3-0066CC?style=flat-square)](https://runcloud.io)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-Compatible-blueviolet?style=flat-square)](https://modelcontextprotocol.io)
[![WordPress](https://img.shields.io/badge/WordPress-Expert%20Module-21759B?style=flat-square)](https://wordpress.org)

</div>

---

## What is Perch?

Perch is a **self-hosted server intelligence layer** that lives on your server and talks to you via Telegram (or Slack).

It doesn't just tell you things are broken. It tells you **why**, what it already did about it, and what you should do next — in plain English.

```
🪶 Perch — production-1

nginx had a moment just now. I checked — a config snippet
added via RunCloud had a small typo on line 47.

I've restarted nginx and the site is back up (took 8 seconds).

Want me to fix that snippet so this doesn't happen again?

[✅ Yes, fix it]  [📄 Show me]  [🔇 Not now]
```

That's it. Not a raw error dump. Not an alarming CAPS alert. A friendly engineer who knows your server.

---

## Why Perch Exists

| Option | Reality |
|--------|---------|
| **Direct SSH** | Fast for experts, terrifying for everyone else. One typo can wipe a client site. No audit trail. |
| **Cloudways / Kinsta** | Great UX, but $30–100/month per server. Locked in. Can't run WordPress + n8n + Node on the same box. |
| **RunCloud** | Excellent server panel. But it manages — it doesn't *watch*, *diagnose*, or *heal*. |
| **cPanel/Plesk** | Bloated, expensive, ugly. |
| **Perch** | Intelligence layer on top of RunCloud (or bare VPS). Watches everything. Explains everything. Fixes common things. Free forever. |

**Perch gives you the peace of mind you'd pay $50/month for — on your own $5/month VPS.**

---

## How It Works

```
You (Claude Code / Telegram)
        │
        │  /perch wp audit mysite.com
        ▼
  PERCH CORE
  ├── reads your server (full profile on install)
  ├── keeps a growing knowledge base (every server, webapp, problem, fix)
  ├── SSH → runs deep checks
  ├── RunCloud API → manages infrastructure
  └── learns from every issue
        │
        ▼
  YOUR SERVER
  ├── WordPress sites
  ├── Node / Laravel / n8n / anything
  └── RunCloud managed or bare VPS
        │
        ▼
  TELEGRAM / SLACK
  (friendly alert + one action button)
```

---

## Quick Start

### Prerequisites
- A RunCloud-managed server (or any Ubuntu/Debian VPS)
- Node.js 18+
- Claude Code (for MCP) and/or a Telegram bot token

### Install MCP (Claude Code)

```bash
git clone https://github.com/adityaarsharma/perch
cd perch
npm install && npm run build
```

Add to your Claude Code config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "perch": {
      "command": "node",
      "args": ["/path/to/perch/dist/index.js"],
      "env": {
        "RUNCLOUD_API_KEY": "your-runcloud-api-key"
      }
    }
  }
}
```

### Install Telegram Bot (Optional)

```bash
cd telegram-bot
cp config.example.env .env
# Edit .env with your bot token, chat ID, server SSH details
./setup.sh
```

---

## Commands

All commands work identically in **Claude Code** and **Telegram**.

### Server & Health

```
/perch                          → quick status of all servers + webapps
/perch status                   → server health (CPU / RAM / disk / services)
/perch disk                     → disk usage breakdown + what's eating space
/perch services                 → all services + uptime
/perch logs nginx               → nginx error log — parsed, not raw
/perch logs php                 → PHP errors grouped by type + file
```

### Webapp Management

```
/perch sites                    → all webapps on all servers
/perch site mysite.com          → full profile of one webapp
/perch audit mysite.com         → run ALL checks (security + perf + db + plugins)
/perch fix mysite.com           → diagnose + auto-fix what's safe to fix
```

### WordPress Killer Series

```
/perch wp db mysite.com         → database health (autoload, transients, orphans)
/perch wp db clean mysite.com   → clean expired transients + orphaned sessions
/perch wp plugins mysite.com    → plugin list + updates + vulnerability scan
/perch wp security mysite.com   → hardening checklist (scored 0–100)
/perch wp backup mysite.com     → backup status + destination health
/perch wp images mysite.com     → image scan → savings estimate → optimize
/perch wp perf mysite.com       → performance snapshot (cache, cron, PHP, TTFB)
/perch wp errors mysite.com     → PHP errors diagnosed by plugin + root cause
```

### Intelligence

```
/perch history mysite.com       → all past problems + fixes for this site
/perch learn mysite.com         → re-scan + update Perch's knowledge
/perch brain                    → what Perch knows across all servers
```

### Perch Itself

```
/perch update                   → update Perch to latest
/perch install site mysite.com  → add a webapp to Perch's watch list
/perch config                   → view/change settings
```

---

## WordPress Module — Deep Dive

Perch treats WordPress as a first-class citizen. No plugin needed on the WordPress side — everything runs via SSH and WP-CLI from Perch.

### Database Audit

```
📊 DB Health: mysite.com

Autoload: 8.4MB ⚠️  HIGH
(Healthy <1MB | Warning 3–5MB | Urgent >10MB)

Top offenders:
  elementor_data       2.1MB  (Elementor cache)
  _transient_feed_*    1.8MB  (47 expired RSS transients)
  woocommerce_session  890KB  (234 orphaned cart sessions)
  rank_math_analytics  445KB  (SEO analytics cache)

Quick wins (~3.1MB savings):
[🧹 Clear Transients]  [🗑️ Clean Sessions]  [📋 Full Report]
```

### Plugin Vulnerability Scan

Uses Wordfence Intelligence free API — no API key needed.

```
🔌 Plugin Audit: mysite.com

34 active · 8 inactive (⚠️ remove inactive ones)
Updates needed: 6 · Vulnerable: 2

🔴 Contact Form 7 v5.7 — SQL Injection (CVE-2024-XXXX, CVSS 8.1)
   Fix: update to v5.8
   [🔄 Update Now]

🟡 WC Payments v6.1 — Auth Bypass (CVSS 6.5)
   Fix: update to v6.2
   [🔄 Update Now]
```

### Security Audit

Scores your WordPress install 0–100 across 12 server-level checks.

```
🔒 Security: mysite.com — Score 71/100 (Grade C)

❌ Admin username is "admin" (critical — change it)
❌ xmlrpc.php is publicly accessible (high)
❌ readme.html exposes WP version (medium)
✅ wp-config.php permissions: 640
✅ File editor disabled
✅ SSL valid (expires 2026-07-14)
✅ WP core checksums verified
...
```

### White Screen / Fatal Error Diagnosis

When your site shows a white screen, Perch SSHes in and diagnoses:

```
🔴 White screen on mysite.com

Fatal error: Cannot redeclare 'my_custom_helper'
Conflict between:
  wp-content/plugins/my-plugin/includes/helpers.php:23
  wp-content/themes/mytheme/functions.php:89

my-plugin was updated 2 hours ago — likely introduced this conflict.

[🔇 Deactivate my-plugin]  [📋 Full Error Log]  [↩️ Roll Back Plugin]
```

### Image Optimization (Plugin-Free)

No plugin needed. Perch runs jpegoptim + cwebp + pngquant directly on the server.

```
/perch wp images mysite.com

🖼️ Image Scan: mysite.com

1,247 images · 4.2GB total
Estimated savings: ~1.4GB (lossless JPEG + PNG)
WebP: will generate alongside originals

Largest files needing attention:
  hero-2024.png    8.4MB
  team-photo.jpg   6.1MB

ETA: ~12 minutes. Runs in background.

[▶️ Optimize All]  [⚙️ Skip WebP]  [❌ Cancel]
```

---

## Intelligence Layer

Perch builds a **per-server, per-webapp knowledge base** that grows over time.

Every audit, every fix, every problem gets logged. After 30 days, Perch knows:
- Your memory/disk baseline (alerts only when something is actually abnormal for your server)
- Which plugins cause problems on your specific stack
- Which fixes work for your recurring issues

```
/perch brain

🧠 Perch Knowledge — production-1

Servers: 2  |  Webapps: 7  |  WP sites: 5
Problems logged: 43  |  Fixes applied: 38

Recurring issue (5x this month):
  nginx crash → always caused by worker_connections limit at traffic spikes
  Suggested permanent fix: increase to 2048

Plugin risk across all sites:
  Contact Form 7 — 3 sites still on vulnerable v5.7
```

---

## Auto-Watch (No Setup After Install)

| Metric | Alert Threshold | What Perch Does |
|--------|----------------|-----------------|
| CPU load avg | >80% for 10min | Diagnose which process |
| RAM | >88% | Top consumers + PM2 restart offer |
| Disk | 80% → 90% → 95% | Tiered nudges |
| nginx / nginx-rc | Down | Config check → restart |
| PHP-FPM | Down | Restart + log cause |
| MySQL | Down | Restart + OOM check |
| Site HTTP status | 4xx/5xx | SSH → diagnose root cause |
| SSL expiry | 30d / 7d / 1d | Alert + renew offer |

---

## Alert Philosophy

**What happened → what Perch already did → what you should do (one action)**

```
❌  CRITICAL: nginx DOWN on production-1 at 14:23:41

✅  nginx had a moment on production-1. Config had a typo on
    line 47 — I restarted it and the site is back up.
    Want me to fix that snippet?
```

Calm. Specific. Actionable. Never alarming.

---

## Webapp Support

WordPress is first. Others get full modules as Perch grows:

| Type | Status |
|------|--------|
| WordPress | ✅ Full — DB, plugins, security, images, perf, errors |
| Node.js / PM2 | ✅ Process health + restart |
| n8n | ✅ Health check + restart |
| Laravel | 🔜 Queue health, schedule runner |
| Static | ✅ HTTP uptime + nginx |
| Any webapp | ✅ Server health + SSL |

---

## Security

- Credentials never logged — sanitized from all error output
- SSH connections: password or private key, configurable
- fix-server API binds to `127.0.0.1` only — never externally accessible
- All shell inputs validated and escaped before execution
- Destructive actions always require confirmation via Telegram button
- Auto-fix never touches WordPress content without explicit confirmation

---

## Architecture

```
perch/
├── src/
│   ├── index.ts                   ← MCP server (RunCloud + Perch tools)
│   ├── core/
│   │   ├── brain.ts               ← SQLite knowledge base
│   │   ├── gateway.ts             ← Alert formatter (friendly tone)
│   │   └── ssh-enhanced.ts        ← SSH with key auth + WP-CLI helper
│   └── modules/
│       └── wordpress/
│           ├── db.ts              ← Database audit + cleanup
│           ├── plugins.ts         ← Plugin audit + Wordfence CVE check
│           ├── security.ts        ← Hardening checklist
│           ├── backup.ts          ← Backup health
│           ├── images.ts          ← CLI image optimization
│           ├── perf.ts            ← Performance snapshot
│           └── errors.ts          ← Error diagnosis + white screen
│
├── telegram-bot/
│   ├── bot.py                     ← Telegram polling bot
│   ├── fix-server.py              ← Local HTTP API (127.0.0.1 only)
│   ├── monitor.sh                 ← Cron health alerting
│   ├── setup.sh                   ← Interactive setup wizard
│   └── scripts/                   ← Shell scripts for each action
│
└── README.md
```

---

## Brand

**Perch** by [Aditya Sharma](https://adityaarsharma.com) — always free, always open source.

Not affiliated with RunCloud. Perch works *with* RunCloud, not instead of it.

[GitHub](https://github.com/adityaarsharma/perch) · [Issues](https://github.com/adityaarsharma/perch/issues)
