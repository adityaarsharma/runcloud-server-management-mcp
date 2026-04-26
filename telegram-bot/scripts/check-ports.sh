#!/usr/bin/env bash
# Perch — Check listening ports with service identification
set -uo pipefail

echo "=== Listening Ports ==="
echo ""

ss -tlnp 2>/dev/null | awk 'NR>1{
  split($4, addr, ":")
  port = addr[length(addr)]
  proc = ""
  match($0, /users:\(\("([^"]+)"/, arr) && proc = arr[1]
  printf "%-6s  %s\n", port, proc
}' | sort -n | uniq

echo ""
echo "--- Key Service Checks ---"

check_port() {
  local label="$1" port="$2"
  ss -tlnp 2>/dev/null | grep -q ":${port}" \
    && echo "✅ ${label} (${port})" \
    || echo "⚪ ${label} (${port}) — not listening"
}

check_port "HTTP"         80
check_port "HTTPS"        443
check_port "SSH"          22
check_port "MySQL"        3306
check_port "Redis"        6379
check_port "n8n"          5678
check_port "Memcached"    11211
