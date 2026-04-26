#!/usr/bin/env bash
# Perch — Interactive Setup Wizard
# Walks through: master key, MCP/Claude Code, Telegram, Slack, RunCloud, servers
# Idempotent — safe to re-run.

set -euo pipefail

PERCH_DIR="${PERCH_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
PERCH_HOME="${PERCH_HOME:-$HOME/.perch}"
ENV_FILE="$PERCH_HOME/.env"

# ── UI helpers ─────────────────────────────────────────────────────────────────

bold()    { printf '\033[1m%s\033[0m\n' "$*"; }
green()   { printf '\033[32m%s\033[0m\n' "$*"; }
yellow()  { printf '\033[33m%s\033[0m\n' "$*"; }
red()     { printf '\033[31m%s\033[0m\n' "$*" >&2; }
cyan()    { printf '\033[36m%s\033[0m\n' "$*"; }
hr()      { printf '%.0s─' {1..62}; printf '\n'; }

ok()    { green "  ✓ $*"; }
info()  { cyan  "  → $*"; }
warn()  { yellow "  ⚠ $*"; }
fail()  { red   "  ✗ $*"; }

ask() {
  # ask "Question?" "default" -> echoes answer
  local q="$1"; local d="${2:-}"
  local prompt
  if [ -n "$d" ]; then prompt="$q [$d]: "; else prompt="$q: "; fi
  read -rp "$prompt" ans
  echo "${ans:-$d}"
}

ask_yn() {
  # ask_yn "Question?" "y" -> returns 0 if yes, 1 if no
  local q="$1"; local d="${2:-y}"
  local opts="[y/N]"
  [ "$d" = "y" ] && opts="[Y/n]"
  while true; do
    read -rp "$q $opts: " ans
    ans="${ans:-$d}"
    case "$ans" in
      y|Y|yes|YES) return 0;;
      n|N|no|NO)   return 1;;
      *) echo "Please answer y or n.";;
    esac
  done
}

ask_secret() {
  # ask_secret "Prompt" -> echoes secret (input hidden)
  local q="$1"
  read -srp "$q: " ans
  echo  # newline after hidden input
  echo "$ans"
}

env_get() {
  # env_get KEY -> echoes value or empty
  [ ! -f "$ENV_FILE" ] && return 0
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true
}

env_set() {
  # env_set KEY VALUE — adds or replaces in .env
  local key="$1"; local val="$2"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  if grep -q "^$key=" "$ENV_FILE" 2>/dev/null; then
    # POSIX-safe in-place replace
    local tmp
    tmp="$(mktemp)"
    grep -v "^$key=" "$ENV_FILE" > "$tmp" || true
    echo "$key=$val" >> "$tmp"
    mv "$tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  else
    echo "$key=$val" >> "$ENV_FILE"
  fi
}

# ── Banner ─────────────────────────────────────────────────────────────────────

clear || true
bold ""
bold "  🪶 Perch Setup Wizard"
bold "  Server intelligence layer — interactive setup"
hr
echo
echo "  This wizard configures Perch end-to-end. You can skip any section."
echo "  Press Ctrl+C to abort at any time. Already-configured values are kept."
echo
echo "  Install dir:  $PERCH_DIR"
echo "  Config dir:   $PERCH_HOME"
hr
echo

# ── Pre-flight ─────────────────────────────────────────────────────────────────

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 18+ is required. Install from https://nodejs.org/"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -lt 18 ] && { fail "Node 18+ required (found $(node -v))"; exit 1; }
ok "Node.js $(node -v)"

if [ ! -d "$PERCH_HOME" ]; then mkdir -p "$PERCH_HOME"; chmod 700 "$PERCH_HOME"; fi
ok "Config directory $PERCH_HOME (mode 700)"

if [ ! -d "$PERCH_DIR/dist" ]; then
  info "Building Perch..."
  cd "$PERCH_DIR"
  npm install --no-fund --no-audit --silent
  npm run build --silent
  ok "Built"
fi
echo

# ── 1. Master encryption key ───────────────────────────────────────────────────

bold "Step 1 — Encryption Master Key"
echo "  Perch encrypts all credentials at rest with AES-256-GCM."
echo "  The master key is the ONLY thing protecting your vault if disk is stolen."
echo

EXISTING_KEY="$(env_get PERCH_MASTER_KEY)"
if [ -n "$EXISTING_KEY" ]; then
  ok "Master key already set in $ENV_FILE"
  echo "    (To rotate: delete the line and re-run setup, then run 'npm run vault rotate')"
