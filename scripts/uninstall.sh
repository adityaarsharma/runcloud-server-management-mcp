#!/usr/bin/env bash
# Perch — Safe uninstaller
# Stops services, optionally backs up vault, removes config + build artifacts.
# THREE confirmations before any destructive action.

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

ask_yn() {
  local q="$1"; local d="${2:-n}"
  local opts="[y/N]"
  [ "$d" = "y" ] && opts="[Y/n]"
  read -rp "$q $opts: " ans
  ans="${ans:-$d}"
  case "$ans" in y|Y|yes|YES) return 0;; *) return 1;; esac
}

bold ""
bold "  🪶 Perch Uninstaller"
echo
yellow "  This will:"
echo  "    • Stop perch + perch-bot systemd services (if installed)"
echo  "    • Remove $PERCH_HOME (master key, vault, brain.db)"
echo  "    • Remove dist/ and node_modules/"
echo  "    • Remove cron entries pointing at this directory"
echo
yellow "  This will NOT:"
echo  "    • Touch any RunCloud servers or websites"
echo  "    • Delete the source repo (you can do that manually)"
echo

if ! ask_yn "Proceed?" "n"; then
  ok "Aborted — nothing changed."
  exit 0
fi

# ── Vault backup offer ───────────────────────────────────────────────────────

if [ -f "$PERCH_HOME/vault.json" ]; then
  echo
  yellow "  Your encrypted vault contains all SSH credentials."
  yellow "  Without the master key + this file, the data is gone forever."
  echo
  if ask_yn "Back up vault.json before deleting?" "y"; then
    BACKUP_DIR="${PERCH_BACKUP_DIR:-$HOME/perch-uninstall-backup-$(date +%Y%m%d-%H%M%S)}"
    mkdir -p "$BACKUP_DIR"
    chmod 700 "$BACKUP_DIR"
    cp -p "$PERCH_HOME/vault.json" "$BACKUP_DIR/vault.json"
    [ -f "$ENV_FILE" ] && cp -p "$ENV_FILE" "$BACKUP_DIR/.env"
    [ -f "$PERCH_HOME/brain.db" ] && cp -p "$PERCH_HOME/brain.db" "$BACKUP_DIR/brain.db"
    ok "Backed up to $BACKUP_DIR (mode 700)"
    yellow "    REMEMBER: keep your PERCH_MASTER_KEY too — without it the vault is useless."
  fi
fi

# ── Final confirm ────────────────────────────────────────────────────────────

echo
red "  This is your last chance."
if ! ask_yn "Type yes to wipe Perch from this machine" "n"; then
  ok "Aborted at final prompt — nothing changed."
  exit 0
fi
echo

# ── Stop services ────────────────────────────────────────────────────────────

for svc in perch perch-bot perch-fix-server; do
  if systemctl list-unit-files "$svc.service" --no-legend 2>/dev/null | grep -q "$svc"; then
    info "Stopping $svc..."
    sudo -n systemctl stop "$svc" 2>/dev/null || warn "Could not stop $svc (sudo needed)"
    sudo -n systemctl disable "$svc" 2>/dev/null || true
    sudo -n rm -f "/etc/systemd/system/$svc.service" 2>/dev/null || warn "Run: sudo rm /etc/systemd/system/$svc.service"
    ok "$svc removed"
  fi
done

if command -v systemctl >/dev/null 2>&1; then
  sudo -n systemctl daemon-reload 2>/dev/null || true
fi

# ── Remove cron entries ──────────────────────────────────────────────────────

if command -v crontab >/dev/null 2>&1; then
  CURRENT_CRON="$(crontab -l 2>/dev/null || echo '')"
  if echo "$CURRENT_CRON" | grep -q "$PERCH_DIR"; then
    info "Removing cron entries that reference $PERCH_DIR..."
    echo "$CURRENT_CRON" | grep -v "$PERCH_DIR" | crontab - 2>/dev/null || warn "Could not update crontab"
    ok "Cron cleaned"
  fi
fi

# ── Remove ~/.perch ──────────────────────────────────────────────────────────

if [ -d "$PERCH_HOME" ]; then
  info "Removing $PERCH_HOME..."
  rm -rf "$PERCH_HOME"
  ok "Config + vault + brain removed"
fi

# ── Remove build artifacts ────────────────────────────────────────────────────

if [ -d "$PERCH_DIR/dist" ]; then
  rm -rf "$PERCH_DIR/dist"
  ok "Removed dist/"
fi
if [ -d "$PERCH_DIR/node_modules" ]; then
  rm -rf "$PERCH_DIR/node_modules"
  ok "Removed node_modules/"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo
green "  Perch removed."
echo
echo "  Source code is still at $PERCH_DIR (delete manually if you want):"
echo "    rm -rf $PERCH_DIR"
echo
echo "  If you backed up the vault, the backup directory is at:"
echo "    ${BACKUP_DIR:-(no backup made)}"
