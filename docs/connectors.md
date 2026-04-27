# Perch — Connectors

The layer between Perch and you. Telegram, Slack, MCP, CLI, plugins, webhooks.

Last revised: 2026-04-27 (Perch v2.4 design lock).
Sister docs: [`architecture.md`](./architecture.md) · [`monitor.md`](./monitor.md) · [`brain.md`](./brain.md) · [`guardrails.md`](./guardrails.md) · [`specialists.md`](./specialists.md)

---

## The big idea

> **LLM is the connector.** That's Perch's moat.

Every other server tool in the world ships either a dumb dashboard, a dumb bot, or a dumb webhook. Perch's connector layer **thinks**. It reads probes, it reads brain, it composes a sysadmin-grade explanation, it picks safe fixes — all in your channel of choice.

You don't talk to a bot. You talk to **the most informed sysadmin you've ever hired**, who happens to live in Telegram.

---

## Two surfaces, one boundary

The Connectors layer is **two surfaces** with one sharp line:

| Surface | Direction | Reads | Writes |
|---|---|---|---|
| **A. Monitor + Notifier** | server → user (push) | Yes — allowlist | **Only** via `Smart Fix` button |
| **B. AI Conversational** | user ↔ server (pull) | Yes — read-only modules | **Never** |

> **The line: Conversation never mutates. Smart Fix is the only write path.**
> Both surfaces are LLM-driven. Both are bounded by Guardrails.

This is the only mental model you ever need to remember about Perch.

Surface A is itself **two cooperating layers**:

| Sub-layer | Owns | Doesn't own |
|---|---|---|
| **Monitor** | Probes, rules, scheduling, dedup, inbound webhook ingestion. Decides "is there an event worth waking the human?" | LLM calls · message composition · channel formatting · writes |
| **Notifier** | LLM compose · channel dispatch · Smart Fix runner · button callbacks | What to watch · when to fire |

Monitor is where Perch lives or dies — it's the eyes. It's also where most code lands long-term. So it gets its own layer, its own folder, its own [doc](./monitor.md), and its own evolution path.

---

## Layer-by-layer breakdown

```
┌────────────────────────────────────────────────────────────────────┐
│  CONNECTORS                                                        │
│                                                                    │
│   ┌─ Surface A ──────────────────────────────────────────────────┐ │
│   │                                                              │ │
│   │   ┌─ MONITOR  (own layer · own rules · own files) ────────┐  │ │
│   │   │  Probes (uptime/ports/services/disk/ssl/logs/wp/...)  │  │ │
│   │   │  Rules engine · scheduler · dedup · severity grading  │  │ │
│   │   │  Inbound webhooks (RunCloud · CF · GitHub · custom)   │  │ │
│   │   │  Output: structured Event { host · type · severity }  │  │ │
│   │   └──────────────────────────────────┬────────────────────┘  │ │
│   │                                      ↓                       │ │
│   │   ┌─ NOTIFIER  (LLM compose + dispatch + Smart Fix) ──────┐  │ │
│   │   │  Out: Telegram · Slack · Email · Webhook              │  │ │
│   │   │  Compose: LLM reads Event + brain → human-grade msg   │  │ │
│   │   │  UI: [Smart Fix] [Snooze 1h] [Ignore]                 │  │ │
│   │   │  Writes: ONLY via Smart Fix (LLM-judged, registry)    │  │ │
│   │   └───────────────────────────────────────────────────────┘  │ │
│   └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│   ┌─ Surface B: AI CONVERSATIONAL  (READ-ONLY) ──────────────────┐ │
│   │  Telegram DM · Slack · MCP · ChatGPT/Gemini plugin ·         │ │
│   │  CLI · HTTP API                                              │ │
│   │  Engine: user msg → BYOK LLM → static brain → live RO        │ │
│   │  Scope: server topics only · soft tone · refuses off-topic   │ │
│   │  Writes: NEVER. Refuses + suggests Smart Fix.                │ │
│   └──────────────────────────────────────────────────────────────┘ │
│                                                                    │
│   Shared: auth · secrets · audit · guardrails · BYOK LLM ·         │
│           BRAIN.conversations (every chat persisted)               │
└────────────────────────────────────────────────────────────────────┘
                              ↓
                       REASONING → EXECUTOR → BRAIN
```

