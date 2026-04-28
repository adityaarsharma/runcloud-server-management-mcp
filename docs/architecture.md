# Perch — Architecture

Canonical reference. When in doubt, follow this doc.

Last revised: 2026-04-27 (Perch v2.5 — Monitor elevated to top-level layer). Predecessor block-model doc preserved at [`architecture-blocks-legacy.md`](./architecture-blocks-legacy.md) for reference.

---

## TL;DR

Perch is a **5-layer system** with a per-host SQLite **brain** and modules organised in two dimensions: **Stack vs Platform** (where they operate) and **Performance / Security / Cleanup / Operations / Diagnostics / Plugin-specific** (what domain they cover).

**The 5 layers (top → bottom):**

1. **Connectors** — talks to user. Two surfaces: A (Notifier: Telegram · Slack · Email · Webhook) + B (AI Plugin: Claude Code MCP · ChatGPT · Gemini · CLI · HTTP).
2. **Reasoning** — Orchestrator + 6 specialists + Guardrails enforcer.
3. **Monitor** — own layer. Watch tier (probes/webhooks-in) + Decide tier (rules/dedup/severity). Emits typed `Event`.
4. **Executor (apps)** — Stack + Platform modules. The actual server work.
5. **Brain** — per-host SQLite, logical rooms.

**The single boundary that defines safety:**

> **Both Connector surfaces have the same READ powers — brain memory + live read-only modules (server IP, visits, ports, df, ps, …).**
> **They differ on WRITES: Surface A can only write via `Smart Fix` cards; Surface B has full writes, gated by Guardrails.**
> **The LLM is the connector — that's Perch's moat.**

Each Reasoning domain gets its own LLM **specialist**; the Orchestrator routes user intent to the right specialist. See [`connectors.md`](./connectors.md) and [`monitor.md`](./monitor.md) in depth.

> **What changed in v2.5:**
> - Monitor elevated from sub-layer to its own top-level layer (different beast, evolves fastest).
> - Layer order: Connectors (1) → Reasoning (2) → Monitor (3) → Executor (4) → Brain (5).
> - Surface boundary redrawn: same reads on both sides; Smart Fix vs full-writes is the only difference.
> - Telegram/Slack/Email belong exclusively to Surface A (Notifier). Real conversational ops with full writes happen via Surface B (AI Plugin) channels: Claude Code MCP / ChatGPT / Gemini / CLI / HTTP.
> - Monitor splits internally into Watch + Decide tiers.
> - `BRAIN.conversations` room (every chat persisted) — added in v2.4, retained.

---

## The 5 layers

