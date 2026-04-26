#!/usr/bin/env python3
"""
Perch — Telegram connector for server intelligence
Standalone bot — no n8n, no Zapier, no SaaS. Works on any Linux server.
https://github.com/adityaarsharma/perch
"""
import os, json, time, requests, sys
from pathlib import Path

# --- Load .env from same directory as this script ---
def load_env():
    env_path = Path(__file__).parent / '.env'
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env()

BOT_TOKEN  = os.environ.get('TELEGRAM_BOT_TOKEN', '')
CHAT_ID    = str(os.environ.get('TELEGRAM_CHAT_ID', ''))
FIX_URL    = os.environ.get('FIX_SERVER_URL', 'http://127.0.0.1:3011')
FIX_TOKEN  = os.environ.get('FIX_SERVER_TOKEN', '')
TGAPI      = f'https://api.telegram.org/bot{BOT_TOKEN}'

# --- Mute state ---
muted_until    = 0.0
pending_reboot = {}   # chat_id -> timestamp

# ── Telegram helpers ─────────────────────────────────────────────────────────

def tg(method, **kw):
    try:
        r = requests.post(f'{TGAPI}/{method}', json=kw, timeout=10)
        return r.json()
    except Exception as e:
        print(f'[TG] {method} error: {e}')
        return {}

def send(text, chat_id=None, markup=None):
    p = {'chat_id': chat_id or CHAT_ID, 'text': text, 'parse_mode': 'Markdown'}
    if markup:
        p['reply_markup'] = markup
    return tg('sendMessage', **p)

def edit(mid, text, chat_id=None, markup=None):
    p = {'chat_id': chat_id or CHAT_ID, 'message_id': mid,
         'text': text, 'parse_mode': 'Markdown'}
    if markup:
        p['reply_markup'] = markup
    return tg('editMessageText', **p)

def answer_cb(cb_id, text='✓'):
    tg('answerCallbackQuery', callback_query_id=cb_id, text=text)

# ── Fix server call ───────────────────────────────────────────────────────────

def fix(endpoint):
    try:
        r = requests.post(
            f'{FIX_URL}/{endpoint.lstrip("/")}',
            headers={'Authorization': f'Bearer {FIX_TOKEN}'},
            timeout=65
        )
        return r.json().get('output', '(no output)')
    except Exception as e:
        return f'❌ Fix server unreachable ({FIX_URL})\n{e}'

# ── Keyboards ─────────────────────────────────────────────────────────────────

def main_kb():
    return {'inline_keyboard': [
        [{'text': '📊 Status',     'callback_data': 'status'},
         {'text': '⚡ Brief',      'callback_data': 'status-brief'},
         {'text': '🧠 Top Procs',  'callback_data': 'top-procs'}],
        [{'text': '🔧 Smart Fix',  'callback_data': 'fix'},
         {'text': '🌐 Nginx',      'callback_data': 'fix-nginx'},
         {'text': '🐘 PHP-FPM',    'callback_data': 'fix-php-fpm'}],
        [{'text': '🗄  MySQL',     'callback_data': 'fix-mysql'},
         {'text': '⚙️ Services',   'callback_data': 'fix-services'},
         {'text': '🔌 Ports',      'callback_data': 'check-ports'}],
        [{'text': '💾 Disk',       'callback_data': 'disk'},
         {'text': '🧹 Clear Logs', 'callback_data': 'clear-logs'}],
        [{'text': '📋 nginx logs', 'callback_data': 'logs-nginx'},
         {'text': '📋 PHP logs',   'callback_data': 'logs-php'}],
        [{'text': '🔐 SSL Status', 'callback_data': 'ssl-status'},
         {'text': '🔄 Renew SSL',  'callback_data': 'renew-ssl'}],
    ]}

# ── Command definitions ───────────────────────────────────────────────────────

COMMANDS = {
    # Status
    '/status':    ('status',        '📊 Full status'),
    '/brief':     ('status-brief',  '⚡ Quick status'),
    '/top':       ('top-procs',     '🧠 Top processes'),
    '/disk':      ('disk',          '💾 Disk usage'),
    '/ports':     ('check-ports',   '🔌 Check service ports'),
    # Fixes
    '/fix':       ('fix',           '🔧 Smart fix all issues'),
    '/nginx':     ('fix-nginx',     '🌐 Restart nginx'),
    '/phpfpm':    ('fix-php-fpm',   '🐘 Restart PHP-FPM'),
    '/mysql':     ('fix-mysql',     '🗄 Restart MySQL'),
    '/services':  ('fix-services',  '⚙️  Restart services'),
    '/n8n':       ('fix-n8n',       '🤖 Restart n8n (if installed)'),
    # Logs
    '/lognginx':  ('logs-nginx',    '📋 nginx error log'),
    '/logphp':    ('logs-php',      '📋 PHP error log'),
    '/clearlogs': ('clear-logs',    '🧹 Clear large logs'),
    # SSL
    '/ssl':       ('ssl-status',    '🔐 SSL expiry status'),
    '/renewssl':  ('renew-ssl',     '🔄 Renew SSL certs'),
}