The legacy "Notifier layer 4" is gone. Its engine lives inside Surface A. Total layers: **4** (Connectors / Reasoning / Executor / Brain).

---

## Surface A — Monitor + Notifier

Surface A is a pipeline: **Monitor** detects events → **Notifier** turns events into human-grade messages and (optionally) Smart Fix actions. They are separated because they evolve at very different rates and answer very different questions.

### End-to-end lifecycle

```
1. MONITOR FIRES       ─→  probe / rule / inbound webhook produces an Event:
                             { host, type, severity, signal, raw, context }
                           Event is staged in BRAIN.incidents (status=open).
2. NOTIFIER COMPOSES   ─→  LLM reads Event + BRAIN (incidents, knowledge,
                             webapps, conversations) and drafts:
                             "what's wrong · why · what Smart Fix would do · context"
3. SEND TO CHANNEL     ─→  card with [Smart Fix]  [Snooze 1h]  [Ignore]
4. USER TAPS:
     Ignore   → close in BRAIN.incidents · dedup quiet for N hours
     Snooze   → re-alert in 1h, same card
     Smart Fix → LLM picks safe action from registry
                 → guardrails check
                 → "Perching..." status message
                 → execute write
                 → report outcome:
                     ✓ "Done. Freed 2.1 GB by clearing /uploads/2024/."
                     ✗ "Couldn't fix because Y. Want me to try Z next?"
                       (suggests next attempt — never retries blindly)
5. EVERYTHING LOGGED   ─→  BRAIN.incidents · BRAIN.actions · BRAIN.audit_log
```

### Monitor — its own layer

> Monitor gets its own folder, its own rules language, and its own [doc](./monitor.md). It's the part of Perch that grows fastest — every new probe, every new rule, every new inbound integration lives here.

Monitor's job is narrow: **decide if there is an event worth surfacing.** It does not call LLMs (Notifier does that). It does not pick fixes (Smart Fix runner does that). It does not format messages (Notifier does that).

#### Components

| Component | Role |
|---|---|
| **Probes** | Per-signal watchers (uptime, ports, services, disk, SSL, logs, WP-specific, …). Each probe is a small TS file with a single `probe()` returning a typed result. |
| **Rules** | Thresholds, anomaly detectors, host overrides. Stored as data in `BRAIN.guardrails` (rules-as-data) — editable per host. |
| **Scheduler** | Cron-style runner; per-probe interval; jittered to avoid thundering herd. |
| **Dedup** | Suppresses repeats while an incident is open or recently snoozed/ignored. |
| **Severity grader** | Maps probe result + rule + history → `info / warn / critical`. |
| **Inbound webhooks** | RunCloud · Cloudflare · GitHub · custom. Treated as external probes — same Event shape downstream. |
| **Event emitter** | Single output: `Event { host, type, severity, signal, raw, context }` → handed off to Notifier. |

#### Built-in probes (seed set, will grow heavily)

| Probe | Watches |
|---|---|
| `uptime` | HTTP status, response time |
| `ports` | 22 / 80 / 443 / 3306 / 6379 / custom |
| `services` | nginx · php-fpm · mysql · redis · queue workers |
| `disk` | % used, growth rate, top consumers |
| `ssl` | cert expiry, chain validity |
| `logs` | 5xx spikes, fatal PHP, OOM, segfault |
| `wp-specific` | slow plugins, Lighthouse drop, malware sigs, orphan media |
| `webhooks-in` | RunCloud / Cloudflare / GitHub / custom (see below) |

See [`monitor.md`](./monitor.md) for probe API, rule syntax, and how to add a new probe.

### Notifier — LLM compose + dispatch

Notifier consumes Events from Monitor and is responsible for everything between "we have an event" and "the user has decided what to do."

