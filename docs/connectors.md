# Perch — Connectors

**Layer 1** of the 5-layer stack. The top — where Perch talks to you.

Last revised: 2026-04-27 (Perch v2.5 design lock).
Sister docs: [`architecture.md`](./architecture.md) · [`monitor.md`](./monitor.md) · [`brain.md`](./brain.md) · [`guardrails.md`](./guardrails.md) · [`specialists.md`](./specialists.md)

---

## The big idea

> **LLM is the connector.** That's Perch's moat.

Every other server tool ships a dumb dashboard, a dumb bot, or a dumb webhook. Perch's connectors **think** — they read brain, they read live state, they compose explanations, they pick safe fixes — all in your channel of choice.

You don't talk to a bot. You talk to **the most informed sysadmin you've ever hired**, who happens to live in Telegram (for nudges) and Claude Code (for real work).

---

## Two surfaces — split by **what they can WRITE**

Both surfaces have **the same read powers**. They differ only on the write side:

| Surface | Channels | Read brain? | Read live (RO modules)? | Write |
|---|---|---|---|---|
| **A. Notifier** | Telegram · Slack · Email · Webhook (out) | ✅ Full | ✅ Server IP · visits · ports · disk · logs · WP audits · everything in the read-only allowlist | **Only via `Smart Fix`** (registry-bounded, LLM-judged) |
| **B. AI Plugin** | Claude Code MCP · ChatGPT plugin · Gemini plugin · CLI · HTTP API | ✅ Full | ✅ Same allowlist | **Full writes** — every Stack/Platform module, gated by Guardrails |

> **The line: both can READ everything. Only Surface B can do FULL writes. Surface A can only fix via Smart Fix cards.**

Both surfaces persist every chat turn to `BRAIN.conversations` (host-scoped) so Perch builds sysadmin-grade per-host memory.

### Why split this way

- **Notifier channels are reactive and lightweight.** You're on your phone. You want a nudge, an explanation (from brain + live data), and a one-tap fix.
- **AI Plugin channels are contextual and heavy.** You're at your desk in Claude Code/ChatGPT. You want to apply migrations, deploy fixes, run multi-step plans.
- **Big writes belong where you have screen real-estate, conversation history, and the right mental mode for them.** Smart Fix's narrow registry is what's safe to expose on a phone.

---

## Where Connectors sits in the 5-layer stack

```
       (1) CONNECTORS            ← this doc · top of stack · talks to user
            │                      Surface A: Notifier (Telegram · Slack · Email · Webhook)
            │                      Surface B: AI Plugin (Claude Code MCP · ChatGPT · Gemini · CLI · HTTP)
            ↓
       (2) REASONING             ← Orchestrator + specialists + guardrails enforcer
            ↓
       (3) MONITOR               ← own layer · Watch tier (probes/webhooks-in) + Decide tier
            ↑                      uses Executor read-only modules to see · emits Events back up
            ↓                      see monitor.md
       (4) EXECUTOR (apps)       ← Stack + Platform modules (the actual server work)
            ↓
       (5) BRAIN                 ← per-host SQLite, logical rooms (conversations, incidents, …)
```

Monitor sits at layer 3 because it **uses** Executor's read-only modules to see the world and **emits** Events upstream to Connectors (Surface A → Notifier). It's an observer-tier between the brains (Reasoning) and the hands (Executor).

---

## Surface A — Notifier (Telegram-style channels)

### Channels
- **Telegram** — primary; one bot, one chat per user
- **Slack** — team mirror
- **Email** — fallback for slow/escalated alerts
- **Webhook (out)** — to user's own systems (n8n, Zapier, custom)

> "Telegram" in this doc is shorthand for *any notifier-style channel*. Same rules apply to Slack and Email.

### Two flows in Surface A

#### Flow 1 — Alert (Monitor → user)
```
Monitor emits Event   ─→  Notifier
Notifier composes      ─→  BYOK LLM reads:
                            • BRAIN (incidents, knowledge, webapps, conversations, timeseries)
                            • Live read-only modules (df, ps, server IP, visit logs, …)
                          drafts hyper-personal message:
                            "what's wrong · why · what Smart Fix would do · context"
Send to channel        ─→  card with [Smart Fix]  [Snooze 1h]  [Ignore]
User taps:
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
Everything logged      ─→  BRAIN.incidents · BRAIN.actions · BRAIN.audit_log
```

