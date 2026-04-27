# Perch — Monitor

The eyes of Perch. A first-class sub-layer of [Connectors → Surface A](./connectors.md).

Last revised: 2026-04-27 (Perch v2.4 design lock).
Sister docs: [`architecture.md`](./architecture.md) · [`connectors.md`](./connectors.md) · [`brain.md`](./brain.md) · [`guardrails.md`](./guardrails.md)

---

## Why Monitor is its own layer

Monitor is **the part of Perch that grows fastest.** Every new signal you want to watch, every new threshold, every new third-party event source lands here.

So it gets:
- Its own folder (`src/connectors/monitor/`)
- Its own rules-as-data syntax (backed by `BRAIN.guardrails`)
- Its own evolution path (probes are tiny TS files; community can contribute)
- Its own contract with downstream (single output: `Event`)

Monitor's job is **narrow on purpose**: decide if there is an event worth surfacing. That's it. It does not call LLMs. It does not pick fixes. It does not format messages.

This separation lets Notifier evolve at LLM speed (prompts, providers, channels) while Monitor evolves at sysadmin speed (probes, thresholds, integrations) — without entangling.

---

## The contract

**Input**: external state (HTTP responses, SSH command output, RunCloud API, inbound webhook payloads, brain history).

**Output**: zero or more `Event` objects.

```ts
type Event = {
  id: string;                       // ULID, dedup key root
  host: string;                     // FQDN or BRAIN.webapps key
  type: string;                     // "disk.high", "ssl.expiring", "ports.22.down"
  severity: "info" | "warn" | "critical";
  signal: number | string | object; // raw measurement that tripped the rule
  raw: object;                      // unfiltered probe output (for LLM context)
  context: {                        // brain-enriched context for Notifier
    last_seen?: string;
    streak?: number;
    related_incidents?: string[];
    historical_fix?: string;
  };
  created_at: string;               // ISO8601
};
```

Notifier consumes Events. Nothing else does.

---

## Components

```
src/connectors/monitor/
├── index.ts          ← orchestrator: schedule → probe → grade → emit
├── scheduler.ts      ← cron + jitter + per-probe interval
├── dedup.ts          ← suppress repeats while incident open/snoozed
├── severity.ts       ← probe result + rule → info|warn|critical
├── event.ts          ← Event type + emitter
├── rules/            ← rules-as-data loader (backed by BRAIN.guardrails)
│   ├── thresholds.ts
│   ├── anomalies.ts
│   └── host-overrides.ts
├── probes/           ← grows heavily
│   ├── uptime.ts
│   ├── ports.ts
│   ├── services.ts
│   ├── disk.ts
│   ├── ssl.ts
│   ├── logs.ts
│   └── wp-specific.ts
└── webhooks-in/      ← external probes
    ├── runcloud.ts
    ├── cloudflare.ts
    ├── github.ts
    └── custom.ts
```

### Scheduler
- Cron-style (`*/5 * * * *`) or interval (`every: 5m`)
- Per-probe override (`disk` every 5m, `uptime` every 30s)
- Jittered start (avoids every server hitting RunCloud at :00)
- Skips disabled webapps (per `BRAIN.webapps.enabled`)

### Dedup
- Keyed on `(host, type)`
- Suppresses while an incident is `open` or `snoozed`
- Auto-clears when user taps `Ignore` or the probe stops tripping for N intervals
- Dedup window is severity-aware (critical: 15m default; warn: 1h; info: 6h)

