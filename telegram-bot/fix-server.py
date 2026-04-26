#!/usr/bin/env python3
"""
Fix Server — Local HTTP API for self-healing actions
Listens on 127.0.0.1 only. Called by bot.py and monitor.sh buttons.
"""
import os, subprocess, json, sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

def load_env():
    env_path = Path(__file__).parent / '.env'
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

load_env()

TOKEN   = os.environ.get('FIX_SERVER_TOKEN', '')
if not TOKEN:
    print("FATAL: FIX_SERVER_TOKEN is required. Set it in .env", flush=True)
    sys.exit(1)

try:
    PORT = int(os.environ.get('FIX_SERVER_PORT', '3011'))
except ValueError:
    print("FATAL: FIX_SERVER_PORT must be a number", flush=True)
    sys.exit(1)

HOST    = os.environ.get('FIX_SERVER_HOST', '127.0.0.1')
if HOST != '127.0.0.1':
    print(f"WARNING: Fix server binding to {HOST} - ensure firewall blocks port {PORT} from external access", flush=True)
SCRIPTS = Path(__file__).parent / 'scripts'

ROUTES = {
    # Core fix actions
    '/fix':          'smart-fix.sh',
    '/fix-nginx':    'fix-nginx.sh',
    '/fix-php-fpm':  'fix-php-fpm.sh',
    '/fix-mysql':    'fix-mysql.sh',
    '/fix-services': 'fix-services.sh',
    '/fix-n8n':      'fix-n8n.sh',         # optional — if user runs n8n
    # Status & diagnostics
    '/status':       'check-status.sh',
    '/status-brief': 'status-brief.sh',
    '/disk':         'check-disk.sh',
    '/check-ports':  'check-ports.sh',
    '/top-procs':    'top-procs.sh',
    # Logs
    '/logs-nginx':   'logs-nginx.sh',
    '/logs-php':     'logs-php.sh',
    # SSL
    '/ssl-status':   'ssl-status.sh',
    '/renew-ssl':    'renew-ssl.sh',
    # Maintenance
    '/clear-logs':   'clear-logs.sh',
}

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # Auth check
        if self.headers.get('Authorization') != f'Bearer {TOKEN}':
            print(f'[fix] AUTH FAILED from {self.client_address[0]}', flush=True)
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'{"error":"Unauthorized"}')
            return

        script = ROUTES.get(self.path)
        if not script:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(json.dumps({'error': f'Unknown endpoint: {self.path}'}).encode())
            return

        script_path = SCRIPTS / script
        if not script_path.exists():
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({'error': f'Script not found: {script}'}).encode())
            return

        try:
            r = subprocess.run(
                ['bash', str(script_path)],
                capture_output=True, text=True, timeout=60
            )
            output = (r.stdout + r.stderr).strip()
        except subprocess.TimeoutExpired:
            output = 'Script timed out after 60s'
        except Exception as e:
            output = f'Error: {e}'

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'output': output}).encode())

    def log_message(self, *args):
        pass  # Suppress access logs

if __name__ == '__main__':
    print(f'[fix-server] Listening on {HOST}:{PORT}', flush=True)
    HTTPServer((HOST, PORT), Handler).serve_forever()
