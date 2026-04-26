#!/usr/bin/env bash
# Perch — full one-shot deployer.
# Run this ON your RunCloud server (the box that hosts /home/<user>/webapps/Perch-Server-Brain).
# It pulls latest, builds, generates secrets, prepares systemd units, installs cron,
# wires the perch.adityaarsharma.com landing page (if a webapp dir is given),
# and prints everything you need to copy.
#
# Idempotent — safe to re-run for upgrades.

set -uo pipefail

# ── Resolve install directory ─────────────────────────────────────────────────

PERCH_DIR="${PERCH_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
PERCH_HOME="${PERCH_HOME:-$HOME/.perch}"
ENV_FILE="$PERCH_HOME/.env"
LANDING_TARGET="${PERCH_LANDING_DIR:-}"   # optional — webapp dir for perch.adityaarsharma.com

bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
hr()     { printf '%.0s─' {1..70}; printf '\n'; }
ok()     { green "  ✓ $*"; }
info()   { cyan  "  → $*"; }
warn()   { yellow "  ⚠ $*"; }
fail()   { red   "  ✗ $*"; }

env_get() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }
env_set() {
  local k="$1" v="$2"
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  if grep -q "^$k=" "$ENV_FILE" 2>/dev/null; then
    local tmp; tmp="$(mktemp)"; grep -v "^$k=" "$ENV_FILE" > "$tmp" || true
    echo "$k=$v" >> "$tmp"; mv "$tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
  else
    echo "$k=$v" >> "$ENV_FILE"
  fi
}
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
  fi
}
gen_key() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 32
  else node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
  fi
}

bold ""
bold "  🪶 Perch full deploy"
echo  "  install dir : $PERCH_DIR"
echo  "  config dir  : $PERCH_HOME"
hr

# ── Pre-flight ────────────────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || { fail "node 18+ required"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -lt 18 ] && { fail "node 18+ required (have $(node -v))"; exit 1; }
ok "node $(node -v)"

[ -d "$PERCH_HOME" ] || { mkdir -p "$PERCH_HOME"; chmod 700 "$PERCH_HOME"; }
ok "config dir ready (mode 700)"

# ── 1. Pull latest source ─────────────────────────────────────────────────────

cd "$PERCH_DIR"
if [ -d .git ]; then
  info "git fetch + fast-forward..."
  git fetch origin --quiet
  if ! git pull --ff-only origin main >/dev/null 2>&1; then
    warn "git pull failed (uncommitted changes?). continuing with local code."
  fi
  ok "source @ $(git rev-parse --short HEAD)"
fi

# ── 2. npm install + build ────────────────────────────────────────────────────

info "npm install..."
npm install --no-fund --no-audit --silent 2>&1 | tail -3 | sed 's/^/    /'
ok "deps installed"

info "tsc build..."
npm run build --silent 2>&1 | tail -5 | sed 's/^/    /'
ok "built"

# ── 3. Master key (encrypts the vault) ────────────────────────────────────────

if [ -z "$(env_get PERCH_MASTER_KEY)" ]; then
  K="$(gen_key)"
  env_set PERCH_MASTER_KEY "$K"
  ok "PERCH_MASTER_KEY generated"
  yellow "    BACK THIS UP NOW (1Password / Bitwarden / printed):"
  echo  "      PERCH_MASTER_KEY=$K"
else
  ok "PERCH_MASTER_KEY already set"
fi

# ── 4. HTTP API token (used by Niyati / external integrations) ───────────────

if [ -z "$(env_get PERCH_API_TOKEN)" ]; then
  T="$(gen_secret)"
  env_set PERCH_API_TOKEN "$T"
  env_set PERCH_API_HOST "127.0.0.1"
  env_set PERCH_API_PORT "3012"
  ok "PERCH_API_TOKEN generated"
  yellow "    Use this in Niyati's niyati_config.json:"
  echo  "      \"perch_api_token\": \"$T\","
  echo  "      \"perch_api_base\":  \"http://127.0.0.1:3012\""
else
  ok "PERCH_API_TOKEN already set"
fi

# ── 5. fix-server token (Telegram bot bridge) ─────────────────────────────────

if [ -z "$(env_get FIX_SERVER_TOKEN)" ]; then
  F="$(gen_secret)"
  env_set FIX_SERVER_TOKEN "$F"
  env_set FIX_SERVER_URL  "http://127.0.0.1:3011"
  env_set FIX_SERVER_HOST "127.0.0.1"
  env_set FIX_SERVER_PORT "3011"
  ok "FIX_SERVER_TOKEN generated (localhost-only)"
fi

# ── 6. Sensible automation defaults ───────────────────────────────────────────

