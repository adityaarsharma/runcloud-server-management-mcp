# Block 1 — Core/Brain

## Purpose

Single source of operational state for Perch. SQLite-backed. Tracks:
- Servers (host, IP, hostname, RunCloud account)
- Webapps (per server: name, domain, path, framework)
- Problems (detected by monitor or diagnostic tools)
- Actions (mutations performed by Perch — for audit + undo)
- Knowledge increments (per-tool counters used for learning)

## Files

- `src/core/brain.ts` — schema + accessors
- `~/.perch/brain.db` — SQLite at runtime
- HTTP API tools: `brain`, `brain.history`, `brain_search`, `log_action`,
  `perch_actions_log`, `perch_undo`, `perch_multi_server_dashboard`

## Current state

- ✅ Schema migrated, accessors implemented
- ✅ `brain` snapshot returns counts + servers + webapps + top problems
- ✅ `log_action` writes audit rows from fix-server.py too
- ✅ `perch_undo` reverses tracked actions where reversible
- ⚠️ `incrementKnowledge()` exists but is **not called** by diagnostic tools —
  per HANDOFF, "knowledge loop dormant"

## Gaps (toward vision)

- [ ] Wire `incrementKnowledge` into every diagnostic call (A.7 task)
- [ ] Add `tags` column to servers (client/env/purpose) — vision V2
- [ ] Cross-server pattern recognition (D in HANDOFF) — needs query layer
- [ ] Brain export/import for migration

## Next ship task

**Wire `incrementKnowledge` into all 6 new server-intelligence tools** so each
read counts toward the per-domain learning curve. ~2h. Files: `src/api/server.ts`
in the runScript callback, and `src/core/brain.ts` for the increment function.

## Boundaries

- Brain (block 1) is **operational** memory — server state, action log.
  MemPalace (Aditya's separate brain.adityaarsharma.com) is **semantic** memory.
  Never mix.
- All writes go through `src/core/brain.ts`. Don't open the SQLite file
  from elsewhere.