# Callback data → fix endpoint (includes monitor.sh button callbacks)
CB_MAP = {
    # Status
    'status':        'status',
    'status_full':   'status',
    'status-brief':  'status-brief',
    'top-procs':     'top-procs',
    'disk':          'disk',
    'disk_check':    'disk',
    'check-ports':   'check-ports',
    # Fixes
    'fix':           'fix',
    'mcp_restart':   'fix',
    'fix-nginx':     'fix-nginx',
    'nginx_fix':     'fix-nginx',
    'fix-php-fpm':   'fix-php-fpm',
    'php_fix':       'fix-php-fpm',
    'fix-mysql':     'fix-mysql',
    'mysql_fix':     'fix-mysql',
    'fix-services':  'fix-services',
    'fix-n8n':       'fix-n8n',
    # Logs
    'logs-nginx':    'logs-nginx',
    'logs-php':      'logs-php',
    'clear-logs':    'clear-logs',
    'clear_logs':    'clear-logs',
    # SSL
    'ssl-status':    'ssl-status',
    'renew-ssl':     'renew-ssl',
}

# Mute durations for callback buttons
MUTE_CALLBACKS = {
    'mute_30m': 30 * 60,
    'mute_1h':  60 * 60,
    'mute_4h':  4 * 60 * 60,
    'mute_24h': 24 * 60 * 60,
}

HELP_TEXT = """
*🪶 Perch — Server Intelligence*

📊 *Monitor*
`/status`  — RAM, Disk, CPU, Nginx, Services
`/brief`   — One-liner quick check
`/top`     — Top 10 processes by RAM/CPU
`/ports`   — Which services are up/down
`/disk`    — Disk usage breakdown

🔧 *Fix*
`/fix`      — Smart fix (auto-detect + repair all)
`/nginx`    — Restart nginx / nginx-rc
`/phpfpm`   — Restart PHP-FPM (any version)
`/mysql`    — Restart MySQL / MariaDB
`/services` — Restart all custom services
`/n8n`      — Restart n8n (if you run it)

📋 *Logs*
`/lognginx` — nginx error log + summary
`/logphp`   — PHP error log + top errors
`/clearlogs`— Truncate logs >50MB

🔐 *SSL*
`/ssl`      — SSL expiry status for all sites
`/renewssl` — Run certbot renew + reload nginx

🔕 *Alerts*
`/mute 2h`  — Silence alerts for 2 hours
`/mute 30m` — Silence for 30 minutes
`/unmute`   — Re-enable alerts
`/test`     — Send a test alert

⚙️ *Server*
`/reboot`  — Reboot server (asks confirmation)
`/menu`    — Show action buttons
`/help`    — This message
"""

# ── Duration parser ───────────────────────────────────────────────────────────

def parse_duration(s):
    s = s.lower().strip()
    try:
        if s.endswith('d'):  return int(s[:-1]) * 86400
        if s.endswith('h'):  return int(s[:-1]) * 3600
        if s.endswith('m'):  return int(s[:-1]) * 60
        return int(s) * 60
    except Exception:
        return 3600

# ── Handlers ──────────────────────────────────────────────────────────────────

def handle_message(msg):
    global muted_until, pending_reboot

    text    = msg.get('text', '').strip()
    chat_id = str(msg['chat']['id'])

    if chat_id != CHAT_ID:
        return   # Ignore unauthorized chats

    parts = text.split()
    if not parts:
        return
    cmd = parts[0].lower().split('@')[0]   # handle /cmd@botname

    # /help  /start
    if cmd in ('/help', '/start'):
        send(HELP_TEXT, chat_id=chat_id)
        return

    # /menu
    if cmd == '/menu':
        send('*Server Controls*', chat_id=chat_id, markup=main_kb())
        return

    # /test
    if cmd == '/test':
        send('✅ Bot is alive! Monitor alerts are working.', chat_id=chat_id)
        return

    # /mute [duration]
    if cmd == '/mute':
        dur = parts[1] if len(parts) > 1 else '1h'
        secs = parse_duration(dur)
        muted_until = time.time() + secs
        # Write mute file for monitor.sh — write both new + legacy paths
        for mute_path in ('/tmp/perch-monitor-muted', '/tmp/server-monitor-muted'):
            try:
                with open(mute_path, 'w') as f:
                    f.write(str(int(muted_until)))
            except Exception:
                pass
        until_str = time.strftime('%H:%M', time.localtime(muted_until))
        send(f'🔕 Alerts muted until {until_str}', chat_id=chat_id)
        return

    # /unmute
    if cmd == '/unmute':
        muted_until = 0.0
        import os as _os
        for mute_path in ('/tmp/perch-monitor-muted', '/tmp/server-monitor-muted'):
            try:
                _os.remove(mute_path)
            except FileNotFoundError:
                pass
        send('🔔 Alerts re-enabled', chat_id=chat_id)
        return

    # /reboot
    if cmd == '/reboot':
        pending_reboot[chat_id] = time.time()
        markup = {'inline_keyboard': [[
            {'text': '✅ YES — Reboot Now', 'callback_data': 'reboot_confirm'},
            {'text': '❌ Cancel',           'callback_data': 'reboot_cancel'},
        ]]}
        send('⚠️ *Confirm server reboot?*\nServer will be unreachable for ~30 seconds.',
             chat_id=chat_id, markup=markup)
        return

    # Known fix commands
    if cmd in COMMANDS:
        endpoint, label = COMMANDS[cmd]
        resp = send(f'⏳ {label}...', chat_id=chat_id)
        mid  = resp.get('result', {}).get('message_id')
        out  = fix(endpoint)
        if len(out) > 3800:
            out = out[:3800] + '\n…(truncated)'
        if mid:
            edit(mid, f'```\n{out}\n```', chat_id=chat_id, markup=main_kb())
        else:
            send(f'```\n{out}\n```', chat_id=chat_id, markup=main_kb())
        return

    # Unknown command
    safe_cmd = cmd.replace('`', '').replace('*', '').replace('_', '').replace('[', '').replace(']', '')
    send(f'Unknown command: `{safe_cmd}`\nType /help for all commands.', chat_id=chat_id)