```
╔═══════════════════════════════════════════════════════════════════════╗
║  (1) CONNECTORS                                                       ║
║                                                                       ║
║   ┌─ Surface A: NOTIFIER (Telegram · Slack · Email · Webhook) ─────┐  ║
║   │   Reads:  BRAIN memory + live read-only modules                │  ║
║   │           (server IP, visits, ports, df, ps, logs, audits)     │  ║
║   │   UI:     [🔧 Smart Fix]  [💤 Snooze 1h]  [✅ Ack]              │  ║
║   │                                                                │  ║
║   │   ┌── SMART FIX (own component, group-breaking automation) ──┐ │  ║
║   │   │  ONE button on every alert. ONE callback shape:          │ │  ║
║   │   │     perch:smart-fix:<alert_id>                           │ │  ║
║   │   │  ONE router: SMART_FIX_REGISTRY (alert_id → action).     │ │  ║
║   │   │  Internal scripts (fix-nginx, clear-logs, renew-ssl,     │ │  ║
║   │   │  fix-php-fpm, smart-fix.sh, …) are hidden from users.    │ │  ║
║   │   │  Adding a new alert type = ONE registry entry, no new    │ │  ║
║   │   │  buttons, no new endpoints. Learning loop promotes       │ │  ║
║   │   │  proven manual patterns into the registry nightly.       │ │  ║
║   │   └──────────────────────────────────────────────────────────┘ │  ║
║   │                                                                │  ║
║   │   Writes: ONLY via Smart Fix (registry-bounded, alert-aware)   │  ║
║   └────────────────────────────────────────────────────────────────┘  ║
║                                                                       ║
║   ┌─ Surface B: AI PLUGIN (Claude Code MCP · ChatGPT · Gemini ─────┐  ║
║   │                       · CLI · HTTP API)                        │  ║
║   │   Reads:  Same as Surface A                                    │  ║
║   │   Writes: FULL — every Stack/Platform module, Guardrails-gated │  ║
║   │   Scope:  server topics only · soft tone · refuses off-topic   │  ║
║   └────────────────────────────────────────────────────────────────┘  ║
║                                                                       ║
║   Both surfaces persist every chat turn → BRAIN.conversations         ║
╚════════════════════════════╤══════════════════════════════════════════╝
                             ↓
╔═══════════════════════════════════════════════════════════════════════╗
║  (2) REASONING                                                        ║
║  ┌─ ORCHESTRATOR (intent → specialist routing) ─────────┐             ║
║  │   PERFORMANCE · SECURITY · CLEANUP · OPERATIONS ·    │             ║
║  │   DIAGNOSTICS · PLUGIN-SPECIFIC ← sub-agents         │             ║
║  └──────────────────────────────────────────────────────┘             ║
║  + Recommend engine · Guardrails enforcer · Cost meter                ║
╚════════════════════════════╤══════════════════════════════════════════╝
                             ↓
╔═══════════════════════════════════════════════════════════════════════╗
║  (3) MONITOR  (own layer · own folder · evolves fastest)              ║
║                                                                       ║
║   ┌─ WATCH tier ──────────────────────────────────────────────────┐  ║
║   │  Scheduler · Probes (uptime, ports, services, disk, ssl,     │  ║
║   │   logs, visits, ssh-auth, wp-specific, …)                    │  ║
║   │  Webhooks-in (RunCloud · Cloudflare · GitHub · custom)       │  ║
║   │  Output: ProbeResult                                          │  ║
║   └─────────────────────────────┬────────────────────────────────┘  ║
║                                 ↓                                    ║
║   ┌─ DECIDE tier ─────────────────────────────────────────────────┐  ║
║   │  Rules-as-data (BRAIN.guardrails) · thresholds · anomalies   │  ║
║   │  Severity grader · dedup                                      │  ║
║   │  Output: Event { host, type, severity, signal, ctx }         │  ║
║   └─────────────────────────────┬────────────────────────────────┘  ║
║                                 │                                    ║
║   uses Layer 4 (read-only) to see · emits Events back UP to Layer 1  ║
║   (Notifier consumes them)                                           ║
╚════════════════════════════╤══════════════════════════════════════════╝
                             ↓
╔═══════════════════════════════════════════════════════════════════════╗
║  (4) EXECUTOR  (apps)                                                 ║
║  ┌── STACK modules (operate INSIDE the server) ─────────┐             ║
║  │ src/modules/stack/wordpress/{performance,security,   │             ║
║  │   cleanup,operations,diagnostics,plugins}/           │             ║
║  │ src/modules/stack/{nodejs,laravel,static}/  (future) │             ║
║  │ via SSH + CLI (wp-cli, find, openssl, …)             │             ║
║  └──────────────────────────────────────────────────────┘             ║
║  ┌── PLATFORM modules (operate ABOVE the server) ───────┐             ║
║  │ src/modules/platform/{runcloud,hetzner,cloudflare,   │             ║
║  │   github}/                                           │             ║
║  │ via REST APIs                                        │             ║
║  └──────────────────────────────────────────────────────┘             ║
║  Every module: read-only audit + (gated) mutating actions             ║
║  Always: log to BRAIN.actions; check BRAIN.guardrails first           ║
╚════════════════════════════╤══════════════════════════════════════════╝
                             ↓
╔═══════════════════════════════════════════════════════════════════════╗
║ (5) BRAIN  (~/.perch/brain.db)                                        ║
║ Logical ROOMS:                                                        ║
║   secrets · guardrails · problems · actions · knowledge · webapps ·   ║
║   incidents · timeseries · audit_log · conversations                  ║
╚═══════════════════════════════════════════════════════════════════════╝
```

---

## Layer responsibilities

