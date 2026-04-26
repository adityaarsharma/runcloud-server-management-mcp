#!/usr/bin/env bash
# Perch — Update to the latest version
# Pulls from origin, rebuilds, restarts service, sends Telegram notification.
# Idempotent — safe to run on cron (e.g., weekly auto-update).

set -uo pipefail

PERCH_DIR="${PERCH_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
PERCH_HOME="${PERCH_HOME:-$HOME/.perch}"
ENV_FILE="$PERCH_HOME/.env"

bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }

ok()    { green "  ✓ $*"; }
info()  { cyan  "  → $*"; }
warn()  { yellow "  ⚠ $*"; }
fail()  { red   "  ✗ $*"; }

cd "$PERCH_DIR" || { fail "Cannot cd to $PERCH_DIR"; exit 1; }

[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

bold ""
bold "  🪶 Perch Update"
echo  "  $PERCH_DIR"
echo

# ── Capture current version ────────────────────────────────────────────────────

OLD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
OLD_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"
info "Current: v${OLD_VERSION} (${OLD_SHA})"

# ── Fetch + check for updates ──────────────────────────────────────────────────

if ! git fetch origin --quiet 2>/dev/null; then
  fail "git fetch failed — check network or remote URL"
  exit 1
fi

LOCAL_SHA="$(git rev-parse HEAD 2>/dev/null)"
REMOTE_SHA="$(git rev-parse origin/main 2>/dev/null)"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  ok "Already up to date — nothing to do."
  exit 0
fi

# Show what's changing
COMMIT_COUNT="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
info "$COMMIT_COUNT new commit(s) available:"
git log --oneline HEAD..origin/main 2>/dev/null | head -10 | sed 's/^/    /'
echo

# ── Pull ──────────────────────────────────────────────────────────────────────

info "Pulling..."
if ! git pull --ff-only origin main 2>&1 | sed 's/^/    /'; then
  fail "Pull failed (likely local changes block fast-forward). Run: git status"
  exit 1
fi
ok "Pulled"

# ── Install + build ───────────────────────────────────────────────────────────

info "Installing dependencies..."
if ! npm install --no-fund --no-audit --silent 2>&1 | tail -5 | sed 's/^/    /'; then
  fail "npm install failed"
  exit 1
fi
ok "Dependencies up to date"

info "Building TypeScript..."
if ! npm run build --silent 2>&1 | tail -10 | sed 's/^/    /'; then
  fail "TypeScript build failed — rolling back"
  git reset --hard "$OLD_SHA"
  exit 1
fi
ok "Built"

NEW_SHA="$(git rev-parse --short HEAD)"
NEW_VERSION="$(node -p "require('./package.json').version")"
ok "Updated: v${OLD_VERSION} → v${NEW_VERSION} (${OLD_SHA} → ${NEW_SHA})"

# ── Restart service if installed ──────────────────────────────────────────────

if systemctl list-unit-files perch.service --no-legend 2>/dev/null | grep -q perch.service; then
  info "Restarting perch.service..."
  if sudo -n systemctl restart perch 2>/dev/null; then
    ok "perch.service restarted"
  else
    warn "Could not auto-restart perch.service (sudo required). Run: sudo systemctl restart perch"
  fi
fi

if systemctl list-unit-files perch-bot.service --no-legend 2>/dev/null | grep -q perch-bot.service; then
  info "Restarting perch-bot.service..."
  sudo -n systemctl restart perch-bot 2>/dev/null && ok "perch-bot restarted" || warn "Run: sudo systemctl restart perch-bot"
fi

# ── Notify Telegram (and Slack if configured) ────────────────────────────────

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] && command -v curl >/dev/null 2>&1; then
  CHANGELOG="$(git log --oneline "${OLD_SHA}..HEAD" 2>/dev/null | head -8)"
  TEXT=$(printf "🪶 *Perch updated*\n\n*v%s* → *v%s* (%s)\n\nWhat changed:\n\`\`\`\n%s\n\`\`\`\n\n_Server: %s_" \
    "$OLD_VERSION" "$NEW_VERSION" "$NEW_SHA" \
    "${CHANGELOG:-(no commits parsed)}" \
    "${MONITOR_SERVER_NAME:-$(hostname -s)}")
  curl -sf -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -H 'Content-Type: application/json' \
    --data-binary "$(printf '{"chat_id":"%s","text":%s,"parse_mode":"Markdown"}' \
      "$TELEGRAM_CHAT_ID" "$(printf '%s' "$TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
    > /dev/null 2>&1 && ok "Telegram notified" || warn "Telegram notification failed"
fi

if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  curl -sf -X POST "$SLACK_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "$(printf '{"text":"🪶 Perch updated: v%s → v%s on %s"}' \
        "$OLD_VERSION" "$NEW_VERSION" "${MONITOR_SERVER_NAME:-$(hostname -s)}")" \
    > /dev/null 2>&1 && ok "Slack notified"
fi

echo
green "  Update complete."
echo
echo "  Useful next steps:"
echo "    npm run vault list                       # Verify vault still works"
echo "    bash scripts/uninstall.sh                # If you ever want out"