| Component | Role |
|---|---|
| **LLM composer** | Reads Event + brain → drafts message in the bot's voice (soft, precise). Caches per-(host, type) so repeated alerts re-use phrasing. |
| **Channel renderer** | Per-channel formatting (Telegram inline keyboards, Slack blocks, email HTML, webhook JSON). |
| **Dispatcher** | Sends to all configured channels for that host + severity. |
| **Button handler** | Routes `Smart Fix` / `Snooze` / `Ignore` callbacks back into the runner / scheduler. |
| **Smart Fix runner** | LLM-picks an action from registry → guardrails → execute → report. Never retries blindly. |

### Smart Fix — LLM-judged, brain-evolved

Smart Fix is **not** a static if/else table. It is:

- A **registry of safe-write actions** seeded with hand-curated fixes
- An **LLM picker** that reads the probe + brain history and chooses the right action (or none)
- A **learning loop** that promotes proven patterns from `BRAIN.actions` into the registry over time

#### Hard rule
**An action qualifies as Smart Fix only if it is reversible AND cannot break the site for >10s AND does not mutate user-generated content destructively.**

If it fails the test → it surfaces as `[Investigate in chat]` instead, deep-linking to Surface B.

#### Seeded registry (illustrative)

| Category | Action | Reversible? | Blast radius |
|---|---|---|---|
| Cache | flush object/page cache | yes | none |
| Service | restart php-fpm / nginx / redis | yes | ≤10s blip |
| Logs | rotate or truncate runaway log | yes | none |
| Security | fail2ban unban | yes | none |
| Queue | restart stuck worker (pm2/supervisord) | yes | none |
| SSL | re-issue Let's Encrypt | yes | none |
| Process | kill runaway high-CPU pid | yes | low |
| Cleanup | delete confirmed orphan media | yes (trash) | none |
| Cleanup | clear transients · expired sessions | yes | none |

#### Learning loop (how Smart Fix evolves per webapp)

```
1. Smart Fix runs → outcome logged to BRAIN.actions
2. Nightly LLM job reads last-7-days actions:
     - Which actions consistently succeed on which hosts?
     - Are there recurring problems that always have the same human-fix?
3. New candidate proposed:
     "Pattern: when host=X has issue=Y, the manual fix is always Z.
      Promote to Smart Fix?"
4. Telegram card asks once: [Yes, auto-fix in future] [No, keep manual]
5. After human ack → registry grows. Future occurrences fire as auto Smart Fix.
6. Knowledge stored in BRAIN.knowledge for cross-host generalisation.
```

**Promotion gate**: a new pattern needs **one explicit human ack** before becoming a Smart Fix. After that, it auto-fixes — but every run is still logged + reversible.

### Channels (out)
- **Telegram** — primary. One bot, one chat (see "The Perch Bot" below).
- **Slack** — team mirror.
- **Email** — fallback for slow/escalated alerts.
- **Webhook (out)** — to user's own systems (n8n, Zapier, custom).

### Inbound webhooks (handled by Monitor)

External systems push events INTO Perch. **They land in Monitor**, not Notifier — they are external probes. Each event normalises into the same `Event` shape, then flows through the rest of the pipeline (compose → dispatch → buttons → Smart Fix).

| Source | Example events |
|---|---|
| **RunCloud** | server reboot · backup succeeded/failed · deploy triggered · SSL renewed |
| **Cloudflare** | WAF rule tripped · DDoS detected · origin error spike |
| **GitHub** | push to main · workflow failed · deploy triggered · security alert |
| **Custom** | any URL the user wires up — Stripe webhook, FluentCRM, etc. |

Endpoint shape:
```
POST /perch/webhooks/<source>
{ event, host, payload, signature }
```

The handler:
1. Verifies signature (per-source secret in `BRAIN.secrets`)
2. Logs to `BRAIN.incidents`
3. Triggers the same LLM compose → channel send → button flow

---

## Surface B — AI Conversational

### Lifecycle of a chat turn