| # | Layer | Sub-layer | Owns | Doesn't own |
|---|---|---|---|---|
| 1 | **Connectors** | **Notifier** (Surface A) | Telegram/Slack/Email/Webhook channels · LLM compose · brain-backed chat · live read-only module orchestration · Smart Fix runner · button callbacks | Big writes · what to watch · when to fire |
| 1 | **Connectors** | **AI Plugin** (Surface B) | Claude Code MCP · ChatGPT/Gemini plugins · CLI · HTTP API · BYOK LLM · live RO modules · full writes via Reasoning | Watching · alerting |
| 2 | **Reasoning** | — | Intent → plan · ranking · guardrails enforcement · specialist LLM personas · cost meter | Direct shell/SSH · brain writes |
| 3 | **Monitor** | **Watch** | Scheduler · probes · inbound webhooks · raw measurement | Threshold logic · severity · dedup · LLM calls |
| 3 | **Monitor** | **Decide** | Rules-as-data · thresholds · anomalies · severity grading · dedup · Event emission | Probe execution · channel formatting · LLM calls |
| 4 | **Executor (apps)** | — | Stack + Platform modules · audit/mutate functions · SSH/API execution | Deciding when to run · alerting |
| 5 | **Brain** | — | All persistent state in named "rooms" · encrypted secrets | Logic. Just storage + query API |

Hard boundaries:
- **Same reads, different writes.** Both Connector surfaces have full read access (brain + live RO modules). Only Surface B does big writes; Surface A writes only via Smart Fix cards.
- **Smart Fix is registry-bounded** — LLM-judged but only safe, reversible, sub-10s, non-destructive actions qualify.
- **Monitor never calls BYOK LLMs.** It emits structured Events; Notifier prose-ifies.
- **Monitor never writes.** Watch only reads via Layer 4's read-only interface.
- **Executor never alerts directly.** Notifier owns dispatch.

---

## Stack vs Platform — two kinds of modules

The Executor layer has two kinds of modules with different vantage points:

| Type | What it operates on | How it talks | Examples |
|---|---|---|---|
| **STACK** | What's running INSIDE the server | SSH + CLI (wp-cli, find, openssl, etc.) | `wordpress/`, `nodejs/`, `laravel/` |
| **PLATFORM** | The control plane ABOVE the server | REST API | `runcloud/`, `hetzner/`, `cloudflare/`, `github/` |

**Decision rule:** If the operation is *about the platform* (server, webapp, service, cert, backup destination), use a Platform module. If it's *about the application code/data inside a webapp*, use a Stack module.

### Why RunCloud isn't "just another module"

RunCloud is one Platform module but plays five distinct roles:

1. **Discovery** — at onboarding, `GET /servers` seeds `BRAIN.webapps` automatically (zero → 50 webapps in one API key paste)
2. **Cross-server ops** — "disk free across all my servers?" = one API call vs 50 SSH connections
3. **Lifecycle management** — create webapp, issue Let's Encrypt, trigger backup (only RunCloud API can; SSH cannot create panel-tracked entities)
4. **Telemetry** — Monitor (Watch tier) polls `GET /servers/<id>/stats` and writes to `BRAIN.timeseries`
5. **Source of truth for inventory** — nightly reconcile: if BRAIN drifts from RunCloud, RunCloud wins

Future Platform modules (Cloudflare, Hetzner, GitHub) follow the same 5-role pattern.

---

## Sub-sub-modules — the WordPress submodule, broken open

22 capabilities cluster into 6 domains. Each domain is a folder. Each domain has its own specialist (LLM persona) in the Reasoning layer.

```
src/modules/stack/wordpress/
├── performance/          ← "make the site fast"
│   ├── images.ts
│   ├── images-bulk.ts
│   ├── perf.ts
│   ├── thumbnails.ts
│   ├── plugins-perf.ts
│   ├── caching.ts
│   └── lighthouse.ts
├── security/             ← "find and fix security gaps"
│   ├── security.ts
│   ├── malware.ts
│   ├── htaccess.ts
│   ├── ssl.ts
│   ├── wp-config.ts
│   └── plugins.ts        (CVE checks)
├── cleanup/              ← "free disk + DB bloat"
│   ├── media-orphans.ts
│   ├── revisions.ts
│   ├── translations.ts
│   ├── plugins-cleanup.ts
│   └── db.ts             (transients, autoload, fragmentation)
├── operations/           ← "daily admin work"
│   ├── backup.ts
│   ├── core.ts           (WP core update)
│   ├── search-replace.ts
│   ├── cron.ts           (WP-Cron + rewrite flush)
│   ├── multisite.ts
│   └── email-test.ts
├── diagnostics/          ← "what's wrong right now"
│   ├── errors.ts
│   └── disk.ts
├── plugins/              ← "specialised per major plugin"
│   ├── woocommerce.ts
│   ├── yoast.ts
│   ├── elementor.ts      (future)
│   ├── divi.ts           (future)
│   └── acf.ts            (future)
└── recommend.ts          ← top-level aggregator (calls all specialists)
```

