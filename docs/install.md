# Installing Perch

Perch installs in two flavours: a Claude Code MCP for hands-on debugging, and a Telegram bot for 24/7 alerts. Pick one, or run both — they share the same brain and play nicely together.

## Prerequisites

| Requirement | Why | Notes |
|---|---|---|
| Node.js 18+ | Builds and runs the MCP server | `node --version` should print v18 or higher |
| Python 3.9+ | Runs the Telegram bot and fix-server | Only needed for bot install |
| RunCloud account | Server context, webapp data, deploys | Optional — Perch works on any Linux host |
| Telegram bot token | For the bot install | Free from [@BotFather](https://t.me/BotFather) |
| Linux or macOS dev machine | MCP install target | Windows works via WSL2 |
| `git`, `make`, `python3-dev` | Native compile of `better-sqlite3` | Pre-installed on most systems |

## Path A — Claude Code MCP

This gives Claude Code direct access to the `/perch_*` tool family. Best when you want to debug, plan, or run audits from your laptop.

```bash
git clone https://github.com/adityaarsharma/perch.git
cd perch
npm install
npm run build
```

Then open your Claude Code config:

```bash
# macOS
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
# Linux
$EDITOR ~/.config/claude/claude_desktop_config.json
```

Add the Perch block under `mcpServers`:

```json
{
  "mcpServers": {
    "perch": {
      "command": "node",
      "args": ["/absolute/path/to/perch/dist/index.js"],
      "env": {
        "RUNCLOUD_API_KEY": "your-runcloud-key",
        "RUNCLOUD_API_SECRET": "your-runcloud-secret",
        "PERCH_MASTER_KEY": "generate-a-random-32-byte-hex-string"
      }
    }
  }
}
```

Generate a master key once and keep it safe:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Restart Claude Code. In a new chat, type `/perch_brain` — you should see an empty knowledge state. That confirms the MCP is wired up.

## Path B — Telegram bot on your server

This puts a friendly polling bot on the box itself. It pages you, accepts taps, and runs whitelisted fixes.

SSH into the RunCloud server:

```bash
ssh runcloud@your-server.example.com
cd ~
git clone https://github.com/adityaarsharma/perch.git
cd perch/telegram-bot
chmod +x setup.sh
./setup.sh
```

`setup.sh` will ask for:

| Prompt | Where to get it |
|---|---|
| Telegram bot token | [@BotFather](https://t.me/BotFather) → `/newbot` |
| Telegram chat ID | DM [@userinfobot](https://t.me/userinfobot) or [@RawDataBot](https://t.me/RawDataBot) |
| Fix-server token | Any random string, 32+ chars |
| Fix-server port | Default `3011`, change only if it clashes |
| SSH user/host (optional) | For multi-server mode |

The script writes `.env`, installs Python deps in a venv, registers a `monitor.sh` cron job (every 10 minutes), and starts both processes.

Verify by sending `/status` in your Telegram chat. You should get a server health card within a few seconds.

## Path C — Both (recommended for agencies)

Run the MCP on your laptop and the Telegram bot on each client server. Same `git clone`, two configs. The MCP gives you Claude Code superpowers when you're at the keyboard; the bot watches and pages when you're not.

There's no extra wiring — both read from the same `runcloud.md` shape and never share state across servers.

## Common install issues

**`better-sqlite3` build fails.** You're missing build tools:

```bash
# macOS
xcode-select --install
# Debian / Ubuntu
sudo apt install -y python3 make g++ build-essential
```

Then re-run `npm install`.

**`Permission denied: ./setup.sh`.** Make it executable:

```bash
chmod +x telegram-bot/setup.sh
```

**Telegram bot not responding.** This is almost always a chat_id mismatch. Open `telegram-bot/.env`, double-check `TELEGRAM_CHAT_ID`. Group chat IDs are negative numbers (e.g. `-1001234567890`); DMs are positive.

**Build errors on M1/M2 Mac.** Force native arm64 build:

```bash
arch -arm64 npm install
arch -arm64 npm run build
```

**Port 3011 already in use.** Change `FIX_SERVER_PORT` in `.env` and restart.

## Verifying your install

| Check | Expected output |
|---|---|
| `/perch_brain` in Claude Code | Empty knowledge state, no errors |
| `/status` in Telegram | Card with uptime, load, disk, services |
| `curl http://127.0.0.1:3011/status -H "Authorization: Bearer $TOKEN"` | JSON server status |
| `tail -f telegram-bot/bot.log` | Polling messages every few seconds |

## Updating Perch

Pull, rebuild, restart:

```bash
cd ~/perch
git pull
npm install
npm run build
sudo systemctl restart perch-bot perch-fix-server
```

If you didn't install the systemd units, kill and restart `bot.py` / `fix-server.py` manually.

## Uninstalling

```bash
sudo systemctl disable --now perch-bot perch-fix-server
sudo rm /etc/systemd/system/perch-bot.service /etc/systemd/system/perch-fix-server.service
rm -rf ~/perch ~/.perch
```

The `~/.perch` directory holds the brain (SQLite) and the encrypted vault. Delete it only when you're sure — there's no recovery once it's gone.

## Next steps

- [telegram.md](./telegram.md) — wire up the bot, commands, and inline buttons
- [slack.md](./slack.md) — pipe alerts into a team channel
- [safety.md](./safety.md) — what Perch will and won't do on your servers