```
1. USER SENDS MESSAGE  ─→  in same Telegram chat (or any Surface B channel)
2. SESSION OPENED      ─→  identified by chat_id; loads recent context from
                           BRAIN.conversations (per-host scoped)
3. LLM PLANS           ─→  reads STATIC brain first (cached snapshots, last state)
4. LLM JUDGES          ─→  "Do I have enough? Or do I need a live read?"
                           If live read needed → fires READ-ONLY module call:
                             - wp.audit_*
                             - runcloud.get_*
                             - ssh-read-only allowlist (tail, df, ps, …)
5. LLM ANSWERS          ─→  conversational reply, focused on servers only
6. IF USER ASKS WRITE  ─→  REFUSE + ROUTE:
                             "I can't write from chat. If this is urgent, the
                              next Smart Fix card will offer it, or run the
                              CLI: perch run <action>."
7. PERSIST              ─→  full turn (msg + reply + tool calls) → BRAIN.conversations
```

### Why strictly read-only

- **No conversational writes = no rogue agent.** Jailbreak attempts and misclicks can never destroy data through chat.
- Every mutation is surfaced through **Smart Fix cards** — scoped, explained, one-tap-reversible.
- Cost meter stays honest — chat is read-only and cheap.
- The line is so simple users learn it in one sentence.

### Channels

| Channel | Use case | Notes |
|---|---|---|
| **Telegram DM** | Same chat as alerts; sending text starts a session | Primary |
| **Slack DM / mention** | Team-shared read-only ops Q&A | Multi-user |
| **Claude Code MCP** | Aditya inside Claude Code asks Perch via MCP tools | Tool list = read-only modules + audit calls |
| **ChatGPT / Gemini plugin** | OpenAPI shape — works with any plugin-capable LLM | Same auth as HTTP API |
| **CLI** (`perch ...`) | Local terminal | Read-only commands; mutating commands stub: "use Smart Fix" |
| **HTTP API** | n8n, scripts, dashboards | Bearer auth · read-only endpoints only |

### BYOK — bring your own LLM key

Perch ships **without a default LLM**. Users supply their own provider key — keeping the "free forever, no extra services" promise.

```
PERCH_LLM_PROVIDER = gemini | openai | claude
PERCH_LLM_MODEL    = <provider model id>
PERCH_LLM_API_KEY  = <stored encrypted in BRAIN.secrets via vault.ts>
```

Reference deployment uses `gemini-2.5-flash-lite` (free tier).

Keys are loaded with `scripts/perch-vault-set.ts` which reads from stdin and writes to vault — never via shell history, never committed.

---

## The Perch Bot — personality & scope

### Scope: servers only

Perch's bot is **strictly a sysadmin assistant**. It is not a general-purpose chatbot.

```
USER: What's the weather today?
PERCH: I'm Perch — I only handle your servers and webapps.
       Anything I can help you with there?

USER: Tell me a joke
PERCH: I'd rather show you what's running on your servers.
       Want a quick health check on hetzner-1?

USER: Write me a Python function
PERCH: Outside my lane — I focus on your infra. If you want, I can
       check your deployed services or recent logs.
```

The system prompt enforces:
- **In scope**: server health, webapp performance, security, cleanup, ops, diagnostics, plugin behaviour, RunCloud/Cloudflare/GitHub state, log explanation, brain history.
- **Out of scope**: general knowledge, code generation, advice unrelated to the user's infra, opinions on tools the user doesn't run.

### Tone: soft, precise, helpful

- **Soft**: never alarmist, never robotic. "Disk's getting tight — 95% on hetzner-1. I have a clean fix in mind."
- **Precise**: numbers, paths, names. "5,200 orphan files in `/uploads/2024/`, 3.2 GB."
- **Helpful**: always offers a next step. Either a Smart Fix card or a follow-up read.
- **Short**: matches the user's terseness. Replies are 1–4 sentences unless asked for depth.

### Memory: every chat in Brain

Every turn is persisted to `BRAIN.conversations` (new room — see [`brain.md`](./brain.md)). The next session loads the last N relevant turns scoped to the same host.

This is what makes Perch feel like a sysadmin who already knows your servers — because the brain is durable, host-scoped, and read by the LLM at every turn.

```
BRAIN.conversations schema (sketch):
  id · host · channel · user · turn_idx · role · content ·
  tool_calls · tokens · created_at
```

---

## Folder layout