else
  if ask_yn "Generate a new master key now?" "y"; then
    if command -v openssl >/dev/null 2>&1; then
      MASTER_KEY="$(openssl rand -base64 32)"
    else
      MASTER_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
    fi
    env_set PERCH_MASTER_KEY "$MASTER_KEY"
    ok "Master key generated and saved"
    echo
    yellow "  ⚠️  IMPORTANT — back up this key NOW. You will lose access to the vault if you lose it."
    echo
    echo "    PERCH_MASTER_KEY=$MASTER_KEY"
    echo
    echo "  Recommended places to store it:"
    echo "    1. Password manager (1Password, Bitwarden, KeePass)"
    echo "    2. Encrypted note in your secrets vault"
    echo "    3. Offline backup (printed + sealed)"
    echo
    read -rp "  Press Enter once you have backed it up..."
  else
    MASTER_KEY="$(ask_secret "Paste your existing PERCH_MASTER_KEY")"
    [ -z "$MASTER_KEY" ] && { fail "Master key cannot be empty"; exit 1; }
    env_set PERCH_MASTER_KEY "$MASTER_KEY"
    ok "Master key saved"
  fi
fi
echo

# ── 2. RunCloud API key ────────────────────────────────────────────────────────

bold "Step 2 — RunCloud API Key"
echo "  Optional. Required only if you want Perch to manage RunCloud servers."
echo "  Get yours at: https://manage.runcloud.io/settings/api-key"
echo

EXISTING_RC="$(env_get RUNCLOUD_API_KEY)"
if [ -n "$EXISTING_RC" ]; then
  ok "RunCloud API key already set"
  if ask_yn "Replace it?" "n"; then
    NEW_RC="$(ask_secret "RunCloud API key")"
    [ -n "$NEW_RC" ] && env_set RUNCLOUD_API_KEY "$NEW_RC" && ok "Updated"
  fi
elif ask_yn "Add a RunCloud API key?" "y"; then
  RC_KEY="$(ask_secret "RunCloud API key")"
  if [ -n "$RC_KEY" ]; then
    env_set RUNCLOUD_API_KEY "$RC_KEY"
    ok "Saved"
  else
    warn "Skipped — RunCloud-specific tools will not work"
  fi
else
  warn "Skipped — RunCloud-specific tools will not work"
fi
echo

# ── 3. Claude Code MCP integration ─────────────────────────────────────────────

bold "Step 3 — Claude Code MCP Integration"
echo "  Adds Perch's tools to your Claude Code sessions."
echo "  Skip this if you don't use Claude Code."
echo

if ask_yn "Show the Claude Code MCP config to copy-paste?" "y"; then
  echo
  echo "  Add this to ~/.claude/claude_desktop_config.json:"
  echo
  cat <<EOF
  {
    "mcpServers": {
      "perch": {
        "command": "node",
        "args": ["$PERCH_DIR/dist/index.js"],
        "env": {
          "PERCH_MASTER_KEY": "$(env_get PERCH_MASTER_KEY)",
          "RUNCLOUD_API_KEY": "$(env_get RUNCLOUD_API_KEY)"
        }
      }
    }
  }
EOF
  echo
  warn "Restart Claude Code after editing. Verify with: /perch_brain"
  echo
  read -rp "  Press Enter to continue..."
fi
echo

# ── 4. Telegram connector ──────────────────────────────────────────────────────

bold "Step 4 — Telegram Connector (optional)"
echo "  Get 24/7 alerts on your phone. Inline-button fixes."
echo "  Create bot at: @BotFather on Telegram"
echo

if ask_yn "Set up Telegram now?" "n"; then
  TG_TOKEN_OLD="$(env_get TELEGRAM_BOT_TOKEN)"
  if [ -n "$TG_TOKEN_OLD" ]; then
    ok "Telegram bot token already set"
    if ask_yn "Replace it?" "n"; then
      TG_TOKEN="$(ask_secret "New Telegram bot token")"
      [ -n "$TG_TOKEN" ] && env_set TELEGRAM_BOT_TOKEN "$TG_TOKEN"
    fi
  else
    TG_TOKEN="$(ask_secret "Telegram bot token (from @BotFather)")"
    [ -n "$TG_TOKEN" ] && env_set TELEGRAM_BOT_TOKEN "$TG_TOKEN" && ok "Saved bot token"
  fi

  TG_CHAT="$(env_get TELEGRAM_CHAT_ID)"
  if [ -z "$TG_CHAT" ]; then
    echo
    info "Get your chat ID:"
    echo "    1. Send /start to your new bot"
    echo "    2. Visit https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"
    echo "    3. Find 'chat':{'id': NUMBER}"
    NEW_CHAT="$(ask "Telegram chat ID (e.g., 123456789 or -100xxxxxxxxxx for groups)")"
    [ -n "$NEW_CHAT" ] && env_set TELEGRAM_CHAT_ID "$NEW_CHAT" && ok "Saved chat ID"
  else
    ok "Telegram chat ID already set"
  fi

  # Generate fix-server token if missing
  FS_TOKEN="$(env_get FIX_SERVER_TOKEN)"
  if [ -z "$FS_TOKEN" ]; then
    if command -v openssl >/dev/null 2>&1; then
      FS_TOKEN="$(openssl rand -hex 32)"
    else
      FS_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    fi
    env_set FIX_SERVER_TOKEN "$FS_TOKEN"
    env_set FIX_SERVER_URL "http://127.0.0.1:3011"
    env_set FIX_SERVER_HOST "127.0.0.1"
    env_set FIX_SERVER_PORT "3011"
    ok "Fix-server token generated (localhost-only)"
  fi
