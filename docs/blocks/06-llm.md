# Block 6 — LLM Module (BYOK Gemini)

## Purpose

The shared "make it conversational" layer. Two functions, used by both
Notifier (block 5) and the Claude Plugin path (block 3 MCP):

1. `route_intent(text, tool_catalog) → {tool, args} | None` — pick a Perch
   tool that fits the natural-language question
2. `format_reply(user_q, tool_output, persona?) → str | None` — turn raw
   tool output into a conversational chat reply

**Everything is OPTIONAL.** Without `GEMINI_API_KEY` in `.env`:
- Notifier → command/button mode only (still works)
- MCP → Claude does its own reasoning (still works)

With key: full conversational mode unlocked.

Recommended LLM: Gemini Flash (free tier, low latency).

## Files (target — not yet split out)

- `telegram-bot/llm.py` — Python implementation for `bot.py`
- `src/core/llm.ts` — TypeScript implementation for HTTP API + MCP
- Both read `GEMINI_API_KEY` from `~/.perch/.env`

## Current state

- ⚠️ Niyati (Aditya's private bot) has the full Gemini routing + reply
  formatting **inline in niyati.py** (`_perch_tool_route`, `_call_gemini`,
  `_telegram_md_safe`, etc.)
- ❌ Not yet extracted into a standalone module
- ❌ `bot.py` (public Telegram) doesn't use any LLM
- ❌ MCP doesn't use LLM for confirm/preview generation

## Gaps (toward vision)

- [ ] Extract Niyati's Gemini logic into `telegram-bot/llm.py`
  (~150 lines, pure functions)
- [ ] Wire `bot.py` to call `llm.route_intent` before the fall-through
- [ ] Add Markdown-safety helper to public version (`**X**` → `*X*` for
  Telegram-legacy parse mode)
- [ ] Webapp-list cache (5-min) so `route_intent` can resolve fuzzy domain
  names like "thebigskyfarm" → "thebigskyfarm.com"
- [ ] Setup wizard (block 9) prompts for `GEMINI_API_KEY` with link to
  Google AI Studio
- [ ] Per-deployment LLM choice — eventually allow Claude / OpenAI / local

## Next ship task

**Extract `telegram-bot/llm.py` from `niyati.py` and wire `bot.py`.**
- Copy `_perch_tool_route`, `_call_gemini`, `_telegram_md_safe`,
  `PERCH_TOOL_CATALOG`, `_list_known_webapps` into `llm.py`
- Add `if os.environ.get("GEMINI_API_KEY"):` gate at module load
- In `bot.py`'s `handle_message`, after `if cmd in COMMANDS:` falls through,
  try `llm.route_intent(text)` → if a tool is picked, call `fix(endpoint)`
  and `llm.format_reply(text, output)`
- Update `setup.sh` to ask for the key (optional)
~3h. Single biggest leverage move for public users.

## Boundaries

- LLM module never reads from Brain (block 1) directly — it gets context
  passed in by the caller.
- LLM module never writes — it returns a tool name + args; the caller
  decides whether to actually invoke the tool.
- 4-second timeout on every Gemini call. Fall back to "command not
  recognized — try /help" rather than hanging.
- DESTRUCTIVE_RE check runs in the caller, BEFORE LLM is invoked. The LLM
  never sees destructive prompts.