### Severity grader
- Reads probe result + matching rule(s) + recent history
- Outputs `info | warn | critical`
- Critical events bypass dedup-on-snooze (you can't snooze a fire)

---

## Probes

A probe is a small TS file that exports a single function:

```ts
// src/connectors/monitor/probes/disk.ts
export async function probe(ctx: ProbeContext): Promise<ProbeResult> {
  const { host, ssh, brain } = ctx;
  const out = await ssh.run(host, "df -h --output=pcent,target | tail -n +2");
  const lines = parseDf(out);
  const max = Math.max(...lines.map(l => l.pct));
  return {
    type: "disk.high",
    signal: max,
    raw: { lines },
    triggered: max >= 80,            // soft check; rules layer makes final call
  };
}

export const meta = {
  name: "disk",
  interval: "5m",
  reads: ["ssh.df"],                 // for read-only allowlist verification
  needs: ["ssh-enhanced"],
};
```

A probe must:
- Be **read-only** (Monitor never writes — Smart Fix does)
- Return within 30s (probe runner kills slower)
- Use only SSH or API calls already in the read-only allowlist
- Declare its `meta` (name, interval, reads, needs)

### Built-in probes (seed set)

| Probe | What it watches | Default interval |
|---|---|---|
| `uptime` | HTTP status + response time | 30s |
| `ports` | TCP probes for 22/80/443/3306/6379/custom | 1m |
| `services` | nginx · php-fpm · mysql · redis · pm2 · supervisord | 1m |
| `disk` | filesystem % used + growth + top consumers | 5m |
| `ssl` | cert expiry + chain validity | 1h |
| `logs` | nginx 5xx spike, fatal PHP, OOM, segfault | 5m |
| `wp-specific` | slow plugins, Lighthouse drop, malware sigs, orphan media | 1h |

Each is ~50–150 LoC. Adding a new one is the canonical "first contribution" path.

---

## Rules

Rules turn raw probe output into typed Events with a severity. They live as **data, not code**, in `BRAIN.guardrails`.

### Threshold rule

```yaml
- id: disk-high
  probe: disk
  if: { signal: { gte: 85 } }
  emit:
    type: disk.high
    severity: warn

- id: disk-critical
  probe: disk
  if: { signal: { gte: 95 } }
  emit:
    type: disk.critical
    severity: critical
```

### Anomaly rule

```yaml
- id: 5xx-burst
  probe: logs
  if:
    metric: nginx_5xx_per_min
    anomaly: { z_score: { gt: 3 }, window: 1h }
  emit:
    type: logs.5xx_burst
    severity: critical
```

### Host override

```yaml
- id: relax-uptime-on-staging
  match: { host_tag: staging }
  probe: uptime
  if: { signal: { gte: 5000 } }      # 5s vs default 1s for prod
  emit:
    type: uptime.slow
    severity: info
```

Rules are loaded at boot, cached, and reloaded on `BRAIN.guardrails` change. Editing rules is the primary way users tune Perch's noise floor.

---

## Inbound webhooks (external probes)

Monitor exposes endpoints for external systems to push events in. Each handler does only one thing: **normalise the payload into an `Event` and emit it.**

```ts
// src/connectors/monitor/webhooks-in/runcloud.ts
export async function handle(req: Request): Promise<Event[]> {
  verifySignature(req, await brain.secrets.get("runcloud.webhook_secret"));
  const { event_type, server_id, payload } = await req.json();
  const host = await brain.webapps.lookupByRunCloudId(server_id);
  return [{
    id: ulid(),
    host,
    type: `runcloud.${event_type}`,                // e.g. runcloud.backup.failed
    severity: severityFor(event_type),
    signal: payload,
    raw: payload,
    context: await enrich(host, event_type),
    created_at: new Date().toISOString(),
  }];
}
```

Endpoint shape:
```
POST /perch/webhooks/<source>
```

Sources today: `runcloud`, `cloudflare`, `github`, `custom`. Adding a new one is one file in `webhooks-in/`.

---

## How Monitor evolves (the growth plan)

Monitor will be coded **a lot**. The expected growth pattern:

### Wave 1 (now → v2.5)
- Seed probes (uptime / ports / services / disk / ssl / logs / wp-specific)
- Threshold + simple anomaly rules
- Inbound: RunCloud + Cloudflare + GitHub
- Telegram-only output (Notifier handles the channel side)

### Wave 2 (v2.6+)
- WP-specific probe explodes into sub-probes (per major plugin)
- Per-stack probe families: `nodejs/`, `laravel/`, `static/`
- Per-platform probe families: `hetzner/`, `cloudflare/`
- Custom probes via user TS file in `~/.perch/probes/`
- Anomaly detection backed by `BRAIN.timeseries` (rolling z-score, EWMA)

### Wave 3 (v3.x)
- ML-driven baselines per host
- Cross-host correlation ("3 webapps on hetzner-1 just slowed at the same time → likely host-level")
- Predictive probes ("disk will hit 95% in ~6 hours at current growth")
- Community probe marketplace

The **only stable contract** through all waves is the `Event` shape. Everything else can change without touching Notifier or AI.

---

## Adding a new probe (the canonical recipe)

1. Create `src/connectors/monitor/probes/<name>.ts` exporting `probe()` + `meta`.
2. Add a default rule to `src/connectors/monitor/rules/thresholds.ts` (or `anomalies.ts`).
3. Optionally add a Smart Fix action in `src/connectors/notifier/smart-fix/actions/` and register it for the new event type.
4. Add a test fixture in `tests/probes/<name>.test.ts`.
5. Open a PR — that's it.

No core code changes needed. Monitor grows by addition, not modification.

---

## What Monitor must never do

- **Never write.** No mutating SSH commands. No mutating API calls. Reads only.
- **Never call LLMs.** That's Notifier's job. Monitor produces structured Events; Notifier prose-ifies.
- **Never decide policy.** Whether an Event becomes an alert is decided by rules + severity. Whether to auto-fix is decided by Smart Fix. Monitor just emits facts.
- **Never bypass Brain.** Every Event lands in `BRAIN.incidents`. Every probe writes to `BRAIN.timeseries`. No transient-only state.

The narrowness is the point. It's what lets Monitor evolve fearlessly.
