#!/usr/bin/env python3
"""
Perch — Telegram bot (v2.5)

Minimal-surface bot: receives alerts from monitor.sh and dispatches the
three buttons every Perch alert ships with:

    [🔧 Smart Fix]  [💤 Snooze 1h]  [✅ Ack]

That's the entire user-facing surface. No slash commands. No manual menus.
Conversational ops happen via Surface B (Claude Code MCP, ChatGPT, Gemini,
CLI, HTTP API) — see docs/architecture.md.

Callback schema (see docs/callback-schema.md):
    perch:ack                  -> acknowledge alert
    perch:mute_30m|1h|4h|24h   -> write mute file (monitor.sh respects it)
    perch:<action>             -> POST /<action> to fix-server (smart fix)

If a foreign bot (Niyati, ChatGPT, Gemini plugin) is polling the same token,
disable this systemd service — perch-fix-server still answers their dispatch.

https://github.com/adityaarsharma/perch
"""
import os, json, time, sys, requests
from pathlib import Path


# ── env -------------------------------------------------------------------------

def load_env():
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID   = str(os.environ.get("TELEGRAM_CHAT_ID", ""))
FIX_URL   = os.environ.get("FIX_SERVER_URL", "http://127.0.0.1:3014")
FIX_TOKEN = os.environ.get("FIX_SERVER_TOKEN", "")
TGAPI     = f"https://api.telegram.org/bot{BOT_TOKEN}"
MUTE_FILE = "/tmp/perch-monitor-muted"

MUTE_DURATIONS = {
    "mute_30m": 30 * 60,
    "mute_1h":  60 * 60,
    "mute_4h":  4 * 60 * 60,
    "mute_24h": 24 * 60 * 60,
}


# ── Telegram helpers ------------------------------------------------------------

def tg(method, **kw):
    return requests.post(f"{TGAPI}/{method}", json=kw, timeout=15).json()


def send(text, chat_id=None):
    return tg("sendMessage",
             chat_id=chat_id or CHAT_ID,
             text=text,
             parse_mode="Markdown")


def edit(mid, text, chat_id=None):
    return tg("editMessageText",
             chat_id=chat_id or CHAT_ID,
             message_id=mid,
             text=text,
             parse_mode="Markdown")


def answer_cb(cb_id, text="✓"):
    return tg("answerCallbackQuery", callback_query_id=cb_id, text=text)


# ── fix-server ------------------------------------------------------------------

def call_fix(action: str) -> tuple[bool, str]:
    """POST /<action> to fix-server. Returns (ok, output_text)."""
    try:
        r = requests.post(
            f"{FIX_URL}/{action}",
            headers={"Authorization": f"Bearer {FIX_TOKEN}"},
            timeout=60,
        )
        if r.status_code == 404:
            return False, f"No script registered for `/{action}`."
        try:
            data = r.json()
        except ValueError:
            return r.status_code == 200, r.text.strip() or "(no output)"
        out = (data.get("output") or data.get("error") or data.get("message") or str(data)).strip()
        return r.status_code == 200, out
    except Exception as e:
        return False, f"Connection error: {e}"


# ── state -----------------------------------------------------------------------

muted_until = 0.0


def is_muted() -> bool:
    return time.time() < muted_until


def write_mute_file(secs: int) -> str:
    """Write the mute expiry timestamp; return formatted local time string."""
    global muted_until
    muted_until = time.time() + secs
    try:
        with open(MUTE_FILE, "w") as f:
            f.write(str(int(muted_until)))
    except Exception as e:
        print(f"[bot] mute write error: {e}", flush=True)
    return time.strftime("%H:%M", time.localtime(muted_until))


# ── handlers --------------------------------------------------------------------