def handle_callback(cb):
    global pending_reboot

    data    = cb['data']
    chat_id = str(cb['message']['chat']['id'])
    mid     = cb['message']['message_id']
    cb_id   = cb['id']

    if chat_id != CHAT_ID:
        answer_cb(cb_id, 'Unauthorized')
        return

    answer_cb(cb_id)

    # Reboot confirm / cancel
    if data == 'reboot_confirm':
        ts = pending_reboot.get(chat_id, 0)
        if time.time() - ts < 60:
            edit(mid, '🔄 *Rebooting server...*\nBot will reconnect automatically.', chat_id=chat_id)
            pending_reboot.pop(chat_id, None)
            time.sleep(1)
            import subprocess
            subprocess.run(['sudo', 'reboot'], check=False)
        else:
            edit(mid, '⏰ Confirmation expired. Run /reboot again.', chat_id=chat_id)
        return

    if data == 'reboot_cancel':
        edit(mid, '❌ Reboot cancelled.', chat_id=chat_id)
        pending_reboot.pop(chat_id, None)
        return

    if data == 'ignore':
        edit(mid, '✅ Alert acknowledged.', chat_id=chat_id)
        return

    # Mute callbacks (mute_30m, mute_1h, mute_4h, mute_24h)
    if data in MUTE_CALLBACKS:
        global muted_until
        secs = MUTE_CALLBACKS[data]
        muted_until = time.time() + secs
        try:
            with open('/tmp/perch-monitor-muted', 'w') as f:
                f.write(str(int(muted_until)))
            # Backward compat
            with open('/tmp/server-monitor-muted', 'w') as f:
                f.write(str(int(muted_until)))
        except Exception as e:
            print(f'[bot] mute write error: {e}', flush=True)
        until_str = time.strftime('%H:%M', time.localtime(muted_until))
        edit(mid, f'🔕 Alerts muted until {until_str}.', chat_id=chat_id)
        return

    # Fix server endpoints
    endpoint = CB_MAP.get(data)
    if endpoint:
        edit(mid, '⏳ Running...', chat_id=chat_id)
        out = fix(endpoint)
        if len(out) > 3800:
            out = out[:3800] + '\n…(truncated)'
        edit(mid, f'```\n{out}\n```', chat_id=chat_id, markup=main_kb())
    else:
        safe_data = data.replace('`', '').replace('*', '').replace('_', '').replace('[', '').replace(']', '')
        edit(mid, f'Unknown action: `{safe_data}`', chat_id=chat_id)


# ── Public helper for monitor.sh to check mute state ─────────────────────────

def is_muted():
    return time.time() < muted_until

# ── Main polling loop ─────────────────────────────────────────────────────────

def poll():
    offset = 0
    print(f'[bot] Started. Listening for updates (chat_id={CHAT_ID})...', flush=True)

    while True:
        try:
            r = requests.get(
                f'{TGAPI}/getUpdates',
                params={
                    'offset':           offset,
                    'timeout':          30,
                    'allowed_updates':  ['message', 'callback_query'],
                },
                timeout=35
            )
            data = r.json()
            if not data.get('ok'):
                print(f'[bot] API error: {data}', flush=True)
                time.sleep(5)
                continue

            for update in data.get('result', []):
                offset = update['update_id'] + 1
                try:
                    if 'message' in update:
                        handle_message(update['message'])
                    elif 'callback_query' in update:
                        handle_callback(update['callback_query'])
                except Exception as e:
                    print(f'[bot] Handler error: {e}', flush=True)

        except requests.exceptions.Timeout:
            pass  # Normal for long polling
        except Exception as e:
            print(f'[bot] Poll error: {e}', flush=True)
            time.sleep(5)


if __name__ == '__main__':
    if not BOT_TOKEN:
        print('ERROR: TELEGRAM_BOT_TOKEN not set in .env'); sys.exit(1)
    if not CHAT_ID:
        print('ERROR: TELEGRAM_CHAT_ID not set in .env');   sys.exit(1)
    if not FIX_TOKEN:
        print('WARNING: FIX_SERVER_TOKEN not set — fix commands will fail')
    poll()
