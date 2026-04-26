<div align="center">

# 🪶 Perch

### The intelligence layer for your servers.

**An AI-native, self-hosted, self-learning brain that watches every server you run, diagnoses what breaks in plain English, and lives wherever you want — Claude Code, Telegram, Slack, your terminal, anywhere that speaks HTTP.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Always Free](https://img.shields.io/badge/Always-Free-brightgreen?style=flat-square)]()
[![No Per-Server Pricing](https://img.shields.io/badge/No%20Per--Server-Tax-blue?style=flat-square)]()
[![RunCloud](https://img.shields.io/badge/RunCloud-API%20v3-0066CC?style=flat-square)](https://runcloud.io)
[![MCP](https://img.shields.io/badge/Claude%20Code-Native-blueviolet?style=flat-square)](https://modelcontextprotocol.io)
[![WordPress](https://img.shields.io/badge/WordPress-Expert%20Module-21759B?style=flat-square)](https://wordpress.org)

[Install](#install-in-5-minutes) · [Why Perch](#why-this-exists) · [Comparison](#the-real-hosting-market) · [Commands](#the-perch-experience) · [Architecture](#whats-inside)

</div>

---

## The 30-Second Pitch

- **AI-native, not retrofitted.** Built around Claude Code from day one. Your AI talks to your servers via 150+ MCP tools.
- **Self-hosted intelligence.** Every server, every webapp, every problem, every fix — saved in a local SQLite brain on your hardware. Nobody else owns your operational history.
- **Plain-English diagnosis.** Not "ERROR 500." Try: *"Plugin X just got updated and now conflicts with Theme Y. I deactivated X and the site is back up."*
- **Connectors, not lock-in.** Telegram. Slack. Webhooks. Email. CLI. Anything that talks HTTP. Pick one or use them all.
- **Free forever, no per-server tax.** Run it on 1 VPS or 100. Same price: zero. No "Pro tier," no license keys, no rug-pull.

---

## Why This Exists

In April 2026, you have four ways to host a serious website. All of them are bad:

### The Real Hosting Market

| Option | Real cost / site | What's broken |
|--------|------------------|---------------|
| **GoDaddy / Bluehost** | $7.99–$25/mo | Oversold shared servers. Support reads scripts. Up-charges for SSL, backups, speed. Stuck in 2010. |
| **Cloudways** | $14–$30/mo | [220% markup over raw DigitalOcean/Vultr](https://onlinemediamasters.com/cloudways-review/). No root access. Locked to 5 cloud providers. Bills jump when scaling RAM you don't need. |
| **Kinsta** | $35–$115/mo | Beautiful UX. Container isolation. But $35/site adds up fast — and [no email hosting included](https://divicake.com/blog/kinsta-performance-and-pricing/). Vendor lock-in. |
| **SiteGround** | $2.99–$15/mo | Cheap to start, oversells, slows you down at scale. Renewal pricing 3x intro. |
| **Raw VPS** (Hetzner / DigitalOcean / Linode) | $4–$10/mo | Total power. Zero guardrails. One typo = client site gone. You're the sysadmin now. |
| **RunCloud + your VPS** | $8–$15/mo + $4 VPS | The smart pick. GUI on top of any cloud. Root access. Auto-backups. But it *manages* — it doesn't *watch*, *diagnose*, or *heal*. |

**Most people pick GoDaddy because they don't know better.** The smart ones pick Cloudways for ease — and pay 3x what they should. The rest go raw VPS and become accidental sysadmins.

[**RunCloud**](https://runcloud.io) is genuinely the smartest piece of infrastructure no one's heard of:

- **Provider freedom** — works with any cloud (Hetzner, DigitalOcean, AWS, Vultr, Linode, your own metal). Cloudways locks you to 5.
- **You keep root.** Cloudways doesn't give you root. RunCloud does.
- **Stop paying anytime.** Your VPS keeps running with all your sites. Cloudways = pay or lose everything.
- **Stack flexibility.** Pure NGINX or hybrid Apache+NGINX. Your call. Cloudways = take what they give you.
- **Real isolation.** Each web app runs as its own system user. Mistakes stay scoped.
- **$8/mo flat for the panel.** No per-site tax.

So: **Hetzner CX21 ($5/mo) + RunCloud ($8/mo) = $13/mo total.** You get the equivalent of Kinsta ($35–$115) with WordPress + Laravel + Node + n8n + anything else on the same box. Your data on your hardware.

The catch? RunCloud is a **management panel**. It does not watch. It does not diagnose. It does not heal. It does not learn.

**That's where Perch lives.**

---

## What No One Else Is Doing

| | GoDaddy / Bluehost | Cloudways | Kinsta | SiteGround | RunCloud (alone) | **RunCloud + Perch** |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Provider freedom | ❌ | Limited | ❌ | ❌ | ✅ | ✅ |
| Root access | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Run any stack (WP+Node+n8n) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **AI-native (Claude Code)** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Self-learning brain** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Plain-English diagnosis** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| **WordPress deep-audit (DB, plugins, CVE, perf)** | Partial | Partial | ✅ | Partial | ❌ | ✅ |
| **Auto-fix safe issues** | Limited | Limited | ✅ | Limited | ❌ | ✅ |
| **Multi-channel alerts (Telegram/Slack/HTTP)** | ❌ | Email only | Email only | Email only | Email only | ✅ |
| Cost (1 site) | $7.99 | $14 | $35 | $2.99 | $13 | **$13** |
| Cost (10 sites) | $80+ | $140+ | $350+ | Plan upgrade | $13 | **$13** |
| Cost (50 sites) | Unrealistic | $700+ | $1,750+ | Unrealistic | $25 | **$25** |
| Lock-in | High | High | High | Medium | None | None |
| Owns your data | They do | They do | They do | They do | You | **You** |

**The thing nobody is shipping:** an open-source, AI-native intelligence layer that runs on your own server, learns your stack over time, talks to you in any channel you want, and never sends you a renewal email. That's Perch.

---

## The Perch Experience

### From Claude Code

```
You:    /perch wp audit mysite.com
Perch:  📊 Running full audit on mysite.com...

        Database: 8.4MB autoload (urgent — should be <1MB)
                  Top offender: elementor_data 2.1MB
                  47 expired transients (1.8MB recoverable)

        Plugins:  34 active, 6 need updates, 2 vulnerable
                  🔴 Contact Form 7 v5.7 — CVE-2024-XXXX (CVSS 8.1)

        Security: 71/100 (Grade C)
                  Admin username is "admin" — change it
                  xmlrpc.php is publicly accessible

        Backup:   Last run 14h ago, 2.1GB to S3 ✓
                  But: DB backup missing for 3 days (mysqldump connection error)

        Want me to fix the safe stuff? (transients, sessions, CF7 update, DB backup creds)
```

### From Telegram

```
🪶 nginx had a moment on production-1

I checked — config snippet added via RunCloud has a typo on line 47.
I've restarted nginx-rc and the site is back up (took 8 seconds).

Want me to fix that snippet so this doesn't happen again?

[✅ Yes, fix it]  [📄 Show me]  [🔇 Not now]
```

### From your shell

```bash
$ perch status
production-1   ✅  RAM 42%  Disk 67%  Load 0.21
staging-1      ⚠️  RAM 91%  Disk 78%  Load 0.84  ← memory pressure
dev            ✅  RAM 33%  Disk 12%  Load 0.05

$ perch wp errors mysite.com
Likely cause: Plugin "my-plugin" updated 2h ago, now conflicts with theme.
Suggested fix: wp plugin deactivate my-plugin --path=/home/user/public_html
Fixable by Perch: yes

$ perch fix mysite.com
[asks for confirmation, runs the fix, reports back]
```

Same intelligence. Three different surfaces. **Connectors are interchangeable.** Use what fits your day.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    CONNECTORS (your choice)                      │
│  Claude Code MCP · Telegram · Slack · HTTP API · CLI · webhook   │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │ same intelligence, multiple surfaces
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                       PERCH CORE                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐        │
│  │   Brain      │  │   Gateway    │  │   SSH + RunCloud │        │
│  │   SQLite KB  │  │   Alerts     │  │   API clients    │        │
│  │   Self-learn │  │   Friendly   │  │   Safe execution │        │
│  └──────────────┘  └──────────────┘  └──────────────────┘        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐        │
│  │            INTELLIGENCE MODULES                      │        │
│  │  WordPress · Watcher · Diagnostician · Healer        │        │
│  │  (DB · Plugins · Security · Backup · Images ·        │        │
│  │   Performance · Errors · White Screen Diagnosis)     │        │
│  └──────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────┘
                              ▲
                              │ SSH + RunCloud API v3
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│              YOUR INFRASTRUCTURE (you own everything)            │
│  Hetzner · DigitalOcean · AWS · Vultr · Linode · bare metal      │
│  WordPress · Laravel · Node · n8n · Python · static · anything   │
└──────────────────────────────────────────────────────────────────┘
```

The brain is the moat. Every audit, every fix, every problem gets logged to a SQLite database on **your** server. Over weeks, Perch learns your stack — what's normal for *your* memory baseline, which plugins are problem children on *your* PHP version, what fixes actually worked when *your* nginx crashed at 2am.

Nobody else has this data. Not RunCloud. Not Cloudways. Not Aditya. **You.**

---

## Install in 5 Minutes

### Path A — As a Claude Code MCP (recommended)

Get every `/perch_*` tool inside your Claude Code sessions.

```bash
git clone https://github.com/adityaarsharma/perch
cd perch
npm install && npm run build
```

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "perch": {
      "command": "node",
      "args": ["/absolute/path/to/perch/dist/index.js"],
      "env": {
        "RUNCLOUD_API_KEY": "your-runcloud-api-key"
      }
    }
  }
}
```

Restart Claude Code. Type `/perch_brain` to verify. Done.

### Path B — Connectors (Telegram / Slack / HTTP)

Run on the server you want to watch. Provides 24/7 alerts when you're away from Claude Code.

```bash
ssh root@your-server
git clone https://github.com/adityaarsharma/perch /opt/perch
cd /opt/perch/telegram-bot
cp config.example.env .env
# Edit .env with your bot token, chat ID, fix-server token
./setup.sh
```

The setup wizard walks you through it. Telegram bot ready in under 5 minutes. (Slack guide: [docs/slack.md](docs/slack.md). Webhook + custom connector: [docs/install.md](docs/install.md).)

### Path C — Both (the agency setup)

Claude Code for deep work. Connector for 4am pages. Same brain, same data, same intelligence, two surfaces.

**Full install guide with screenshots and troubleshooting → [docs/install.md](docs/install.md)**

---

## What's Inside

```
perch/
├── src/
│   ├── index.ts                   ← MCP server (150+ tools — RunCloud + Perch)
│   ├── core/
│   │   ├── brain.ts               ← SQLite knowledge base (your data, your server)
│   │   ├── gateway.ts             ← Alert formatter (friendly tone, multi-channel)
│   │   └── ssh-enhanced.ts        ← SSH with password + private key + WP-CLI helper
│   └── modules/
│       └── wordpress/             ← The WordPress Killer Series
│           ├── db.ts              ← Autoload audit, transient cleanup, orphan detection
│           ├── plugins.ts         ← Plugin audit + Wordfence Intelligence CVE scan
│           ├── security.ts        ← 12-check hardening, scored 0–100
│           ├── backup.ts          ← Backup health, last run age, destination check
│           ├── images.ts          ← CLI image optimization (jpegoptim/optipng/cwebp)
│           ├── perf.ts            ← Performance snapshot (cache, cron, PHP, TTFB)
│           └── errors.ts          ← Error diagnosis + white screen root cause
│
├── telegram-bot/                  ← Telegram connector (one of many)
│   ├── bot.py                     ← Polling bot with inline keyboards
│   ├── fix-server.py              ← Local HTTP API (127.0.0.1 only)
│   ├── monitor.sh                 ← Cron-based health alerting
│   ├── setup.sh                   ← Interactive setup wizard
│   └── scripts/                   ← Shell scripts for each fix action
│
├── docs/
│   ├── runcloud.md                ← Full RunCloud server reference (nginx-rc, paths, gotchas)
│   ├── install.md                 ← Setup guides — MCP, connectors, both
│   ├── telegram.md                ← Telegram connector deep-dive
│   ├── slack.md                   ← Slack connector setup
│   └── safety.md                  ← What Perch will and won't do (read this)
│
└── README.md                      ← You are here
```

---

## The WordPress Killer Series — What Perch Knows About Your Sites

No plugin needed on the WordPress side. Everything runs via SSH and WP-CLI. RunCloud-aware (knows about `nginx-rc`, `/etc/nginx-rc/`, per-app users at `/home/{user}/webapps/`).

| Module | Catches |
|--------|---------|
| **Database** | Autoload bloat (Elementor, expired transients, orphaned WC sessions, postmeta orphans, table fragmentation, slow queries) |
| **Plugins** | Vulnerable plugins via Wordfence Intelligence (free, no API key), abandoned plugins (no updates 2+ years), hidden inactive plugins still on disk |
| **Security** | Admin username = "admin", xmlrpc.php exposed, wp-config permissions, file editor enabled, debug.log publicly accessible, missing rate limits, WP version exposed in headers, core checksum mismatches |
| **Backup** | Last run age, missing DB dumps, truncated backup files, S3/destination unreachable, mismatched retention |
| **Images** | Lossless JPEG/PNG compression (jpegoptim, optipng, pngquant), WebP generation alongside originals, savings estimate before run, scheduled or on-demand |
| **Performance** | PHP version EOL, object cache (Redis/Memcached) connected?, page cache type, WP cron health and backlog, TTFB from server, plugin count thresholds |
| **Errors** | Parses PHP error logs, classifies by type, identifies offending plugin/theme, detects plugin conflicts, white screen root cause, suggests one-line WP-CLI fix |

When something breaks, you get this:

```
🔴 White screen on mysite.com

Fatal error: Cannot redeclare 'my_custom_helper'
Conflict between:
  wp-content/plugins/my-plugin/includes/helpers.php:23
  wp-content/themes/mytheme/functions.php:89

my-plugin was updated 2 hours ago — likely introduced this.

[🔇 Deactivate my-plugin]  [📋 Full Error Log]  [↩️ Roll Back Plugin]
```

Not a stack trace. Not "Internal Server Error." A **diagnosis**.

---

## Connectors

Connectors are how Perch talks to you. Pick one. Pick all. Add your own — the gateway is just a function that takes a structured alert and returns a payload.

| Connector | Status | Best for |
|-----------|--------|----------|
| **Claude Code MCP** | ✅ First-class | Deep work — auditing, planning, debugging |
| **Telegram bot** | ✅ Ready | 24/7 alerts on your phone, inline-button fixes |
| **Slack webhook** | ✅ Alerts work | Team channels, daily digests |
| **Slack bot** (slash commands + buttons) | 🔜 Q2 2026 | Full Slack parity with Telegram |
| **HTTP webhook** | ✅ Ready | Plug into anything (n8n, Zapier, Make, custom) |
| **Email** | 🔜 Coming | Stakeholders who don't live in chat |
| **Discord** | 🔜 Community PR welcome | Indie devs / community servers |
| **Custom** | ✅ Build your own | Implement `formatAlert(opts)` — done |

Telegram and Slack are working today. Slack inline buttons + slash commands ship Q2 2026. Other connectors are 50–200 lines each — PRs welcome.

---

## Safety

Perch is paranoid by default. Read this before installing on a production box: **[docs/safety.md](docs/safety.md)**

**The four promises:**
1. **Never destructive without confirmation.** Plugin deactivation, file deletion, config changes — all require an explicit confirm tap.
2. **Credentials never leak.** Passwords / SSH keys / API tokens are encrypted at rest with AES-256-GCM. Redacted from every log, every alert, every error message.
3. **Always reversible.** Last 10 confirmed actions logged. `/perch undo` reverts the most recent. DB content modifications never auto-run.
4. **Always honest.** When Perch fixes something, you get a complete report of what changed before, after, and why.

**Auto-fix whitelist** (no confirm needed): restart crashed services, kill orphan processes, truncate logs >50MB, renew SSL <7d, clear expired transients, clear `/tmp` PHP sessions older than 24h.

**Confirm-required**: anything that modifies content, deactivates plugins, edits configs, stops services, reboots.

**Never auto, ever**: backup restoration, DB content `DELETE`/`UPDATE` on user data, file system `rm` outside `/tmp`, user account changes, Hetzner-level shutdown.

---

## Why Free Forever

Three reasons, all of them honest:

1. **The brain belongs to you.** A free tool that lives on your server can't be paywalled, ad-funded, or rug-pulled. The data is yours. The code is yours. The whole stack is yours.

2. **Per-server tax is the wrong business model.** Cloudways charges 220% over the underlying VPS. Kinsta charges $35/site. Charging you per server you already own is rent-seeking. Perch refuses to play that game.

3. **Free tools build trust.** Aditya runs other paid products ([Pickle](https://github.com/adityaarsharma/pickle), [RankReady](https://github.com/adityaarsharma/rankready), [Jyotisha](https://adityaarsharma.com/astrology)). The ones who try Perch and find it solid become the audience for those. That's the funnel — built on usefulness, not a paywall.

No "Pro tier." No license keys. No telemetry by default. No SaaS dependency. **Forever.**

---

## Roadmap

**Now (April 2026)** — Sprint 1 shipped
- ✅ MCP server with 150+ tools
- ✅ WordPress Killer Series (7 deep modules)
- ✅ SQLite self-learning brain
- ✅ Telegram bot with inline buttons + fix-server
- ✅ Slack alert delivery via webhook
- ✅ RunCloud-aware paths (`nginx-rc`, `/etc/nginx-rc/`, per-app users)

**Next 60 days**
- 🔜 Credential vault (AES-256-GCM encryption)
- 🔜 Undo system (`/perch undo`)
- 🔜 Slack bot (slash commands + buttons, full Telegram parity)
- 🔜 Multi-server dashboard (Telegram-first agency view)
- 🔜 Uptime Kuma webhook integration
- 🔜 Self-update flow (`/perch update`)

**Q3 2026**
- 🔜 Laravel module (queue health, schedule runner, artisan automation)
- 🔜 Node.js module (PM2 deep monitoring, memory leak detection)
- 🔜 n8n module (workflow health, execution audit)
- 🔜 Pattern recognition v2 (Perch correlates issues across servers — "this is the 3rd time this month, here's the permanent fix")

**2027**
- Cross-server federated learning (opt-in, anonymized) — Perch learns from the network without anyone giving up their data

---

## Built by Aditya

Aditya Sharma — solo builder, open-source. Marketing & growth lead at [POSIMYTH Innovation](https://posimyth.com). Runs his own infrastructure. Built Perch because he was tired of the choice between $200/mo Kinsta and 4am SSH panic.

[Website](https://adityaarsharma.com) · [Twitter/X](https://x.com/adityaarsharma) · [Pickle](https://github.com/adityaarsharma/pickle) · [RankReady](https://github.com/adityaarsharma/rankready)

Not affiliated with RunCloud. Perch works **with** RunCloud — RunCloud is the safety layer (GUI + isolation + backups), Perch is the intelligence layer on top. Both are needed. Together they replace $35–$115/month managed hosting at $13/month.

---

<div align="center">

**Stop renting your server's intelligence. Start owning it.**

[Install Perch](#install-in-5-minutes) · [Read the docs](docs/) · [Star on GitHub](https://github.com/adityaarsharma/perch) · [File an issue](https://github.com/adityaarsharma/perch/issues)

</div>
