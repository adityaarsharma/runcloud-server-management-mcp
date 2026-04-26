# Master Key — Where & How

Your Perch vault is encrypted with AES-256-GCM. The encryption key is derived from a single environment variable: `PERCH_MASTER_KEY`.

This one string is the difference between "my disk got stolen — no problem" and "my disk got stolen — they have everything."

---

## What it protects

The vault stores **everything secret Perch knows**:

- SSH passwords for every server you've added
- SSH private keys
- RunCloud API key
- Any custom credential you've stored via `npm run vault add`

Without `PERCH_MASTER_KEY`:
- The encrypted file `~/.perch/vault.json` is **useless** — random bytes.
- Brain DB (`~/.perch/brain.db`) has zero credentials. Only metadata.
- Every Perch tool that needs a credential will fail with a clear error message.

---

## Where Perch keeps it

| Location | Mode | Auto-loaded? |
|----------|------|--------------|
| `~/.perch/.env` | 0600 (only you can read) | yes — `setup.sh` writes it; `monitor.sh` and update.sh source it |
| environment variable | — | yes — anything started with `set -a && . ~/.perch/.env && set +a` inherits it |
| systemd service `EnvironmentFile=$ENV_FILE` | inherited from .env file | yes — the systemd unit `setup.sh` generates loads it |

The key is **never** committed to git, **never** sent over the network, **never** logged.

---

## Where YOU should keep a backup

This is the most important paragraph in this document:

> **If you lose your master key, the vault is gone forever. There is no recovery. There is no support email that can help you. The encryption is by design irreversible.**

Pick at least two of these places:

1. **Password manager** (1Password / Bitwarden / KeePass / iCloud Keychain) — most convenient. Create a "Perch master key" entry. Done.
2. **Encrypted note in another vault** — e.g., a GPG-encrypted file in your private GitHub repo, or an encrypted note in Standard Notes / Obsidian.
3. **Printed and sealed** — print the key, fold the paper, seal the envelope, store with your important documents.
4. **Hardware key with passkeys** — if you use a YubiKey or similar, store the master key as a static secret slot.

Don't keep it only on the same disk as `~/.perch/vault.json`. Disk dies, server gets wiped — both gone together.

---

## Generating a strong key

`setup.sh` does this automatically using one of:

```bash
# Preferred — uses OpenSSL's CSPRNG
openssl rand -base64 32

# Fallback — uses Node.js's crypto.randomBytes
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```

Both produce 32-byte keys (256 bits) base64-encoded. Output looks like:
```
PERCH_MASTER_KEY=qY3xJ7vN9P+RTH4dKVGz8L/sYxBXmAQ9eFcJpHnW2GU=
```

Don't try to invent your own key. Don't use a passphrase. Don't reuse a password from somewhere else.

---

## Rotating the master key

When to rotate:
- You suspect the key was exposed (committed to git accidentally, leaked in a screenshot, etc.)
- An employee with access has left
- Your security policy requires periodic rotation

How:

```bash
cd /opt/perch
set -a && . ~/.perch/.env && set +a

OLD_KEY="$PERCH_MASTER_KEY"

# Generate new key
NEW_KEY="$(openssl rand -base64 32)"

# Update .env
sed -i.bak "s|^PERCH_MASTER_KEY=.*|PERCH_MASTER_KEY=$NEW_KEY|" ~/.perch/.env
chmod 600 ~/.perch/.env

# Reload env into current shell
unset PERCH_MASTER_KEY
set -a && . ~/.perch/.env && set +a

# Re-encrypt every vault entry with the new key
npm run vault rotate -- --old-key="$OLD_KEY"

# Restart any running Perch services
sudo systemctl restart perch perch-bot 2>/dev/null
```

Update your password manager backup with the new key. Verify with `npm run vault list` — all entries should still be readable.

---

## What happens if I lose it?

You re-set up Perch from scratch:

1. Generate a new master key.
2. Re-add SSH credentials manually for every server (or re-import from RunCloud).
3. The brain DB is fine — losing the master key doesn't damage `brain.db`. You only lose the encrypted credentials.

This is annoying for a few minutes. Set up backups now so it stays hypothetical.

---

## What happens if it's exposed?

Treat it like a password leak:

1. Generate a new key + run vault rotation (see above) **immediately**.
2. Rotate the actual underlying credentials too — RunCloud API key, SSH passwords. The old key is encrypted, but if the encrypted vault was also exposed, an attacker can decrypt with the old key. Rotate the secrets themselves, not just the encryption.
3. Inspect logs (`/var/log/auth.log`, fail2ban) for unauthorized SSH activity.

---

## FAQ

**Can I store the master key inside Perch itself?**
No. That defeats the purpose — the key has to live somewhere outside the vault it protects. Otherwise an attacker who reads the file has both the lock and the key.

**Can I derive the key from a passphrase I remember?**
Not recommended. Memorable passphrases have far less entropy than 256 random bits, and Perch doesn't currently include a KDF (Argon2 / scrypt) on top of the master key. Use a password manager and store the random key.

**Can two Perch installs share the same master key?**
Yes — copy the same `PERCH_MASTER_KEY` value to both `.env` files. They can decrypt each other's vault files. Useful for backup recovery to a new machine.

**Does Perch ever transmit the key?**
No. The key is read from the environment, used in-process to derive an AES key via SHA-256, then thrown away. It never appears in logs, never goes over the network, never touches disk except in `~/.perch/.env` (which is mode 0600).

---

## Next steps

- [Safety promises](./safety.md) — what Perch protects beyond the master key
- [Install guide](./install.md) — full setup walkthrough
- [Automation rules](./automation.md) — what Perch does day-to-day
