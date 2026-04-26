# RunCloud Server Management Guide

> For anyone using the RunCloud MCP or Claude Code skill. Everything you need to operate a RunCloud-powered server without the dashboard.

---

## The RunCloud Stack — What's Different

RunCloud installs its own custom builds. Standard Ubuntu commands will mislead you.

| Component | Ubuntu default | RunCloud |
|-----------|---------------|----------|
| Web server binary | `nginx` | `nginx-rc` at `/usr/local/sbin/nginx-rc` |
| Web server service | `nginx.service` | `nginx-rc.service` |
| Config root | `/etc/nginx/` | `/etc/nginx-rc/` |
| PHP-FPM | `php8.x-fpm` | `php8x-fpm-rc` |

**Critical rules:**
- Always use `systemctl restart nginx-rc` — never `nginx`
- Config test: `sudo /usr/local/sbin/nginx-rc -t`
- Safe to edit: `/etc/nginx-rc/extra.d/` only
- Never touch: `/etc/nginx-rc/conf.d/` (RunCloud overwrites it)

---

## Nginx Config Structure

```
/etc/nginx-rc/
├── nginx.conf                    # RunCloud-managed, don't touch
├── conf.d/
│   └── {webapp}.d/
│       ├── main.conf             # RunCloud-managed
│       └── ssl.conf              # RunCloud-managed
└── extra.d/
    ├── {webapp}.location.root.nginx-proxy.conf   # YOUR custom blocks go here
    └── {webapp}.main.nginx-proxy.conf            # YOUR custom blocks go here
```

**When you add reverse proxy blocks:** Always use `extra.d/`. RunCloud preserves these across panel operations.

---

## Common Operations (CLI, no API needed)

### nginx-rc

```bash
# Check status
systemctl is-active nginx-rc

# Restart
sudo systemctl restart nginx-rc

# Test config before restart
sudo /usr/local/sbin/nginx-rc -t

# Reload (zero-downtime config reload)
sudo systemctl reload nginx-rc

# View error log
sudo tail -50 /var/log/nginx-rc/error.log

# View access log for a webapp
sudo tail -50 /var/log/nginx-rc/{webapp}.access.log
```

### PHP-FPM

```bash
# List PHP-FPM services
systemctl list-units | grep fpm-rc

# Restart PHP 8.2
sudo systemctl restart php82-fpm-rc

# Check PHP-FPM status
systemctl status php82-fpm-rc
```

### Supervisor (Queue Workers)

```bash
# List supervisor jobs
sudo supervisorctl status

# Restart a specific worker
sudo supervisorctl restart {worker-name}

# Reload all configs
sudo supervisorctl reread && sudo supervisorctl update
```

### PM2 (RunCloud deploys Node/Python apps with PM2)

PM2 is per-user. The binary is in the user's npm-global, not in PATH for root.

```bash
# Always run as the app user with login shell
sudo -u {appuser} bash -l -c 'pm2 list'
sudo -u {appuser} bash -l -c 'pm2 restart {app-name}'
sudo -u {appuser} bash -l -c 'pm2 logs {app-name} --lines 50 --nostream'
sudo -u {appuser} bash -l -c 'pm2 flush {app-name}'   # Clear log files
```

---

## Troubleshooting Nginx-RC Won't Start

Work through these in order:

**1. Run the config test**
```bash
sudo /usr/local/sbin/nginx-rc -t
```
Read the error. It will point to the exact file and line.

**2. Check log permissions**
```bash
ls -la /var/log/nginx-rc/
# If owned by root:root with 700, nginx-rc worker can't write
sudo chmod 755 /var/log/nginx-rc/
sudo chmod 644 /var/log/nginx-rc/*.log
```

**3. Check conf.d permissions (POSIX ACL issue)**
```bash
ls -la /etc/nginx-rc/conf.d/
# Files with '+' at end have ACL entries that may block access
# Fix with:
sudo chmod -R 644 /etc/nginx-rc/conf.d/**/*.conf
sudo chmod -R 755 /etc/nginx-rc/conf.d/**/
```

**4. Variable stripping bug in custom configs**

If you (or a script) wrote nginx configs using Python string interpolation without raw strings, `$variable` references get stripped to `variable`. This makes nginx invalid.

Signs: `invalid condition "!="` or `unknown directive` errors pointing to your `extra.d/` file.

Fix: Manually restore `$` prefixes in the broken block:
```nginx
# Wrong (stripped):
proxy_set_header Host host;
proxy_set_header X-Real-IP remote_addr;

# Correct:
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
```

**Prevention:** When writing nginx configs in Python, use raw strings or heredocs:
```python
# Safe
config = r"""
    proxy_set_header Host $host;
"""

# Also safe (bash heredoc with single-quoted delimiter)
# cat << 'EOF' > /etc/nginx-rc/extra.d/myapp.conf
```

---

## Adding a Reverse Proxy Location Block

Full template for a secure proxy with Bearer auth check:

```nginx
location /myapp/ {
    if ($http_authorization != "Bearer your-secret-token") {
        set $auth_failed 1;
    }
    if ($http_authorization = "Bearer your-secret-token") {
        set $auth_failed 0;
    }
    if ($auth_failed = 1) { return 401; }

    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Accept            "application/json, text/event-stream";
    proxy_pass         http://127.0.0.1:PORT/;
    proxy_http_version 1.1;
    proxy_set_header   Connection '';
    proxy_buffering    off;
    proxy_cache        off;
    proxy_read_timeout 300;
}
```

Place in: `/etc/nginx-rc/extra.d/{webapp}.location.root.nginx-proxy.conf`