#### Flow 2 — Conversation (user → bot)
```
User sends free-text in same chat:
  "what happened to my disk yesterday?"
  "show me top visits today"
  "who logged in via SSH last hour?"

Notifier opens session ─→  loads recent context from BRAIN.conversations (host-scoped)
BYOK LLM plans         ─→  reads BRAIN + judges if live data needed
                          fires READ-ONLY module calls as needed:
                            • runcloud.get_logs · ssh.df · ssh.ps · wp.audit_*
                            • server IP / visit logs / port status / service health
LLM answers            ─→  conversational reply with brain + live context

If user asks for write:
  "delete that log"     →  REFUSE + ROUTE:
                            "I can't run big writes from here. The next Smart
                             Fix card can rotate logs. For deeper work, open
                             Perch in Claude Code (or ChatGPT/Gemini/CLI)."
  "flush cache"         →  same (even small writes go through Smart Fix card)

Persist                 ─→  every turn → BRAIN.conversations
```

### Why writes are restricted to Smart Fix on Surface A

- **No path to a big write through Telegram → no rogue agent risk on mobile.**
- Smart Fix is **LLM-judged but registry-bounded** — only safe, reversible, sub-10s actions qualify.
- Every Smart Fix run is logged and undoable.
- For real ops work, the user has Claude Code / ChatGPT / Gemini one tap away.

### Smart Fix — the only write path in Surface A (its own component)

Smart Fix is a **first-class component inside Surface A**, not just a button label. It is the **group-breaking automation** Perch ships — every alert across every probe lands on the same three-button shape, and the first button always says **🔧 Smart Fix**. Behind that one button is a single algorithm.

**One button → one callback shape → one registry → one router.**

```
Alert (any rule)
   │   [🔧 Smart Fix]
   │     callback_data: perch:smart-fix:<alert_id>
   ▼
POST /smart-fix  body { alert_id }
   │
   ▼
SMART_FIX_REGISTRY (alert → safe-action)
   ├── nginx_down      → fix-nginx
   ├── php_fpm_down    → fix-php-fpm
   ├── mysql_down      → fix-mysql
   ├── disk_*          → clear-logs
   ├── ram_* / cpu_*   → smart-fix.sh (multi-check + zombie reap)
   ├── ssl_*           → renew-ssl
   ├── orphans         → smart-fix.sh (narrow zombie reap)
   ├── site_down       → fix-nginx
   ├── site_5xx        → smart-fix.sh
   ├── fail2ban_spike  → None  (no safe auto-fix, friendly refusal)
   ├── backup_age      → None
   └── ⟨unknown⟩       → smart-fix.sh fallback
```

Smart Fix is:

- A **registry of safe-write actions** seeded with hand-curated fixes (above)
- A **router** that maps alert_id → action — explicit, deterministic, auditable
- A **learning loop** ([`src/scripts/smart-fix-learn.ts`](#)) that promotes proven manual patterns from `BRAIN.actions_log` into the registry nightly, with one-time human ack
- An **explicit refusal path** for alerts with no safe auto-fix — never guesses

Why it's its own component:

- **No leaked internal names** — users don't see `fix-nginx`, `clear-logs`, `renew-ssl` etc. in any callback or button. Just `Smart Fix`. Internal scripts can be renamed or rewritten without breaking a single Telegram message ever sent.
- **Adding a new alert** = one new line in `SMART_FIX_REGISTRY`. No new buttons, no new endpoints, no new dispatcher logic in bot.py / Niyati. The registry IS the contract.
- **The registry is the safety boundary** — Smart Fix never runs an action outside it, even if a user crafts a callback by hand or a brand-new probe emits a never-seen alert_id (catch-all = narrow `smart-fix.sh`).

#### Hard rule
**An action qualifies as Smart Fix only if it is reversible AND cannot break the site for >10s AND does not mutate user-generated content destructively.**

If it fails the test → the alert card shows `[Investigate in Claude Code]` (or another Surface B channel of the user's choice) instead.

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
2. Nightly LLM job reads last-7d actions:
     "Pattern: when host=X has issue=Y, manual fix is always Z.
      Promote to Smart Fix?"
3. Notifier asks once: [Yes, auto-fix in future] [No, keep manual]
4. After human ack → registry grows. Future occurrences fire as auto Smart Fix.
5. Knowledge stored in BRAIN.knowledge for cross-host generalisation.
```

---

## Surface B — AI Plugin (Claude Code · ChatGPT · Gemini · CLI · HTTP)

This is where the real conversational ops work happens. Same read powers as Surface A; full write powers on top.

### Channels (Surface B)

| Channel | Use case | LLM | Notes |
|---|---|---|---|
| **Claude Code MCP** | Inside Claude Code; Perch is an MCP tool provider | Claude (user's existing subscription) | Tool list = full Stack + Platform modules |
| **ChatGPT plugin** | Custom GPT or plugin against Perch's OpenAPI | OpenAI (user's account) | Same OpenAPI as Gemini |
| **Gemini plugin** | Gemini extension against same OpenAPI | Google (user's account) | — |
| **CLI** (`perch ...`) | Local terminal | Optional (raw module calls allowed) | Power-user shell |
| **HTTP API** | n8n, scripts, dashboards, custom integrations | Optional | Bearer auth · all endpoints |

### Lifecycle of an AI Plugin turn

```
1. USER QUERY            ─→  via MCP/plugin/CLI/HTTP
2. SESSION CONTEXT       ─→  loads BRAIN.conversations (host-scoped) +
                              static brain (incidents, knowledge, webapps)
3. REASONING LAYER PLANS  ─→  Orchestrator → specialist → tool plan
4. LIVE READS             ─→  any Stack/Platform read module (wp.audit_*,
                              runcloud.get_*, ssh-read commands, …)
5. WRITES (if needed)     ─→  Guardrails enforcer checks every mutating call:
                                allow / deny / require_human_confirmation
                              On `require_human_confirmation` → ack flow
                              (in-channel: "type CONFIRM" / MCP tool ack)
6. EXECUTOR RUNS          ─→  Stack via SSH, Platform via REST
7. RESULT → USER          ─→  conversational reply with what was done + diff
8. PERSIST                ─→  full turn (msg + reply + tool calls) → BRAIN.conversations
```

### What Surface B can do that Surface A cannot
- Apply mutations (anything in the module catalog), gated by Guardrails
- Multi-step plans (audit → propose → apply → verify in one session)
- Long-form output (logs, configs, diffs)
- Cross-host queries
- Smart Fix-style fixes plus everything bigger (migrations, search-replace, plugin install/update, core update, etc.)

### What Surface B is bound by
- **Guardrails** — every mutation passes `BRAIN.guardrails` rules. Prod hosts default to `require_human_confirmation`.
- **Cost meter** — token use logged per session; hard caps configurable.
- **Audit log** — every action lands in `BRAIN.audit_log`.

### BYOK — bring your own LLM key

Each Surface B channel uses its native LLM. Surface A's compose step (alerts + chat replies) uses the same `PERCH_LLM_*` config:

```
PERCH_LLM_PROVIDER = gemini | openai | claude
PERCH_LLM_MODEL    = <provider model id>
PERCH_LLM_API_KEY  = <stored encrypted in BRAIN.secrets via vault.ts>
```

Reference deployment: `gemini-2.5-flash-lite` (free tier).

---

## The Perch Bot — personality & scope (both surfaces)

### Scope: servers only

```
USER: What's the weather today?
PERCH: I'm Perch — I only handle your servers and webapps.
       Anything I can help you with there?

USER: Tell me a joke
PERCH: I'd rather show you what's running on your servers.
       Want a quick health check on hetzner-1?

USER: Write me a Python function
PERCH: Outside my lane — I focus on your infra.
```

System prompt enforces:
- **In scope**: server health, webapp performance, security, cleanup, ops, diagnostics, plugin behaviour, RunCloud/Cloudflare/GitHub state, log explanation, brain history.
- **Out of scope**: general knowledge, code generation, advice unrelated to user's infra.

### Tone: soft, precise, helpful
- **Soft**: never alarmist. "Disk's getting tight — 95% on hetzner-1. I have a clean fix in mind."
- **Precise**: numbers, paths, names. "5,200 orphan files in `/uploads/2024/`, 3.2 GB."
- **Helpful**: always offers a next step.
- **Short**: 1–4 sentences unless asked for depth.

### Memory: every chat in Brain
Both surfaces persist every turn to `BRAIN.conversations` (host-scoped). Next session loads recent turns. This is what makes Perch feel like a sysadmin who already knows your servers.

```
BRAIN.conversations schema (sketch):
  id · host · channel · user · turn_idx · role · content ·
  tool_calls · tokens · created_at
```

---

## Folder layout

```
src/
├── connectors/                     ← LAYER 1 (this doc)
│   ├── notifier/                   ← Surface A · Telegram-style channels
│   │   ├── index.ts                (consumes Events from monitor; routes free-text)
│   │   ├── compose.ts              (LLM: Event + brain + live reads → message)
│   │   ├── chat.ts                 (free-text reply: brain + live reads, RO only)
│   │   ├── refuse-write.ts         (single source of truth for "use Claude Code / Smart Fix")
│   │   ├── dispatcher.ts           (route to channels for the host)
│   │   ├── buttons.ts              (handle Smart Fix / Snooze / Ignore callbacks)
│   │   ├── smart-fix/
│   │   │   ├── registry.ts         (catalog of safe-write actions, growable)
│   │   │   ├── runner.ts           (LLM picks → guardrails → execute → report)
│   │   │   ├── promote.ts          (nightly job: propose new candidates)
│   │   │   └── actions/
│   │   │       ├── service-restart.ts
│   │   │       ├── cache-purge.ts
│   │   │       ├── log-rotate.ts
│   │   │       ├── fail2ban-unban.ts
│   │   │       ├── orphan-media-delete.ts
│   │   │       ├── ssl-reissue.ts
│   │   │       └── ...
│   │   └── channels/
│   │       ├── telegram.ts
│   │       ├── slack.ts
│   │       ├── email.ts
│   │       └── webhook-out.ts
│   │
│   └── ai-plugin/                  ← Surface B · Claude Code / ChatGPT / Gemini / CLI / HTTP
│       ├── index.ts                (router: channel → reasoning → executor)
│       ├── system-prompt.ts        (sysadmin-only scope · soft tone)
│       ├── llm/
│       │   ├── gemini.ts
│       │   ├── openai.ts
│       │   └── claude.ts
│       └── channels/
│           ├── mcp.ts              (Claude Code MCP server; full tool catalog)
│           ├── plugin-http.ts      (OpenAPI for ChatGPT/Gemini plugins)
│           ├── cli.ts              (local terminal, full module access)
│           └── http-api.ts         (replaces src/api/server.ts; full endpoints)
│
├── reasoning/                      ← LAYER 2 (orchestrator + specialists)
├── monitor/                        ← LAYER 3 (see monitor.md)
└── modules/                        ← LAYER 4 (Executor: stack/ + platform/)
                                      LAYER 5 is BRAIN at ~/.perch/brain.db
```

Telegram and Slack do **not** appear in `ai-plugin/channels/` — they are exclusively Surface A channels. Big writes never come from there.

---

## Why this is Perch's moat

1. **The connectors think.** Every alert is a sysadmin reading the logs FOR you, not a raw error dump.
2. **Same reads, different writes.** Both surfaces see everything. Only the desk channels do big writes. One sentence of safety the user actually understands.
3. **Per-webapp memory.** `BRAIN.conversations` = the bot gets better at YOUR servers.
4. **BYOK = free forever.** No hidden LLM costs, no vendor lock-in.
5. **Plug-ins everywhere.** Same backend serves Telegram, Slack, Claude Code, ChatGPT, Gemini, CLI, HTTP. Add a channel = one file.
6. **Self-evolving.** Smart Fix registry grows with proven patterns from real incidents.
7. **Monitor is its own beast.** A whole layer of its own ([monitor.md](./monitor.md)) that evolves fearlessly.

---

## Open questions (final 3 before v2.5 implementation)

1. **Surface A free-text reads** — confirm: brain + live read-only modules (server IP, visits, ports, df, ps, etc.) are all OK from Telegram, just no writes? (Recommendation: yes.)
2. **Smart Fix promotion gate** — new patterns need **one human ack** before becoming auto-fixable. After that, they auto-run on detection. OK? (Recommendation: yes, one-ack-then-auto.)
3. **`BRAIN.conversations` retention** — keep all turns forever, or trim per host (e.g. last 90 days + summarise older into `BRAIN.knowledge`)? (Recommendation: trim+summarise at 90d.)
