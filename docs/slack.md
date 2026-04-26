# Slack integration

Slack works well for agency teams who already live in channels and threads. Today, Perch ships alerts to Slack via incoming webhooks; tomorrow, full slash-command parity with Telegram is on the roadmap.

## What works today

- One-way alert delivery from `monitor.sh` and the MCP into a Slack channel
- Block Kit formatting via the shared `formatSlackAlert` helper in `src/core/gateway.ts`
- Channel routing — different channels for critical pages vs daily digest
- Hybrid use alongside the Telegram bot, so the team channel mirrors what the on-call DM sees

## What's coming

- A Slack bot adapter with slash commands (`/perch status`, `/perch fix nginx`)
- Inline button interactions matching the Telegram tap-to-fix UX
- Per-user mute and acknowledge so a team can divide on-call cleanly

The alert formatter is already shared, so the day the adapter lands, every existing alert pipeline starts working without a rewrite.

## Creating a Slack incoming webhook

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** → **From scratch**
2. Name it `Perch` and pick the workspace
3. In the sidebar, open **Incoming Webhooks** and toggle it on
4. Click **Add New Webhook to Workspace**
5. Pick the channel (e.g. `#ops-alerts`) and authorise
6. Copy the webhook URL — it looks like `https://hooks.slack.com/services/T000/B000/XXXX`

Treat the URL as a secret. Anyone holding it can post to the channel.

## Wiring `monitor.sh` to Slack

Set the webhook in your env and post Block Kit JSON. The simplest pattern, dropped at the bottom of `monitor.sh` next to the existing Telegram POST:

```bash
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/T000/B000/XXXX"

curl -s -X POST -H 'Content-Type: application/json' \
  --data @- "$SLACK_WEBHOOK_URL" <<'JSON'
{
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "High load on web-01" }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Load:*\n5.42" },
        { "type": "mrkdwn", "text": "*Disk:*\n62%" },
        { "type": "mrkdwn", "text": "*PHP-FPM:*\nrunning" },
        { "type": "mrkdwn", "text": "*Nginx:*\nrunning" }
      ]
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Perch · 2026-04-26 14:02 UTC" }
      ]
    }
  ]
}
JSON
```

A 200 response with body `ok` means it landed.

## Channel routing

Two webhooks beat one. Create a second app (or a second webhook on the same app) and split traffic by severity:

| Severity | Channel | Webhook |
|---|---|---|
| Critical (page) | `#ops-alerts` | `SLACK_CRIT_URL` |
| Daily digest | `#ops-digest` | `SLACK_DIGEST_URL` |
| Deploy events | `#deploys` | `SLACK_DEPLOY_URL` |

In `monitor.sh`, branch on the alert level and pick the right URL. Keep the noisy channel muted by your team and the critical one always-on.

## From the MCP tools

The MCP exports `formatSlackAlert(opts)` from `src/core/gateway.ts`. It returns Block Kit JSON ready to POST to any webhook:

```ts
import { formatSlackAlert } from './core/gateway';

const blocks = formatSlackAlert({
  title: 'SSL expires in 5 days',
  server: 'web-01.example.com',
  domain: 'client-site.com',
  severity: 'warning',
  fields: [
    { label: 'Issuer', value: "Let's Encrypt" },
    { label: 'Expires', value: '2026-05-01' }
  ],
  actions: [
    { label: 'Renew now', value: 'ssl:renew:client-site.com' }
  ]
});

await fetch(process.env.SLACK_WEBHOOK_URL!, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ blocks })
});
```

The same helper is used by the Telegram alert pipeline (with a different renderer at the end), so the shape stays consistent.

## Slack vs Telegram

| | Slack | Telegram |
|---|---|---|
| Real-time mobile alerts | Decent | Faster, more reliable on mobile |
| Team threading and history | Strong | Weak |
| Free tier | Free up to limits | Always free |
| Inline button actions today | Not yet | Yes |
| Slash commands today | Not yet | Yes (`/status`, `/fix`, etc.) |
| Setup time | ~5 min | ~5 min |
| Best for | Agency teams, async ops | Solo operators, on-call pages |

Neither is "better" — they fit different shapes of team.

## The hybrid pattern

This is what most agencies end up running:

- **Telegram DM to the on-call** — the 3am page that wakes someone up. Fast, tap-to-fix, no team noise.
- **Slack channel for the team** — same alerts, lower urgency, threaded discussion. The whole team sees what happened without anyone being paged.
- **Daily digest in a quieter Slack channel** — a single morning post with yesterday's incidents, fixes applied, and anything still open.

Wire all three from the same `monitor.sh` — it's just three more `curl` calls.

## Security

- Webhook URLs are secrets. Keep them in `.env`, not in git.
- If a URL leaks, regenerate it immediately from the Slack app settings page.
- Webhooks have no read permission — even a leaked URL only lets the holder post to that one channel. Still rotate.
- If you build the Slack adapter ahead of the official one, store the bot token in the Perch vault (see [safety.md](./safety.md)).

## Coming soon: the Slack bot adapter

Tracking parity with Telegram:

- `/perch status` — same card the bot posts on the Telegram side
- `/perch fix nginx` — same whitelist, same confirm semantics
- Block Kit buttons that hit the fix-server with a bearer token
- Per-user mute via Slack user IDs
- Channel-scoped permissions so `#client-acme` can only fix Acme servers

When it ships, your existing webhook setup keeps working — the adapter is additive.

## Next steps

- [telegram.md](./telegram.md) — the bot side, including the alert flow that powers Slack today
- [install.md](./install.md) — get the MCP and bot running first
- [safety.md](./safety.md) — same safety promises apply to Slack alerts
