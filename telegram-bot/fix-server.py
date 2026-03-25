#!/usr/bin/env python3
"""
Fix Server — Local HTTP API for self-healing actions
Listens on 127.0.0.1 only. Called by bot.py and monitor.sh buttons.
"""
import os, subprocess, json
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
PORT    = int(os.environ.get('FIX_SERVER_PORT', '3011'))
HOST    = os.environ.get('FIX_SERVER_HOST', '127.0.0.1')
SCRIPTS = Path(__file__).parent / 'scripts'

ROUTES = {
    '/fix':          'smart-fix.sh',
    '/fix-nginx':    'fix-nginx.sh',
    '/fix-n8n':      'fix-n8n.sh',
    '/fix-services': 'fix-services.sh',
    '/clear-logs':   'clear-logs.sh',
    '/status':       'check-status.sh',
    '/status-brief': 'status-brief.sh',
    '/check-ports':  'check-ports.sh',
    '/disk':         'check-disk.sh',
}

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # Auth check
        if TOKEN and self.headers.get('Authorization') != f'Bearer {TOKEN}':
            self.send_response(403)
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