fi
echo

# ── 5. Slack connector ─────────────────────────────────────────────────────────

bold "Step 5 — Slack Connector (optional)"
echo "  Best for team channels and daily digests."
echo "  Create webhook: https://api.slack.com/apps → Incoming Webhooks"
echo

if ask_yn "Add a Slack webhook?" "n"; then
  EXISTING_SLACK="$(env_get SLACK_WEBHOOK_URL)"
  if [ -n "$EXISTING_SLACK" ] && ! ask_yn "Slack webhook already set — replace?" "n"; then
    :
  else
    NEW_SLACK="$(ask_secret "Slack incoming webhook URL")"
    [ -n "$NEW_SLACK" ] && env_set SLACK_WEBHOOK_URL "$NEW_SLACK" && ok "Saved Slack webhook"
  fi
fi
echo

# ── 6. Server connections ─────────────────────────────────────────────────────

bold "Step 6 — Server Connections"
echo "  Add servers Perch should watch and manage."
echo "  Each server needs SSH access. Password OR private key supported."
echo

if ask_yn "Add servers now?" "y"; then
  # shellcheck disable=SC1091
  set -a && . "$ENV_FILE" && set +a
  while true; do
    echo
    cyan "  --- New server ---"
    NAME="$(ask "Server name (e.g., production-1)")"
    [ -z "$NAME" ] && break

    SLUG="$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+|-+$//g')"
    HOST="$(ask "IP or hostname")"
    [ -z "$HOST" ] && { warn "Skipped (no host)"; continue; }
    SSH_USER="$(ask "SSH user" "runcloud")"

    echo "  Auth method:"
    echo "    1) Password   (RunCloud creates a password for the runcloud user)"
    echo "    2) Private key (paste PEM or load from file)"
    AUTH_CHOICE="$(ask "Choose 1 or 2" "1")"

    case "$AUTH_CHOICE" in
      1)
        PWD_VAL="$(ask_secret "SSH password for $SSH_USER@$HOST")"
        if [ -n "$PWD_VAL" ]; then
          # Use vault CLI through tsx (env already loaded)
          ( cd "$PERCH_DIR" && npx tsx scripts/perch-vault.ts add "pwd:$SLUG" --value="$PWD_VAL" )
          ( cd "$PERCH_DIR" && npx tsx scripts/perch-vault.ts add "meta:$SLUG" --value="{\"host\":\"$HOST\",\"user\":\"$SSH_USER\",\"auth\":\"password\",\"name\":\"$NAME\"}" )
          ok "Stored encrypted password + metadata for $NAME"
        fi
        ;;
      2)
        KEY_PATH="$(ask "Path to private key file (or empty to paste)")"
        if [ -n "$KEY_PATH" ] && [ -f "$KEY_PATH" ]; then
          ( cd "$PERCH_DIR" && npx tsx scripts/perch-vault.ts add "ssh:$SLUG" --file="$KEY_PATH" )
        else
          info "Paste the private key (PEM). End with a blank line:"
          KEY_BUF=""
          while IFS= read -r line; do
            [ -z "$line" ] && break
            KEY_BUF="${KEY_BUF}${line}"$'\n'
          done
          if [ -n "$KEY_BUF" ]; then
            TMP_KEY="$(mktemp)"
            chmod 600 "$TMP_KEY"
            printf '%s' "$KEY_BUF" > "$TMP_KEY"
            ( cd "$PERCH_DIR" && npx tsx scripts/perch-vault.ts add "ssh:$SLUG" --file="$TMP_KEY" )
            rm -f "$TMP_KEY"
          fi
        fi
        ( cd "$PERCH_DIR" && npx tsx scripts/perch-vault.ts add "meta:$SLUG" --value="{\"host\":\"$HOST\",\"user\":\"$SSH_USER\",\"auth\":\"key\",\"name\":\"$NAME\"}" )
        ok "Stored encrypted key + metadata for $NAME"
        ;;
      *) warn "Invalid choice — skipping";;
    esac

    ask_yn "Add another server?" "y" || break
  done