```
src/connectors/
├── monitor/                        ← Surface A · sub-layer 1 (eyes)
│   ├── index.ts                    (orchestrator: schedule → probe → grade → emit Event)
│   ├── scheduler.ts                (cron + jitter + per-probe interval)
│   ├── dedup.ts                    (suppress repeats while incident open/snoozed)
│   ├── severity.ts                 (probe result + rule → info|warn|critical)
│   ├── event.ts                    (Event type + emitter)
│   ├── rules/                      (rules-as-data loader; backed by BRAIN.guardrails)
│   │   ├── thresholds.ts
│   │   ├── anomalies.ts
│   │   └── host-overrides.ts
│   ├── probes/                     (one file per probe; grows heavily)
│   │   ├── uptime.ts
│   │   ├── ports.ts
│   │   ├── services.ts
│   │   ├── disk.ts
│   │   ├── ssl.ts
│   │   ├── logs.ts
│   │   └── wp-specific.ts
│   └── webhooks-in/                (inbound = external probes)
│       ├── runcloud.ts
│       ├── cloudflare.ts
│       ├── github.ts
│       └── custom.ts
│
├── notifier/                       ← Surface A · sub-layer 2 (voice + hands)
│   ├── index.ts                    (consumes Events from monitor)
│   ├── compose.ts                  (LLM: Event + brain → human-grade message)
│   ├── dispatcher.ts               (route to channels for the host)
│   ├── buttons.ts                  (handle Smart Fix / Snooze / Ignore callbacks)
│   ├── smart-fix/
│   │   ├── registry.ts             (catalog of safe-write actions, growable)
│   │   ├── runner.ts               (LLM picks → guardrails → execute → report)
│   │   ├── promote.ts              (nightly job: propose new candidates)
│   │   └── actions/
│   │       ├── service-restart.ts
│   │       ├── cache-purge.ts
│   │       ├── log-rotate.ts
│   │       ├── fail2ban-unban.ts
│   │       ├── orphan-media-delete.ts
│   │       ├── ssl-reissue.ts
│   │       └── ...
│   └── channels/
│       ├── telegram.ts             (renders card, handles button callbacks)
│       ├── slack.ts
│       ├── email.ts
│       └── webhook-out.ts
│
└── ai/                             ← Surface B (READ-ONLY)
    ├── index.ts                    (router: channel → BYOK LLM → read-only modules)
    ├── system-prompt.ts            (sysadmin-only scope · soft tone)
    ├── refuse-write.ts             (single source of truth for "I can't write")
    ├── llm/
    │   ├── gemini.ts
    │   ├── openai.ts
    │   └── claude.ts
    └── channels/
        ├── telegram.ts             (conversational mode, same chat as Surface A)
        ├── slack.ts
        ├── mcp.ts                  (Claude Code MCP server)
        ├── plugin-http.ts          (OpenAPI for ChatGPT/Gemini plugins)
        ├── cli.ts
        └── http-api.ts             (replaces src/api/server.ts, RO endpoints only)
```

---

## Why this is Perch's moat

1. **The connector thinks.** Every alert is a sysadmin reading the logs FOR you, not a raw error dump.
2. **One sharp line.** Conversation never writes; Smart Fix is the only write. Users learn safety in one sentence.
3. **Per-webapp memory.** Brain-backed conversation = the bot gets better at YOUR servers, not "servers in general."
4. **BYOK = free forever.** No hidden LLM costs, no vendor lock-in, no extra services.
5. **Plug-ins everywhere.** Same backend serves Telegram, Slack, Claude Code, ChatGPT, Gemini, CLI, HTTP. Add a channel = one file.
6. **Self-evolving.** Smart Fix registry grows with proven patterns from real incidents on real hosts.

---

## Open questions (final 3 before ship)

1. **Conversation refuses ALL writes** — even tiny ones like "flush cache"? My recommendation: yes, strict refuse, redirect to Smart Fix. The clean line is what makes this safe.

2. **Smart Fix promotion gate** — new patterns need **one human ack** before becoming auto-fixable. After that, they auto-run on detection. OK? Or always require human ack even after promotion?

3. **`BRAIN.conversations` retention** — keep all turns forever, or trim per host (e.g. last 90 days + summarise older into `BRAIN.knowledge`)?

Answer these and Connectors v2.4 ships.