Future Stack modules (`stack/nodejs/`, `stack/laravel/`) follow the same 6-domain shape so users learn one mental model.

---

## Specialists — the multi-agent layer

Each domain has a specialist in `src/reasoning/specialists/`. A specialist is a small TS file (~100-150 lines) with:

- A focused **system prompt** for its domain
- The **list of modules** it can call
- **Cross-module heuristics** nobody else knows ("low Redis hit rate + high TTFB → install page cache")
- A **brain history filter** (only sees Performance-related past events, not unrelated noise)

```ts
// Example: src/reasoning/specialists/performance.ts (sketch)
export class PerformanceSpecialist {
  domain = 'performance';
  modules = [
    'wp.images_compress_bulk_start',
    'wp.caching_audit',
    'wp.lighthouse_audit',
    'wp.thumbnails_audit',
    'wp.plugins_perf_profile',
  ];

  async plan({ webapp, intent, brain }) {
    const past = await brain.knowledge.search({ domain: 'performance', host: webapp.host });
    // LLM call with focused system prompt + filtered history
    return this.llm.plan({ intent, past, modules: this.modules });
  }
}
```

The Orchestrator (in `src/reasoning/orchestrator.ts`) classifies the user's intent into a domain, then delegates to that specialist.

---

## Brain rooms

The brain is one SQLite file (`~/.perch/brain.db`) organised as logical "rooms." One file per host = trivial backup (`cp brain.db brain.db.bak`).

