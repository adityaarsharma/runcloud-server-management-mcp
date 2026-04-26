# Vision — Perch

> 🪶 Servers under one wing.
> The Telegram bot + Claude Code plugin that makes RunCloud server management as easy as Vercel.
> Built for agencies, freelancers, and devs who manage many client servers.

**Repo:** [github.com/adityaarsharma/perch](https://github.com/adityaarsharma/perch)
**Brand:** Aditya Sharma (personal — ALWAYS FREE)
**Tagline:** Servers under one wing.

---

## The Problem

Running production servers today is a mess:

- **Direct SSH** — fast for experts, terrifying for everyone else. One wrong `rm -rf` and a client site is gone. No backups by default. No rollback. No audit trail.
- **Hosted PaaS (Vercel, Render, Railway)** — beautiful UX, but locked in, expensive at scale, and you can't run WordPress, Laravel queues, n8n, or anything custom without paying $$$ per service.
- **cPanel/Plesk** — bloated, ugly, slow, expensive licenses, shared-user model, dated UX.
- **Raw cloud (DigitalOcean, Hetzner, AWS)** — full control, zero guardrails. You're the sysadmin now.

There's no middle path that gives you Vercel-grade DX on your own VPS — until you combine RunCloud (the GUI + safety layer) with a Telegram bot (the on-the-go control).

---

## Why RunCloud (Not Direct SSH)

Direct SSH is the wrong default for 90% of people managing servers:

| Direct SSH | RunCloud |
|------------|----------|
| One typo can wipe production | Web app isolation, can't `rm -rf /` from the panel |
| No backups unless you build them | One-click backups + S3/Wasabi integration |
| Manual nginx configs (hours to debug) | Pre-built, tested nginx-rc + extra.d for safe customization |
| Manual SSL renewals or break things | Auto-renewing Let's Encrypt with one toggle |
| Manual PHP version juggling | Switch PHP versions per app with a dropdown |
| No GUI for clients to view | Read-only client access to specific apps |
| Audit trail = your shell history | Built-in activity log |
| Adding a webapp = 30+ commands | Click "New Web App", done |

**RunCloud is the safety layer.** It enforces good defaults: each app gets its own user, its own PHP-FPM pool, its own nginx config block. Mistakes stay scoped.

**Why not Vercel/Render?** Because:
- WordPress, Laravel queues, n8n, MCPs, Python workers — all run native on RunCloud
- $5–$20/month VPS instead of $200+/month per service
- Your data stays on your hardware (Hetzner, DigitalOcean, AWS — your pick)
- No vendor lock-in, no cold starts, no per-request pricing

---

## Why a Telegram Bot

You don't always have your laptop. The 4 a.m. alert, the dinner-table client emergency, the "is the site up?" question while in transit — all need a phone-first answer.

**Telegram is the right channel because:**
- Already on every dev/agency phone
- Handles inline buttons, formatted code, files
- Bots are free, no app to install
- Threads/topics for multi-server organization
- No notification fatigue (you choose what alerts)

**The bot does what RunCloud's mobile experience can't:**
- Real-time alerts when nginx/PHP/MCP/n8n goes down
- One-tap fixes from the alert message itself
- Natural language: "is the store site up?" → live status
- Multi-server view across all client environments
- Run safe diagnostics (disk, ports, logs) without SSH

---

## Brand: Perch 🪶

**Why Perch:**
- Bird-perch metaphor → small, watchful, always there
- Agencies "perch" on top of client servers, watching from above
- Cute + thoughtful + easy to say in any language
- Pairs naturally with bot commands: `/perch status`, `/perch fix`
- Distinct in dev space (no major collisions)

**Tagline:** *Servers under one wing.*

**Voice:** Calm, watchful, friendly. Never scary. Never enterprise-jargon.
**Visual:** Feather + wing motifs. Soft sky/sage palette. Rounded, not sharp.

---

## Target Audience

### Primary: Web agencies (5–50 client sites)
- Manage 3–20 servers across clients
- Need on-call coverage without 24/7 sysadmin
- Want to delegate server access without giving SSH keys
- Charge clients for hosting/maintenance retainers

### Secondary: Solo developers / freelancers
- Run own SaaS on VPS
- Manage handful of client sites
- Want phone alerts when their stuff breaks at 3 a.m.

### Tertiary: WordPress hosting providers (small)
- Use RunCloud to manage 50+ sites
- Need overview dashboard via Telegram
- Need quick-fix patterns built in

---

## What Makes It Vercel-Easy

Three principles:

1. **Defaults that work** — install the bot, point it at your RunCloud account, done. No YAML, no config files for users.
2. **Reversible by design** — every action shows what it will do, then asks. Every fix has a "show me what changed" follow-up.
3. **One language for everything** — disk full, nginx down, SSL expiring, deploy failed — all surface in the same Telegram thread, with the same button-driven UX.

No SSH. No scary terminals. No "edit this file." Just: tap a button, see what happened, move on.

---

## Core Features (V1)

### Bot Commands

| Command | Action |
|---------|--------|
| `/servers` | List all your RunCloud servers, status |
| `/server {name}` | Drill into one server: apps, services, disk, alerts |
| `/apps` | List all web apps across servers |
| `/status` | One-line health of everything |
| `/fix` | Smart fix the active server |
| `/deploy {app}` | Trigger git deployment |
| `/backup {app}` | Create on-demand backup |
| `/logs {app}` | Last 50 lines of nginx/php-fpm error logs |
| `/restart {service}` | Restart nginx/php-fpm/supervisor on active server |

### Auto-Alerts (configurable)

- Server down (ping fail)
- Service crashed (nginx-rc, php-fpm, mysql)
- Disk > 85% full
- SSL expires in 7 days
- Deploy failed
- Cron job failed
- Backup failed

Each alert ships with inline buttons: **🔧 Fix** · **📊 Details** · **🔇 Silence 1h** · **✅ Acknowledge**

### Multi-Server Support

- Connect multiple RunCloud accounts
- Tag servers (client, environment, purpose)
- Group view: all production / all staging / all client X

### Agency Features (V2)

- Multi-user bot (team access with roles)
- Per-client server access
- White-label option for selling to clients
- Slack/Discord/Mattermost mirror

---

## Distribution Model

**Two delivery paths, both free:**

### A) Claude Code Plugin
For devs who use Claude Code:
```
/plugin install runcloud-server
```
Loads the skill + MCP. Bot setup wizard runs in Claude Code. One paste, fully connected.

### B) Standalone GitHub repo
For devs who don't use Claude Code:
```bash
git clone {repo}
cd {repo}
./install.sh
```
Docker-based. Asks for: Telegram bot token, RunCloud API key, server IPs. Done.

---

## Why ALWAYS FREE

- **Community trust** — RunCloud users are loyal; serving them free builds reputation
- **Zero infra cost** — runs on the user's own server, no hosting burden on the maintainer
- **Differentiation** — every competitor charges per server; free permanent forever is unbeatable
- **MCP standard play** — establishes Perch as the standard Telegram + Claude Code interface for RunCloud-managed servers

---

## R&D Roadmap

Patterns are tested on real production servers first. Only generic, RunCloud-relevant patterns get productized:

| Pattern | Status |
|---------|--------|
| Self-healing fix-server with smart-fix logic | ✅ shipped (core V1) |
| Hetzner-level reboot from chat | ✅ shipped (V1) |
| Server status narration via LLM | 🔜 V2 feature (optional, BYO API key) |
| Generic multi-server dashboard | 🔜 V2 feature |
| Cross-server pattern recognition (correlate same issue across the fleet) | 🔜 future |

**Rule:** the public product stays minimal and useful. Anything personal-context-specific stays out.

---

## What This Is NOT

- Not a SaaS — no hosted bot, no monthly fees
- Not a cPanel killer — RunCloud already does that, this just makes it pocket-sized
- Not a monitoring tool (Datadog, Grafana) — it's a control surface, not a metrics platform
- Not WordPress-specific — works for any RunCloud workload (Laravel, Node, Python, static)
- Not a paid plugin — community first, always free

---

## Success Metrics

| Metric | 6-month target | 12-month target |
|--------|----------------|-----------------|
| GitHub stars | 500 | 2,000 |
| Active installs | 200 | 1,500 |
| RunCloud forum mentions | Weekly | Daily |
| Featured by RunCloud (official) | Submitted | Achieved |
| Agencies using it | 50 | 300 |
