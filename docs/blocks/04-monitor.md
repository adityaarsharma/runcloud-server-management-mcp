# Block 4 — Monitor Module

## Purpose

The 5-minute pager. Runs from cron, evaluates rules against the local server,
fires Telegram + Slack alerts (via Notifier — block 5) with inline
buttons that route back through HTTP API (block 3).

## Files

- `telegram-bot/monitor.sh` — 14 rules, ~530 lines
- `telegram-bot/.env` — bot token, chat_id, NGINX_SVC, RULE_*_THRESHOLD vars
- `/tmp/perch-monitor/` — per-rule cooldown state files
- `/tmp/perch-monitor-muted` — mute toggle (epoch expiry)
- Cron: `*/5 * * * * monitor.sh >> /tmp/perch-monitor.log 2>&1`

## Current state

14 rules:

| # | Rule | Triggers | Buttons |
|---|---|---|---|
| 1 | `rule_nginx` | nginx-rc not active | Restart · Logs · Ack |
| 2 | `rule_php_fpm` | any phpXXrc-fpm down | Restart · Logs · Ack |
| 3 | `rule_database` | mariadb not active | Restart · Status · Ack |
| 4 | `rule_disk` | thresholds 75/85/92% | Clear logs · Show disk · Ack |
| 5 | `rule_ram` | thresholds 85/93% | Smart Fix · Top Procs · Ack |
| 6 | `rule_cpu_load` | sustained 80/95% | Smart Fix · Top Procs · Ack |
| 7 | `rule_orphans` | PPID=1 count > threshold | Smart Fix · Status · Mute · Ack |
| 8 | `rule_failed_services` | systemctl --failed | Status · Ack |
| 9 | `rule_ssl_expiry` | per-site cert days | Renew SSL · SSL Status · Ack |
| 10 | `rule_http_availability` | site 5xx / unreachable | Smart Fix · Status · Ack |
| 11 | `rule_custom_ports` | configured TCP ports | Status · Ack |
| 12 | `rule_fail2ban_spike` | bans > 50/hour | Ack |
| 13 | `rule_load_avg` | 1-min loadavg | Top Procs · Ack |
| 14 | `rule_process_count` | total procs > limit | Top Procs · Ack |

All thresholds overridable in `.env`. Cooldown default 1800s (30 min).

When any rule fires, monitor.sh writes `/tmp/perch_session.json` with
`kind=alert` (24h timeout) so cross-questions in Telegram stay in Perch
context until the user acks.

Slack mirror: if `SLACK_WEBHOOK_URL` is set in `.env`, send_alert posts a
parallel Block Kit JSON to Slack with severity color.

## Gaps (toward vision)

- [ ] Multi-server support (currently single-host) — biggest gap
- [ ] Cron drift detection (heartbeat — if cron itself dies, no alert)
- [ ] Backup-failed / deploy-failed / cron-job-failed rules (vision V1 list
  has these — not built)
- [ ] RunCloud-API verification (currently just systemctl + nginx confs)
- [ ] Per-tenant tagging on alerts (V2)
- [ ] Anomaly detection / trend learning (V2)

## Next ship task

**Add backup-failed + deploy-failed rules**. RunCloud writes backup status to
`/home/runcloud/.runcloud/...` and deploy logs to a known path. Two new
rules in monitor.sh that check those, plus 2 new buttons in Notifier.
~2h. Reuses existing send_alert + button-routing.

## Boundaries

- Monitor reads system state directly (systemctl, ps, df) — that's allowed.
- Monitor only WRITES through HTTP API (block 3) — never edits anything
  outside `/tmp/perch-monitor*`.
- Rule output goes through `formatTelegramAlert` / `formatSlackAlert` from
  `src/core/gateway.ts` — never crafted inline.