| Room | Stores | Used by |
|---|---|---|
| 🔐 `secrets` | SSH passwords, API keys, salts (encrypted with `PERCH_MASTER_KEY`) | Connectors (creds resolution), Executor (SSH auth) |
| 📋 `guardrails` | Rules: "never delete X", "always backup before update", per-host overrides | Reasoning (enforces before any mutating call) |
| ⚠️ `problems` | Every issue found (type, root_cause, snippet, severity, host) | Reasoning (recommend), Notifier (alert if recurring) |
| 🔧 `actions` | Every action attempted (tool, args, outcome, undo data) | Reasoning (avoid retry-loops), Connectors (`/perch undo`) |
| 📚 `knowledge` | Patterns repeated across runs, LLM-extracted facts (bi-temporal) | Reasoning (boost confidence) |
| 🌐 `webapps` | Per-host inventory: WP path, user, type, last-audited | All layers |
| 🚨 `incidents` | Open/ack/resolved with timeline + linked problems | Notifier (don't re-alert), Reasoning (postmortem) |
| 📊 `timeseries` | Disk %, response time, plugin count over time | Notifier (trend alerts), Reasoning (capacity planning) |
| 📜 `audit_log` | Immutable trail of every Perch decision (who, what, why, outcome) | Compliance, debugging |
| 💬 `conversations` | Every chat turn (msg, reply, tool calls, tokens) scoped per host. **Added v2.4.** | Both surfaces (load context next turn); Notifier (knows past chats when composing) |

See [`brain.md`](./brain.md) for room API + schema. See [`guardrails.md`](./guardrails.md) for rule syntax.

### How the brain stays smart (self-updating + reasoning)

Three LLM-driven background jobs (model from `PERCH_LLM_MODEL` env, default `claude-haiku-4-5`):

1. **Fact extractor (post-event hook)** — when a problem is logged, Claude extracts structured facts into `knowledge` with bi-temporal fields (`learned_at`, `valid_at`).
2. **Pattern finder (nightly cron)** — Claude reads last-7-days events, surfaces patterns into `knowledge`.
3. **Conflict resolver (per-write)** — when new fact contradicts old, Claude judges; old marked `superseded_by` with timestamp + reason. No facts ever deleted; history preserved.

Optional sidecar (v2.4+): **sqlite-vec** for embeddings + similarity search ("have we seen this error before?").

We deliberately do NOT adopt Mem0 or Graphiti wholesale — they're chat-shaped memory; Perch's data is ops-shaped. We borrow their best ideas (auto fact-merge, bi-temporal facts, contradiction handling) but run them on our SQLite to keep the "self-hosted, free forever, no extra services" promise.

---

## Guardrails — first-class rules-as-data

Today's `confirm: true` checks are scattered across `server.ts`. Guardrails consolidates them into editable rules in `BRAIN.guardrails`.

A guardrail is a rule: `(host, action, args) → allow | deny | require_human_confirmation`.

```yaml
- id: prod-hosts-need-confirm
  match: { host_tag: prod }
  on: [wp.core_update, wp.search_replace, wp.plugins_cleanup_apply]
  rule: require_human_confirmation
  reason: "Production hosts always need a human ack before mutating."

- id: backup-before-core-update
  match: { tool: wp.core_update }
  precondition: { wp.backup_health: { ageHours: { lt: 24 } } }
  rule: deny_if_precondition_fails
  reason: "Refuse core update if last backup is older than 24h."
```

See [`guardrails.md`](./guardrails.md) for full syntax + built-in rules.

---

## Smart Fix — own component inside Surface A

Smart Fix is a first-class piece of Surface A, not just a button label. It is the **group-breaking automation** Perch ships with: every alert across every probe lands on the same three-button shape, and the first button always says **🔧 Smart Fix**. Behind that one button is a single algorithm that knows how to translate "this alert" into "this action".

### One button, one callback, one registry

```
Telegram alert (any rule)        ┌─────────────────────────────────┐
   │                             │   SMART_FIX_REGISTRY            │
   │   [🔧 Smart Fix]            │                                 │
   │      callback_data:         │   nginx_down       → fix-nginx  │
   │      perch:smart-fix:       │   php_fpm_down     → fix-php-fpm│
   │      <alert_id>             │   mysql_down       → fix-mysql  │
   ▼                             │   disk_high|warn|crit            │
   ┌──────────────────────┐      │                    → clear-logs │
   │ POST /smart-fix      │ ───▶ │   ram_*  cpu_*     → smart-fix  │
   │  body { alert_id }   │      │   ssl_expiring|crit→ renew-ssl  │
   └──────────────────────┘      │   orphans          → smart-fix  │
                                  │   site_down        → fix-nginx  │
                                  │   site_5xx         → smart-fix  │
                                  │   ports_down       → fix-services│
                                  │   fail2ban_spike   → None       │
                                  │   backup_age       → None       │
                                  │   ⟨unknown⟩        → smart-fix  │
                                  └─────────────────────────────────┘
                                                │
                                                ▼
                                  Run script · log to BRAIN.actions
                                  · Telegram reply with outcome
```

### Why it's its own component

- **One source of truth.** Adding a new alert type → one new entry in `SMART_FIX_REGISTRY`. Not a new endpoint. Not a new callback name. Not a new button.
- **No leaked internal names.** Users don't see `fix-nginx` / `clear-logs` / `renew-ssl` in any callback or button. Just `Smart Fix`. The internal scripts can be renamed or replaced without breaking a single Telegram message ever sent.
- **Safe-by-construction.** Alerts with no safe auto-fix (`fail2ban_spike`, `backup_age`) have `None` in the registry → router replies *"no safe auto-fix exists, investigate via Claude Code MCP"* instead of guessing.
- **Learning loop hooks in here.** [`scripts/smart-fix-learn.ts`](#) (nightly cron) reads `BRAIN.actions_log`, finds patterns where a manual fix worked ≥3 times for the same `(host, action_type)`, and proposes it as a new registry entry. One human ack → auto-fix from the next alert onwards.
- **Single audit trail.** Every Smart Fix run logs to `BRAIN.actions_log` with `action_type='smart_fix.<alert_id>'` so the learning loop can mine it and the user can `/perch undo`.

### Code locations

- **Router:** `telegram-bot/fix-server.py` — `SMART_FIX_REGISTRY` dict + `POST /smart-fix` handler.
- **Trigger:** `telegram-bot/monitor.sh` — `BTN_3 <alert_id>` helper, called from every `send_alert` site.
- **Dispatchers:** `telegram-bot/bot.py` (standalone) and Niyati's `call_fix_server` (Aditya's deploy) — both recognise `perch:smart-fix:<alert_id>` callback shape and POST to `/smart-fix`.
- **Learning loop:** `src/scripts/smart-fix-learn.ts` — nightly cron promotes proven patterns into the registry.

### Hard rule

Smart Fix never runs an action outside the registry. Even if a user crafts a callback by hand. Even if a probe emits a brand-new alert_id — the router falls back to the catch-all `smart-fix.sh` (which itself only does narrow zombie-reap + log-trim) rather than guessing. The registry IS the safety boundary.

---

## End-to-end flows (two worked examples — one per surface)

### Flow A — Surface A (Monitor → Notifier → Smart Fix)

`startupcooking.net` disk crosses 95%.

1. **Monitor → `disk` probe** runs (5m interval), measures 96%, matches rule `disk-critical` → emits `Event { host: startupcooking.net, type: disk.critical, severity: critical, signal: 96, raw: {...}, context: { related_incidents: [...] } }`.
2. **Monitor** writes to `BRAIN.incidents` (status=open) and `BRAIN.timeseries`.
3. **Notifier → composer** reads Event + brain (incidents/knowledge/webapps/conversations) → BYOK LLM drafts: *"Disk 96% on startupcooking.net. ~5 GB orphan media in `/uploads/2024/` — past Smart Fix freed 24 GB safely. Want me to do the same?"*
4. **Notifier → dispatcher** sends Telegram card with `[Smart Fix] [Snooze 1h] [Ignore]`.
5. User taps `Smart Fix`.
6. **Smart Fix runner** → LLM picks `wp.cleanup_media_orphans_apply` from registry → **Guardrails enforcer** checks (host=prod, action allowed, has rollback) → "Perching..." status posted.
7. **Executor** runs the action via SSH, logs to `BRAIN.actions`.
8. **Notifier** reports outcome: *"Done. Freed 5.2 GB. Disk now 78%."*
9. **Brain LLM hooks** extract facts into `knowledge` ("orphan-media pattern works on startupcooking.net, run-2").

### Flow B — Surface A free-text (Telegram chat with brain + live RO)

User in same Telegram chat: *"why was my site slow yesterday?"*

1. **Notifier session** loads recent context from `BRAIN.conversations` (host-scoped).
2. **BYOK LLM** reads `BRAIN.incidents` + `BRAIN.timeseries` for yesterday → answers conversationally: *"At 14:30 IST, php-fpm pool saturated for 4 minutes. Notifier auto-restarted it via Smart Fix. Want me to pull the access logs from that window?"*
3. User: *"yes pull logs"*
4. LLM fires Layer 4 read-only module `wp.diagnostics_errors` → summarises.
5. User: *"delete those error logs"*
6. **`refuse-write.ts`** intercepts: *"That's a write — I don't do those from Telegram. The next Smart Fix card can rotate logs, or fire up Claude Code and I'll run it there."*
7. Every turn persisted to `BRAIN.conversations`.

### Flow C — Surface B (Claude Code MCP, full read+write)

User in Claude Code: *"audit and fix the slow plugin on startupcooking.net"*

1. **MCP channel** (Surface B) routes via Reasoning → Performance specialist.
2. Specialist reads `BRAIN.knowledge` for prior performance work on this host.
3. Specialist plans: `wp.plugins_perf_profile` (read) → identify culprit → propose action.
4. **Live read** runs via Layer 4 → top offender: `akismet`, 4.2s/page.
5. LLM proposes: clear object cache + reload `php-fpm`. Plan shown to user.
6. User confirms.
7. **Guardrails enforcer** (Layer 2) checks → host=prod, requires `CONFIRM` → user types CONFIRM.
8. **Executor** runs the writes; logs every step to `BRAIN.actions` + `BRAIN.audit_log`.
9. Specialist verifies (re-runs profile) → reports back conversationally.
10. Turn persisted to `BRAIN.conversations`.

User never sees layers. Sees a competent ops assistant who's safe on their phone and powerful at their desk.

---

## What's IN scope vs OUT

| In scope | Out of scope |
|---|---|
| Single-user per host | Multi-tenant SaaS (community fork option) |
| Self-hosted SQLite brain | Cross-host fleet brain (v3.x) |
| LLM-driven smart writes | LLM that mutates without human-in-loop |
| Telegram, Slack, Email, Webhook channels | iOS/Android apps |
| RunCloud + Hetzner + Cloudflare + GitHub | AWS, GCP, Azure (community-contributed) |
| WordPress, NodeJS, Laravel, static | Every framework |
| Closed-loop postmortem after incidents | Auto-fix critical without human ack |

---

## What's MATURE today (v2.3 shipped)

- Module pattern (audit + gated mutating, log to brain)
- SSH + Vault + Brain core foundations
- HTTP API with Bearer + rate limit + allowlist
- 22 WordPress capabilities organised into 6 sub-sub-module domains
- RunCloud API wrapper
- LLM-judged static-vs-dynamic intent (in `bot.py` — to be ported into Surface A's `chat.ts`)
- `monitor.sh` cron with Telegram + Slack mirroring (to be ported into `src/monitor/`)

## What's DESIGNED but NOT yet implemented (v2.5 design lock)

- 🟡 5-layer order locked: Connectors → Reasoning → Monitor → Executor → Brain
- 🟡 Connectors split into Surface A (Notifier) + Surface B (AI Plugin)
- 🟡 Monitor as own top-level layer with Watch + Decide internal tiers
- 🟡 Surface A: brain + live RO reads; writes only via Smart Fix card
- 🟡 Surface B: full reads + full writes (Guardrails-gated)
- 🟡 BYOK LLM (Gemini reference) wired into both surfaces
- 🟡 `BRAIN.conversations` room + per-host chat persistence
- 🟡 Bot personality (server-scope-locked, soft tone) via `system-prompt.ts`
- 🟡 Smart Fix learning loop (last-7d patterns → human ack → auto-promotion)

## What's MISSING (v2.5 → v2.7)

- ❌ Inbound webhooks (RunCloud/Cloudflare/GitHub) — designed for Monitor, not built
- ❌ Smart Fix promotion gate (nightly LLM proposes new candidates)
- ❌ Cost meter (LLM API call tracking per session/host)
- ❌ Brain backup/restore (export/import of `brain.db`)
- ❌ Guardrails-as-data (today scattered in code; Monitor rules will share this store)
- ❌ Cross-host fleet view
- ❌ Specialist LLM personas (scaffolds shipped in v2.3; full implementation pending)

---

## Files for new contributors / agents (read in order)

1. [`architecture.md`](./architecture.md) — this file
2. [`connectors.md`](./connectors.md) — Layer 1 (Surface A + Surface B)
3. [`monitor.md`](./monitor.md) — Layer 3 (own beast; Watch + Decide tiers; probes, rules, growth plan)
4. [`specialists.md`](./specialists.md) — Layer 2 sub-agent design
5. [`brain.md`](./brain.md) — Layer 5 room schemas (incl. `conversations`)
6. [`guardrails.md`](./guardrails.md) — rule syntax (used by Reasoning AND by Monitor's Decide tier)
7. [`blocks/wordpress-images.md`](./blocks/wordpress-images.md) — case study of a complete module pair
8. `src/core/` — read first: `ssh-enhanced.ts`, `brain.ts`, `vault.ts`
9. `src/api/server.ts` — every endpoint (will become `src/connectors/ai-plugin/channels/http-api.ts` in v2.5 implementation)
10. `src/modules/stack/wordpress/<domain>/<feature>.ts` — copy this pattern when adding modules

---

## When to revise this document

- Adding or removing a layer (rare; 5 should stay stable)
- Reordering layers (currently: Connectors → Reasoning → Monitor → Executor → Brain)
- Adding a brain room
- Changing the guardrails contract or Monitor rules contract
- Reorganising Connectors surfaces (Notifier / AI Plugin), Monitor tiers (Watch / Decide), or Executor sub-layers
- Changing the Surface A ↔ Surface B boundary (currently: same reads, Smart-Fix-only writes for A vs full writes for B)

The diagram + layer responsibilities are canonical. Every other doc should be consistent with this one.
