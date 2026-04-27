# Perch — Telegram Callback Schema

The contract any Telegram bot needs to know to route Perch alert buttons.

Last revised: 2026-04-27 (Perch v2.5).

---

## Why this exists

Perch's `monitor.sh` cron sends Telegram alerts with inline-keyboard buttons. When the user taps a button, Telegram fires a `callback_query` to whichever bot is polling `getUpdates`.

That bot may be:
- **Perch's own `bot.py`** (standalone deploys)
- **A foreign bot** — Niyati, an AI plugin, or any third party that owns the Telegram token

This doc defines the callback schema so any bot can recognize and route Perch buttons without colliding with its own callbacks.

---

## The rule

> **Every Perch callback is prefixed with `perch:`.**

Foreign bots match on prefix:
```python
if callback_data.startswith("perch:"):
    forward_to_perch_handler(callback_data)
```

Standalone Perch (`bot.py`) strips the prefix internally and routes through its existing handler — so the same code path works for both modes.

---

## Schema

### Acknowledgment
| Callback | Meaning |
|---|---|
| `perch:ack` | Acknowledge alert · close any open Perch session · suppress dedup briefly |

### Mutes
| Callback | Action |
|---|---|
| `perch:mute_30m` | Mute alerts for 30 minutes (writes `/tmp/perch-monitor-muted`) |
| `perch:mute_1h` | …1 hour |
| `perch:mute_4h` | …4 hours |
| `perch:mute_24h` | …24 hours |

### Smart Fix actions
All map to a `fix-server.py` POST endpoint (see `telegram-bot/fix-server.py`). HTTP target = `http://127.0.0.1:<FIX_SERVER_PORT>/<endpoint>` with `Authorization: Bearer <FIX_SERVER_TOKEN>`.

| Callback | fix-server endpoint | Script |
|---|---|---|
| `perch:fix` | `/fix` | `smart-fix.sh` |
| `perch:fix-nginx` | `/fix-nginx` | `fix-nginx.sh` |
| `perch:fix-php-fpm` | `/fix-php-fpm` | `fix-php-fpm.sh` |
| `perch:fix-mysql` | `/fix-mysql` | `fix-mysql.sh` |
| `perch:fix-services` | `/fix-services` | `fix-services.sh` |
| `perch:fix-n8n` | `/fix-n8n` | `fix-n8n.sh` (optional) |

### Status & diagnostics
| Callback | fix-server endpoint | Script |
|---|---|---|
| `perch:status` | `/status` | `check-status.sh` |
| `perch:status-brief` | `/status-brief` | `status-brief.sh` |
| `perch:disk` | `/disk` | `check-disk.sh` |
| `perch:check-ports` | `/check-ports` | `check-ports.sh` |
| `perch:top-procs` | `/top-procs` | `top-procs.sh` |

### Logs
| Callback | fix-server endpoint | Script |
|---|---|---|
| `perch:logs-nginx` | `/logs-nginx` | `logs-nginx.sh` |
| `perch:logs-php` | `/logs-php` | `logs-php.sh` |

### SSL
| Callback | fix-server endpoint | Script |
|---|---|---|
| `perch:ssl-status` | `/ssl-status` | `ssl-status.sh` |
| `perch:renew-ssl` | `/renew-ssl` | `renew-ssl.sh` |

### Maintenance
| Callback | fix-server endpoint | Script |
|---|---|---|
| `perch:clear-logs` | `/clear-logs` | `clear-logs.sh` |

---

## Routing rule for foreign bots

```python
def route_perch_callback(callback_data, fix_server_url, fix_server_token):
    """
    Generic dispatcher. Strip prefix, pick handler.
    """
    if not callback_data.startswith("perch:"):
        return None  # not for us

    action = callback_data[len("perch:"):]   # e.g. "fix-nginx", "ack", "mute_1h"

    # Local-only actions (no HTTP call)
    if action == "ack":
        return ("local", "ack")

    if action.startswith("mute_"):
        return ("local", "mute", action[len("mute_"):])  # "30m", "1h", etc.

    # Everything else → POST to fix-server
    import requests
    r = requests.post(
        f"{fix_server_url}/{action}",
        headers={"Authorization": f"Bearer {fix_server_token}"},
        timeout=30,
    )
    return ("remote", r.status_code, r.text)
```

---

## Adding a new callback

1. Add a script under `scripts/` (executable).
2. Register the route in `telegram-bot/fix-server.py` `ROUTES` dict.
3. Add an entry to the table above.
4. Reference it in `monitor.sh` `BTN_*` definitions, prefixed with `perch:`.
5. Standalone `bot.py` doesn't need changes — its prefix-strip handles it.
6. Foreign bots (Niyati etc.) don't need changes — their prefix dispatcher handles it.

The schema is the contract. Stay backward-compatible: never change an existing `perch:<action>` value, only add new ones.
