# Perch — Architecture (block model)

> Pick a block. Ship that block end-to-end. Move to next.

Perch is built as **10 loosely-coupled blocks**. Each block has a single
responsibility, talks to other blocks through documented interfaces, and ships
in isolation. Read this file once. Then open `blocks/<NN>-<name>.md` for the
block you want to work on — it tells you exactly what's done, what's missing,
and the smallest next ship task.

---

## Block map

```
                      ┌───────────────────────────────────┐
                      │   10. Distribution                │
                      │   (landing, docs, skill, repo)    │
                      └───────────────────────────────────┘
                                       │
                                       ▼
┌───────────────────────────────────────────────────────────────────────┐
│                    9. Lifecycle Module                                │
│   setup.sh · install.sh · update.sh · uninstall.sh · self-update      │
└───────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                ┌──────────────────────┴──────────────────────┐
                │                                             │
                ▼                                             ▼
┌─────────────────────────────┐              ┌─────────────────────────────┐
│   1. Core/Brain             │              │   2. Vault                  │
│   SQLite — servers,         │              │   AES-256-GCM, scrypt KDF   │
│   webapps, problems,        │              │   credential storage        │
│   actions, knowledge        │              │                             │
└─────────────────────────────┘              └─────────────────────────────┘
                │                                             │
                └──────────────────┬──────────────────────────┘
                                   ▼
┌───────────────────────────────────────────────────────────────────────┐
│                    3. HTTP API + MCP (canonical surface)              │
│   src/api/server.ts (3013) · src/index.ts (MCP/Claude Code)           │
│   20+ tools exposed: brain, ssh.exec, wp.*, access_*, server_pulse... │
└───────────────────────────────────────────────────────────────────────┘
              ▲              ▲              ▲              ▲
              │              │              │              │
              │              │              │              │
┌─────────────┴───┐   ┌──────┴────────┐   ┌─┴────────────┐ ┌┴──────────────┐
│  4. Monitor    │   │ 5. Notifier   │   │ 6. LLM       │ │ 7. RunCloud   │
│  Module        │   │ (Telegram +   │   │ Module       │ │ Module        │
│  (cron, 14     │   │  Slack)       │   │ (BYOK Gemini)│ │               │
│  rules)        │   │  bot.py +     │   │ intent route │ │ multi-server  │
│  monitor.sh    │   │  monitor.sh   │   │ + reply fmt  │ │ orchestration │
└────────────────┘   │  alerts       │   └──────────────┘ └───────────────┘
                     └───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │   8. WordPress Module         │
              │   wp.db_audit · wp.plugins    │
              │   wp.security · wp.perf...    │
              │   (lives under HTTP API)      │
              └───────────────────────────────┘
```

---

## Block index — quick status

| # | Block | State | Doc |
|---|---|---|---|
| 1 | Core/Brain | ✅ live, knowledge-loop dormant | [01-core-brain.md](./blocks/01-core-brain.md) |
| 2 | Vault | ✅ live, hardened | [02-vault.md](./blocks/02-vault.md) |
| 3 | HTTP API + MCP | ✅ live, 20+ tools | [03-http-api-mcp.md](./blocks/03-http-api-mcp.md) |
| 4 | Monitor Module | ✅ live, 14 rules, multi-server pending | [04-monitor.md](./blocks/04-monitor.md) |
| 5 | Notifier (Telegram + Slack) | ✅ Telegram live, Slack mirror live, Slack buttons pending | [05-notifier.md](./blocks/05-notifier.md) |
| 6 | LLM Module | ⚠️ Niyati has it inline; not yet a shared `llm.py`/`llm.ts` | [06-llm.md](./blocks/06-llm.md) |
| 7 | RunCloud Module | ⚠️ structure-aware scripts only; no API tools yet | [07-runcloud.md](./blocks/07-runcloud.md) |
| 8 | WordPress Module | ✅ 7 sub-modules, all under HTTP API | [08-wordpress.md](./blocks/08-wordpress.md) |
| 9 | Lifecycle | ✅ install/update/uninstall scripts present | [09-lifecycle.md](./blocks/09-lifecycle.md) |
| 10 | Distribution | ✅ landing + skill + repo public | [10-distribution.md](./blocks/10-distribution.md) |

Legend:
- ✅ live and verified
- ⚠️ partial — see the block doc for what's missing
- ❌ not started

---

## How to use this when you sit down to build

1. Open `architecture.md` (this file). Pick a block.
2. Open `blocks/<NN>-<name>.md`.
3. Read the **Next ship task** section — it's intentionally small.
4. Ship that one task end-to-end:
   - Code change
   - Test (manual or scripted)
   - Push to GitHub
   - Brain note (`inputs/niyati/insights/`)
   - Telegram changelog
5. Update the block doc — strike through the shipped task, lift the next one up.

Don't touch other blocks while you're inside one. That's the discipline.

---

## Boundaries (hard rules)

- **Brain (block 1) and Vault (block 2) are the only persistent state.**
  Other blocks read/write through their APIs, not their files.
- **HTTP API + MCP (block 3) is the only external action surface.**
  Notifier, Monitor, Claude Plugin all call this — they don't shell out.
- **LLM (block 6) is optional everywhere.** No block hard-requires Gemini.
  Without a key: command-driven. With a key: conversational.
- **Notifier (block 5) writes to /tmp/perch-monitor-muted; Monitor (block 4)
  reads it.** That's the only inter-block file convention.
- **DESTRUCTIVE_RE guard runs at the entry of every conversational surface.**
  No path bypasses it.

---

## Versioning

This doc is the source of truth. If reality and this doc disagree, fix the
code OR fix the doc — whichever is wrong. The block docs decay fast; treat
them like a TODO list, not history.