fi
echo

# ── 6.5 Install automation rules cron (monitor.sh) ────────────────────────────

bold "Step 6.5 — Install Automation Rules"
echo "  Perch's monitor runs 14 rules every 5 minutes:"
echo "    nginx down · PHP-FPM down · MySQL down · Disk tiered (warn/high/crit)"
echo "    RAM tiered · CPU sustained · Orphans · Failed services"
echo "    SSL expiry · HTTP availability · Custom ports · fail2ban spike"
echo "    Backup age · Daily heartbeat at 09:00 local"
echo
echo "  Each alert lands in your Telegram with the right action buttons."
echo

if ask_yn "Install the monitor.sh cron job?" "y"; then
  MONITOR_SCRIPT="$PERCH_DIR/telegram-bot/monitor.sh"
  CRON_LINE="*/5 * * * * $MONITOR_SCRIPT >> /tmp/perch-monitor.log 2>&1"

  if ! [ -x "$MONITOR_SCRIPT" ]; then
    chmod +x "$MONITOR_SCRIPT" 2>/dev/null || warn "Could not make $MONITOR_SCRIPT executable"
  fi

  if command -v crontab >/dev/null 2>&1; then
    EXISTING_CRON="$(crontab -l 2>/dev/null || echo '')"
    if echo "$EXISTING_CRON" | grep -qF "$MONITOR_SCRIPT"; then
      ok "Cron entry already exists for monitor.sh"
    else
      ( echo "$EXISTING_CRON"; echo "$CRON_LINE" ) | crontab - 2>/dev/null
      if [ $? -eq 0 ]; then
        ok "Installed cron: */5 * * * * monitor.sh"
      else
        warn "Failed to install cron — add manually:"
        echo "    crontab -e"
        echo "    $CRON_LINE"
      fi
    fi
  else
    warn "crontab not available — add manually to your scheduler:"
    echo "    $CRON_LINE"
  fi
  echo
  echo "  You can tune thresholds in $ENV_FILE, e.g.:"
  echo "    RULE_DISK_WARN=80      RULE_DISK_HIGH=90      RULE_DISK_CRIT=95"
  echo "    RULE_RAM_WARN=85       RULE_RAM_CRIT=93"
  echo "    RULE_LOAD_PCT_WARN=100 RULE_LOAD_PCT_CRIT=200"
  echo "    MONITOR_SITES=site1.com,site2.com   # for SSL + HTTP availability rules"
  echo "    MONITOR_PORTS=3000,5678              # for custom port checks"
  echo "    RULE_HEARTBEAT=on                    # daily 09:00 check-in"
fi
echo

# ── 7. systemd service ─────────────────────────────────────────────────────────

bold "Step 7 — Run Perch as a System Service (optional)"
echo "  Recommended for production. Auto-restarts on crash, starts on boot."
echo

if ask_yn "Generate a systemd service unit?" "y"; then
  SERVICE_FILE="/tmp/perch.service"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Perch — Server Intelligence Layer
After=network.target

[Service]
Type=simple
WorkingDirectory=$PERCH_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(which node) $PERCH_DIR/dist/index.js
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
  ok "Service unit at $SERVICE_FILE"
  echo
  echo "  To install (requires sudo):"
  echo "    sudo mv $SERVICE_FILE /etc/systemd/system/perch.service"
  echo "    sudo systemctl daemon-reload"
  echo "    sudo systemctl enable --now perch"
  echo "    sudo systemctl status perch"
fi
echo

# ── 8. Summary ─────────────────────────────────────────────────────────────────

hr
bold "Setup Complete"
hr
echo

if [ -f "$ENV_FILE" ]; then
  ok "Config:        $ENV_FILE (mode 600)"
fi
if [ -f "$PERCH_HOME/vault.json" ]; then
  ENTRY_COUNT="$(node -e "console.log(Object.keys(require('$PERCH_HOME/vault.json').entries||{}).length)" 2>/dev/null || echo "?")"
  ok "Vault:         $PERCH_HOME/vault.json ($ENTRY_COUNT entries)"
fi
if [ -f "$PERCH_HOME/brain.db" ]; then
  ok "Brain DB:      $PERCH_HOME/brain.db"
fi
echo
echo "  Useful commands:"
echo "    npm run vault list                       # Show all vault entries"
echo "    npm run vault add <id> -- --value=...    # Add another credential"
echo "    npm run import-runcloud                  # Bulk-import from RunCloud API"
echo "    npm run start                            # Start Perch (foreground)"
echo "    bash scripts/update.sh                   # Pull latest, rebuild"
echo "    bash scripts/uninstall.sh                # Remove everything (with confirm)"
echo
green "  🪶 Perch is ready."