INTRO = (
    "*🪶 Perch is monitoring.*\n\n"
    "Alerts arrive here automatically. Each alert has three buttons:\n"
    "• 🔧 *Smart Fix* — runs a safe, scoped fix\n"
    "• 💤 *Snooze 1h* — silences alerts briefly\n"
    "• ✅ *Ack* — closes the alert\n\n"
    "For deep ops (audits, manual fixes, custom queries) use Perch from "
    "your AI tool of choice — Claude Code MCP, ChatGPT, Gemini, CLI, or HTTP API. "
    "Repo: https://github.com/adityaarsharma/perch"
)


def handle_message(msg):
    chat_id = str(msg["chat"]["id"])
    if chat_id != CHAT_ID:
        return

    text = (msg.get("text") or "").strip()
    if text in ("/start", "/help", "start", "help"):
        send(INTRO, chat_id=chat_id)
        return

    # Anything else: gentle nudge toward the AI surface
    send(
        "Perch's Telegram surface is alert-only. "
        "For chat-driven ops, use Claude Code, ChatGPT/Gemini plugin, or `perch` CLI.",
        chat_id=chat_id,
    )


def handle_callback(cb):
    data    = cb.get("data") or ""
    chat_id = str(cb["message"]["chat"]["id"])
    mid     = cb["message"]["message_id"]
    cb_id   = cb["id"]

    if chat_id != CHAT_ID:
        answer_cb(cb_id, "Unauthorized")
        return

    answer_cb(cb_id)

    # All Perch buttons are namespaced. Anything else is ignored politely.
    if not data.startswith("perch:"):
        edit(mid, f"_Unknown action_: `{data[:60]}`")
        return

    payload = data[len("perch:"):]

    # 1. Acknowledge — mark alert closed.
    if payload == "ack":
        edit(mid, "✅ *Acknowledged.*")
        # Clear any open Perch session marker so monitor.sh stops linking
        # follow-ups to this alert.
        try:
            os.remove("/tmp/perch_session.json")
        except FileNotFoundError:
            pass
        except Exception:
            pass
        return

    # 2. Snooze — write mute file with expiry.
    if payload in MUTE_DURATIONS:
        until = write_mute_file(MUTE_DURATIONS[payload])
        edit(mid, f"💤 *Snoozed.* Alerts paused until {until}.")
        return

    # 3. Smart Fix — POST /<action> to fix-server.
    edit(mid, f"⏳ *Smart Fix* running… (`{payload}`)")
    ok, out = call_fix(payload)
    icon = "✅" if ok else "❌"
    snippet = (out or "(no output)")[:3500]
    edit(mid, f"{icon} *Smart Fix* {'done' if ok else 'failed'} (`{payload}`)\n\n```\n{snippet}\n```")


# ── polling loop ----------------------------------------------------------------

def poll():
    offset = 0
    print(f"[bot] Started. Listening for updates (chat_id={CHAT_ID})...", flush=True)

    while True:
        try:
            r = requests.get(
                f"{TGAPI}/getUpdates",
                params={
                    "offset": offset,
                    "timeout": 30,
                    "allowed_updates": json.dumps(["message", "callback_query"]),
                },
                timeout=60,
            ).json()

            if not r.get("ok"):
                print(f"[bot] API error: {r}", flush=True)
                time.sleep(5)
                continue

            for update in r.get("result", []):
                offset = update["update_id"] + 1
                if "message" in update:
                    handle_message(update["message"])
                elif "callback_query" in update:
                    handle_callback(update["callback_query"])
        except Exception as e:
            print(f"[bot] loop error: {e}", flush=True)
            time.sleep(5)


# ── entrypoint ------------------------------------------------------------------

if __name__ == "__main__":
    if not BOT_TOKEN:
        print("ERROR: TELEGRAM_BOT_TOKEN not set in .env"); sys.exit(1)
    if not CHAT_ID:
        print("ERROR: TELEGRAM_CHAT_ID not set in .env"); sys.exit(1)
    if not FIX_TOKEN:
        print("WARNING: FIX_SERVER_TOKEN not set — Smart Fix taps will fail with 401.", flush=True)
    poll()
