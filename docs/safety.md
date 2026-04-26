# Safety

Perch is paranoid by default. Here's exactly what it will and won't do on your servers, and how it handles the credentials you trust it with.

## The four promises

1. **Never destructive without confirmation.** Anything that could take a site offline asks first.
2. **Never expose credentials.** Not in messages, not in logs, not in the knowledge base.
3. **Always reversible, or clearly flagged as one-way.** If something can't be undone, you'll see it before you confirm.
4. **Always clear about what just happened.** Every action ends with a plain-language summary.

## Auto-actions — the whitelist

These run without a confirm because they're known-safe and reversible. The bot announces them after the fact.

| Action | Trigger | Why it's safe |
|---|---|---|
| Restart `nginx-rc` / `nginx` | Read-only failure detected | Standard recovery, fully reversible |
| Restart PHP-FPM | Process crashed or unresponsive | Same as above |
| Kill orphan processes | PPID=1 and idle past threshold | Already detached, parent gone |
| Truncate log files >50MB | Disk pressure | Truncate (`: > file.log`), never `rm` |
| Renew SSL certificate | Less than 7 days until expiry | Idempotent, certbot built-in |
| Clear expired WP transients | WordPress cleanup pass | wp-cli built-in safe op |
| Clear `/tmp` PHP sessions >24h | Cleanup | Session already abandoned by PHP |

That's the entire list. Anything not on it requires a confirm.

## Confirm-required actions — the gateway

Perch surfaces a Telegram button (or Slack message, when the adapter ships) and waits for a tap. Confirms expire after 5 minutes.

- Plugin deactivation
- Plugin update
- WordPress core update
- Database table operations (`OPTIMIZE`, `REPAIR`)
- File deletions
- Nginx config edits
- Service stops without an immediate restart
- Reboot

The confirm card always shows: what will run, on which server/webapp, and what the rollback path is.

## Never-auto — the blacklist

These never run without an explicit human action, even with a confirm flow. You have to invoke them by name from Claude Code or SSH:

- Backup restoration
- DB content modification (`DELETE` / `UPDATE` on user data)
- Filesystem `rm` outside `/tmp`
- User account changes
- Hetzner-level operations (shutdown, rebuild, snapshot delete)

Perch will help you plan these, draft the commands, and explain what they do — but it won't pull the trigger.

## Credential handling

**SSH passwords and keys.** Passed in tool arguments at call time. Never logged. Never written to the brain. Held in memory only for the duration of the call.

**The vault.** Long-lived secrets (RunCloud API keys, registered SSH keys, fix-server tokens you want to remember) live in `~/.perch/vault.json`, encrypted with AES-256-GCM. The encryption key comes from the `PERCH_MASTER_KEY` environment variable. Lose that key and the vault is gone — there's no recovery, by design.

**Redaction in errors.** Bearer tokens, password fields, and `BEGIN PRIVATE KEY` blocks are redacted from error messages before they reach the chat or the brain. The pattern matcher errs aggressive — false positives are fine, leaks are not.

**Never sent to chat.** Telegram and Slack messages never carry raw credentials, even in stack traces.

## What the knowledge base sees

`~/.perch/brain.db` is a SQLite store of patterns Perch has learned across your servers. It tracks:

- Server hostnames and webapp domains
- Plugin slugs and versions
- Problem types ("nginx restart needed after deploy", "session dir filled up")
- Root causes once identified
- Fixes that worked, fixes that didn't

It never stores:

- Passwords, API keys, or any secret material
- Database contents or query results
- User PII or content
- File contents
- Raw log lines (only summarised problem types)

You can inspect the brain at any time with `/perch_brain`.

## Telegram message safety

- Error logs are auto-truncated to a sensible length
- Sensitive paths are shortened — `/home/runcloud/webapps/secret-client/wp-config.php` becomes `~/webapps/.../wp-config.php`
- DB query results are never sent in raw form, only counts and shapes
- Plugin code, file contents, and config snippets are never echoed to chat
- Tracebacks are sanitised before display

If you need the raw output, run the command yourself over SSH or pull it from the MCP.

## Backup before destructive ops

When Perch is authorised to deactivate a plugin (the most common confirm-required action), it logs the previous state to the brain before flipping the switch. Same for service stops, nginx config edits, and any other reversible operation.

That state powers the undo system.

## The undo system

Perch keeps the last 10 confirmed actions in a rolling log. Each entry has the action, the target, the previous state, and a timestamp.

```
/perch undo
> Last action: deactivated wordfence on client-site.com (2 minutes ago)
> Reactivate? [Yes] [No]
```

Some actions have a 24-hour undo window — after that, the previous state may have drifted enough that auto-reverting is unsafe. Perch tells you before you confirm.

Undo never re-runs deletions in reverse (you can't un-delete a file from the log alone). For those, the log points you at the relevant backup.

## Network safety

- `fix-server.py` binds to `127.0.0.1` only. Never `0.0.0.0`. Verify with `ss -lntp | grep 3011`.
- Every fix-server call requires a bearer token. Mismatches return 401 and are logged.
- SSH connections use the `ssh2` library, not raw shell — this prevents command injection through hostnames or paths.
- All shell command parameters from button taps go through `validatePath`, `validateServiceName`, and `shellEscape` before reaching the script layer.
- The Telegram bot only acts on messages from whitelisted chat IDs. Everything else is silently dropped.

## If you suspect a leak

Rotate in this order, fastest to slowest:

1. **Telegram bot token.** Talk to @BotFather → `/revoke` → `/token`. Update `.env`, restart the bot.
2. **`FIX_SERVER_TOKEN`.** Generate a new value, update `.env` on both bot and fix-server, restart both.
3. **RunCloud API key.** Rotate in the RunCloud dashboard, update env, restart MCP.
4. **`PERCH_MASTER_KEY`.** This re-encrypts the vault. Run:

   ```bash
   perch vault rotate-key --new-key $NEW_KEY
   ```

   Keep both keys until the rotate finishes. The command writes a new `vault.json` with the new key, then atomically swaps it in.

After any rotation, audit `~/.perch/audit.log` for anything you didn't do.

## Reporting security issues

Email `security@adityaarsharma.com`, or open a private security advisory on the GitHub repo. Please don't open public issues for security bugs.

A coordinated disclosure window of 30 days is the default; longer if a fix needs more time.

## Next steps

- [install.md](./install.md) — the install paths, including how the vault and master key are set up
- [telegram.md](./telegram.md) — the bot's confirm flows in detail
- [runcloud.md](../runcloud.md) — RunCloud-specific safety notes