[ -z "$(env_get RULE_DISK_WARN)" ]   && env_set RULE_DISK_WARN  "80"
[ -z "$(env_get RULE_DISK_HIGH)" ]   && env_set RULE_DISK_HIGH  "90"
[ -z "$(env_get RULE_DISK_CRIT)" ]   && env_set RULE_DISK_CRIT  "95"
[ -z "$(env_get RULE_RAM_WARN)" ]    && env_set RULE_RAM_WARN   "85"
[ -z "$(env_get RULE_RAM_CRIT)" ]    && env_set RULE_RAM_CRIT   "93"
[ -z "$(env_get RULE_HEARTBEAT)" ]   && env_set RULE_HEARTBEAT  "on"
[ -z "$(env_get MONITOR_TIMEZONE)" ] && env_set MONITOR_TIMEZONE "Asia/Kolkata"
[ -z "$(env_get MONITOR_SERVER_NAME)" ] && env_set MONITOR_SERVER_NAME "$(hostname -s)"
ok "automation defaults written to $ENV_FILE"

# ── 7. Cron — install monitor.sh every 5 min ──────────────────────────────────

if command -v crontab >/dev/null 2>&1; then
  CRON_LINE="*/5 * * * * $PERCH_DIR/telegram-bot/monitor.sh >> /tmp/perch-monitor.log 2>&1"
  EXISTING="$(crontab -l 2>/dev/null || echo '')"
  if echo "$EXISTING" | grep -qF "$PERCH_DIR/telegram-bot/monitor.sh"; then
    ok "cron entry already present"
  else
    ( echo "$EXISTING"; echo "$CRON_LINE" ) | crontab - 2>/dev/null && ok "cron installed (every 5 min)"
  fi
fi

# ── 8. systemd units ──────────────────────────────────────────────────────────

cat > /tmp/perch-api.service <<EOF
[Unit]
Description=Perch — HTTP API (intelligence layer)
After=network.target

[Service]
Type=simple
WorkingDirectory=$PERCH_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(which node) $PERCH_DIR/dist/api/server.js
Restart=always
RestartSec=5
User=$(whoami)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$PERCH_HOME

[Install]
WantedBy=multi-user.target
EOF
ok "perch-api.service prepared at /tmp/perch-api.service"

cat > /tmp/perch-fix-server.service <<EOF
[Unit]
Description=Perch — Telegram fix-server (action executor)
After=network.target

[Service]
Type=simple
WorkingDirectory=$PERCH_DIR/telegram-bot
EnvironmentFile=$ENV_FILE
ExecStart=$(which python3) $PERCH_DIR/telegram-bot/fix-server.py
Restart=always
RestartSec=5
User=$(whoami)
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
ok "perch-fix-server.service prepared at /tmp/perch-fix-server.service"

# ── 9. Optional: deploy landing page to webapp dir ────────────────────────────

if [ -n "$LANDING_TARGET" ]; then
  if [ -d "$LANDING_TARGET" ]; then
    ln -sf "$PERCH_DIR/web/index.html" "$LANDING_TARGET/index.html"
    ok "landing symlinked: $LANDING_TARGET/index.html → $PERCH_DIR/web/index.html"
  else
    warn "PERCH_LANDING_DIR=$LANDING_TARGET does not exist — skipped"
  fi
else
  info "Set PERCH_LANDING_DIR=/path/to/perch-webapp on next run to symlink the landing page"
fi

# ── 10. Summary ───────────────────────────────────────────────────────────────

hr
green "  Deploy complete."
hr
echo
echo "  Files written:"
echo "    $ENV_FILE                         (mode 600)"
echo "    $PERCH_DIR/dist/                   (built JS)"
echo "    /tmp/perch-api.service             (move with sudo to enable)"
echo "    /tmp/perch-fix-server.service      (move with sudo to enable)"
echo
echo "  Run these once with sudo to enable everything:"
echo
echo "    sudo mv /tmp/perch-api.service        /etc/systemd/system/"
echo "    sudo mv /tmp/perch-fix-server.service /etc/systemd/system/"
echo "    sudo systemctl daemon-reload"
echo "    sudo systemctl enable --now perch-api perch-fix-server"
echo
echo "  Verify:"
echo "    systemctl status perch-api perch-fix-server --no-pager"
echo "    curl -s http://127.0.0.1:3012/health"
echo "    curl -sf -X POST -H \"Authorization: Bearer \$(grep ^FIX_SERVER_TOKEN= $ENV_FILE | cut -d= -f2-)\" http://127.0.0.1:3011/status-brief"
echo
echo "  Add SSH credentials per server (encrypted via vault):"
echo "    cd $PERCH_DIR"
echo "    set -a && . $ENV_FILE && set +a"
echo "    npm run vault add ssh:my-server-name -- --file=/path/to/key"
echo "    # or password auth:"
echo "    npm run vault add pwd:my-server-name -- --value=\"theSshPassword\""
echo "    npm run vault list"
echo
echo "  Bulk-import all RunCloud servers (interactive):"
echo "    npm run import-runcloud"
echo
green "  🪶 Perch is ready."