Then: `sudo /usr/local/sbin/nginx-rc -t && sudo systemctl restart nginx-rc`

---

## RunCloud Web Application Isolation

Each web app runs under its own system user. Unlike cPanel's shared user model:

- App user: typically `{appname}` or a short version
- Web root: `/home/{appuser}/webapps/{appname}/`
- PHP-FPM pool: runs as `{appuser}`, not www-data
- Logs: `/home/{appuser}/logs/` and `/var/log/nginx-rc/{appname}.*.log`

This means: files created by PHP/Node must be writable by `{appuser}`, not `www-data`.

---

## RunCloud API (when you need it)

Base URL: `https://manage.runcloud.io/api/v3/`  
Auth: `Authorization: Bearer {api_key}` (v3) or Basic auth (v2)

Key endpoints:
```bash
# List servers
GET /servers

# List web apps on a server
GET /servers/{serverId}/webapps

# Restart nginx-rc via API
POST /servers/{serverId}/services/nginx-rc/restart

# Switch PHP version
PATCH /servers/{serverId}/webapps/{webappId}
Body: {"phpVersion": "8.2"}

# Deploy (git)
POST /servers/{serverId}/webapps/{webappId}/git/deploy
```

Rate limiting: 60 requests/minute (v3).

---

## Disk & Logs Maintenance

```bash
# Check disk usage by directory
sudo du -sh /home/*/webapps/* 2>/dev/null | sort -rh | head -20

# Clear PM2 logs for all apps (as app user)
sudo -u {appuser} bash -l -c 'pm2 flush'

# Clear nginx-rc access logs (careful — truncate, don't delete)
sudo truncate -s 0 /var/log/nginx-rc/*.access.log

# Find large log files
sudo find /var/log -name "*.log" -size +100M -ls 2>/dev/null

# Journal cleanup
sudo journalctl --vacuum-size=500M
```

---

## n8n on RunCloud

n8n installs globally but runs as its own user (uid 1000 typically).

```bash
# Check if n8n is running
pgrep -cf n8n

# Find the n8n process
ps aux | grep n8n | grep -v grep

# n8n is usually managed by PM2 under its own user
sudo -u {n8nuser} bash -l -c 'pm2 list'
sudo -u {n8nuser} bash -l -c 'pm2 restart n8n'

# n8n logs
sudo -u {n8nuser} bash -l -c 'pm2 logs n8n --lines 50 --nostream'
```

---

## Server Monitor Pattern (Telegram + fix-server)

The recommended pattern for self-healing servers:

1. **monitor.sh** — cron script (every 10 min) that checks services and sends Telegram alerts with inline keyboard buttons
2. **fix-server.py** — lightweight HTTP API (internal only, port 3011) that executes fixes
3. **Telegram bot** — polling bot with `CallbackQueryHandler` that receives button clicks and calls fix-server

### fix-server API

```bash
# Internal only — never expose to internet
# Auth: Authorization: Bearer {token}

POST http://127.0.0.1:3011/fix          # Smart fix (tries everything)
POST http://127.0.0.1:3011/fix-nginx    # Restart nginx-rc only
POST http://127.0.0.1:3011/fix-n8n     # Restart n8n only
POST http://127.0.0.1:3011/fix-mcps    # Restart all MCP processes
GET  http://127.0.0.1:3011/status      # Full status JSON
GET  http://127.0.0.1:3011/status-brief # One-line status
GET  http://127.0.0.1:3011/disk        # Disk usage
POST http://127.0.0.1:3011/clear-logs  # Truncate log files
GET  http://127.0.0.1:3011/check-ports # Port availability
```

### Telegram bot + polling conflict

**Never run two things that both poll the same bot token.** Only one consumer can poll; the other gets nothing.

- If you use a bot for both Telegram polling AND n8n webhook callbacks: the polling bot wins and n8n never sees button clicks.
- Solution: handle all Telegram interactions (including button callbacks) in the polling bot. n8n should use a separate webhook URL (not Telegram's callback mechanism) for server integrations.

---

## Hetzner API (server-level operations)

For actions RunCloud can't do (reboot, rescue mode, rebuild):

```bash
# List servers
curl -H "Authorization: Bearer {api_key}" \
  https://api.hetzner.cloud/v1/servers

# Reboot a server
curl -X POST \
  -H "Authorization: Bearer {api_key}" \
  https://api.hetzner.cloud/v1/servers/{server_id}/actions/reboot

# Power off
curl -X POST \
  -H "Authorization: Bearer {api_key}" \
  https://api.hetzner.cloud/v1/servers/{server_id}/actions/poweroff
```

---

## Quick Reference: What Runs Where

| Service | Binary/Command | Managed by |
|---------|---------------|------------|
| nginx-rc | `/usr/local/sbin/nginx-rc` | systemd |
| PHP-FPM | `php{ver}-fpm-rc` | systemd |
| Supervisor workers | `supervisord` | systemd |
| Node/Python apps | PM2 (per user) | PM2 ecosystem |
| n8n | `node /usr/local/bin/n8n` | PM2 or systemd |
| Uptime Kuma | Node process | PM2 |

---

## When Nothing Works

Systematic order:

1. `sudo /usr/local/sbin/nginx-rc -t` — is the config valid?
2. `sudo systemctl status nginx-rc` — is the service running?
3. `sudo -u {appuser} bash -l -c 'pm2 list'` — are app processes up?
4. `df -h` — is disk full?
5. `free -h` — is memory exhausted?
6. `sudo journalctl -u nginx-rc -n 50` — what do systemd logs say?
7. `sudo tail -50 /var/log/nginx-rc/error.log` — nginx errors?
