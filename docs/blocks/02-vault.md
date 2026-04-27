# Block 2 — Vault

## Purpose

Encrypted, per-deployment credential storage for Perch. Holds the master
secrets so they aren't scattered across `.env` files: SSH keys, RunCloud
API tokens, Telegram bot tokens, Gemini key (if BYOK).

## Files

- `src/core/vault.ts` — encryption, decryption, key rotation
- `scripts/perch-vault.ts` — CLI wrapper (`npm run vault list/put/get/rotate`)
- `~/.perch/vault.json` — ciphertext at rest (mode 600)
- `~/.perch/.env` — holds `PERCH_VAULT_KEY` (mode 600, root-only backup at `/root/.perch-backup/`)
- HTTP API tools: `vault.list`, `vault.get`, `vault.put`

## Current state

- ✅ AES-256-GCM with scrypt KDF (v=2, salt set)
- ✅ Atomic rotation — temp file + rename, never partial write
- ✅ Master-key snapshot to `/root/.perch-backup/env-*.txt`
- ✅ HTTP API exposes `vault.list` and `vault.get` (read); `vault.put`
  intentionally write-side only via local `npm run vault put`
- ✅ Hardened in security audit (HANDOFF C1-C3, H4, H5, M6)

## Gaps (toward vision)

- [ ] TTL-aware entries (some secrets should auto-expire)
- [ ] Per-secret access audit (who pulled what, when)
- [ ] Multi-deployment vault (when multi-server lands)

## Next ship task

**Add per-entry TTL + automatic redaction in `vault.list` output** so secrets
near expiry surface in `perch_brain` snapshot. ~1h.

## Boundaries

- Vault is **only** the storage primitive. Auth/authorization for which
  caller can read which entry lives in HTTP API (block 3).
- Never log decrypted values. `src/core/redact.ts` enforces this.
