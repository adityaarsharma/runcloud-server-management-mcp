# Perch — Monitor

**Layer 3** of the 5-layer stack. The eyes of Perch. Its own beast — different shape, different tempo, different evolution path from the rest.

Last revised: 2026-04-27 (Perch v2.5 design lock).
Sister docs: [`architecture.md`](./architecture.md) · [`connectors.md`](./connectors.md) · [`brain.md`](./brain.md) · [`guardrails.md`](./guardrails.md)

---

## Why Monitor is its own layer

Monitor is **the part of Perch that grows fastest.** Every new signal you want to watch, every new threshold, every new third-party event source lands here.

So it gets its own layer — not buried under Connectors, not buried under Executor:
- Its own folder (`src/monitor/`)
- Its own rules-as-data syntax (backed by `BRAIN.guardrails`)
- Its own evolution path (probes are tiny TS files; community can contribute)
- Its own contract with downstream (single output: `Event`)
- Its own internal tier split: **Watch** (sees) + **Decide** (judges)

Monitor's job is **narrow on purpose**: decide if there is an event worth surfacing, then emit it. That's it. It does not call BYOK LLMs to compose messages (Notifier does that, in Layer 1). It does not pick fixes (Smart Fix runner does that). It does not format messages.

This separation lets the rest of Perch evolve at LLM speed (prompts, channels, providers) while Monitor evolves at sysadmin speed (probes, thresholds, integrations) — without entangling.

---

## Where Monitor sits in the 5-layer stack

```
       (1) CONNECTORS            ← user-facing surfaces
            ↓                      Notifier consumes Monitor's Events
       (2) REASONING             ← user-intent planning
            ↓
       (3) MONITOR               ← THIS DOC · own layer · own folder
            │                      uses Layer 4 read-only modules to see
            │                      emits Events upstream to Layer 1 (Notifier)
            │                      writes timeseries + incidents to Layer 5
            ↓
       (4) EXECUTOR (apps)       ← Stack + Platform modules — Monitor calls
                                   the read-only ones to probe live state
            ↓
       (5) BRAIN                 ← Monitor reads rules, writes timeseries +
                                   incidents
```

Monitor is at position 3 because:
- It **reads from Layer 4** (Executor's read-only modules) to see the world.
- It **emits Events upward** to Layer 1 (Notifier in Connectors) for user-facing dispatch.
- It **reads/writes Layer 5** (BRAIN: rules in `guardrails`, output to `incidents` + `timeseries`).
- It does NOT touch Layer 2 (Reasoning) — Monitor is rule-based, not LLM-planned.

---

## Internal split — two tiers

Monitor itself splits into two cooperating tiers:

| Tier | Owns | Doesn't own |
|---|---|---|
| **Watch** | Probes · scheduler · inbound webhooks · raw measurement collection | Threshold logic · severity · dedup · downstream dispatch |
| **Decide** | Rules-as-data · threshold matching · anomaly detection · severity grading · dedup · Event emission | Probe execution · channel formatting · LLM calls · writes |

```
┌─────────────────────────────────────────────────────────────┐
│  MONITOR  (Layer 3)                                         │
│                                                             │
│   ┌─ WATCH tier ──────────────────────────────────────────┐ │
│   │  Scheduler (cron + jitter + per-probe interval)       │ │
│   │  Probes (uptime, ports, services, disk, ssl, logs,    │ │
│   │           wp-specific, custom user probes)            │ │
│   │  Webhooks-in (RunCloud · Cloudflare · GitHub · custom)│ │
│   │  Output: ProbeResult { type, signal, raw, … }         │ │
│   └────────────────────────────┬──────────────────────────┘ │
│                                ↓                            │
│   ┌─ DECIDE tier ─────────────────────────────────────────┐ │
│   │  Rules loader (from BRAIN.guardrails)                 │ │
│   │  Threshold matcher · anomaly detector                 │ │
│   │  Severity grader (info / warn / critical)             │ │
│   │  Dedup (per host+type, severity-aware window)         │ │
│   │  Output: Event { host, type, severity, signal, ctx }  │ │
│   └────────────────────────────┬──────────────────────────┘ │
│                                ↓                            │
└────────────────────────────────┼────────────────────────────┘
                                 ↓
                  Layer 1 → Connectors → Notifier (compose + dispatch)
```

This split is intentional:
- **Watch** is the part that knows about SSH, RunCloud APIs, log parsing, ports, sockets. Pure I/O.
- **Decide** is the part that knows about rules, thresholds, anomalies, dedup windows. Pure logic.

Watch can be improved by adding probes. Decide can be improved by adding rule types. They evolve independently.

---

## The contract

**Input** (to Watch): external state via Layer 4 read-only modules + inbound webhook payloads.

**Output** (from Decide): zero or more `Event` objects.

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

Notifier (Layer 1, Surface A) consumes Events. Nothing else does.

---

## Components

```
src/monitor/                        ← LAYER 3
├── index.ts                        (orchestrator: schedule → watch → decide → emit)
│
├── watch/                          ← Tier 1: SEE
│   ├── scheduler.ts                (cron + jitter + per-probe interval)
│   ├── runner.ts                   (probe runner; 30s timeout per probe)
│   ├── probes/                     (grows heavily)
│   │   ├── uptime.ts
│   │   ├── ports.ts
│   │   ├── services.ts
│   │   ├── disk.ts
│   │   ├── ssl.ts
│   │   ├── logs.ts
│   │   ├── visits.ts               (web visit anomalies, top IPs)
│   │   ├── ssh-auth.ts             (failed login bursts)
│   │   └── wp-specific.ts
│   └── webhooks-in/                (external probes)
│       ├── runcloud.ts
│       ├── cloudflare.ts
│       ├── github.ts
│       └── custom.ts
│
└── decide/                         ← Tier 2: JUDGE
    ├── rules.ts                    (rules loader from BRAIN.guardrails)
    ├── thresholds.ts               (numeric matchers)
    ├── anomalies.ts                (z-score, EWMA, custom)
    ├── severity.ts                 (probe + rule + history → severity)
    ├── dedup.ts                    (suppress repeats while incident open/snoozed)
    └── event.ts                    (Event type + emitter)
```

### Scheduler (Watch tier)
- Cron-style (`*/5 * * * *`) or interval (`every: 5m`)
- Per-probe override (`disk` every 5m, `uptime` every 30s)
- Jittered start (avoids every server hitting RunCloud at :00)
- Skips disabled webapps (per `BRAIN.webapps.enabled`)

### Dedup (Decide tier)
- Keyed on `(host, type)`
- Suppresses while an incident is `open` or `snoozed`
- Auto-clears when user taps `Ignore` or the probe stops tripping for N intervals
- Window is severity-aware (critical: 15m default; warn: 1h; info: 6h)

### Severity grader (Decide tier)
- Reads probe result + matching rule(s) + recent history
- Outputs `info | warn | critical`
- Critical events bypass dedup-on-snooze (you can't snooze a fire)

---

## Probes (Watch tier)

A probe is a small TS file that exports a single function:

```ts
// src/monitor/watch/probes/disk.ts
export async function probe(ctx: ProbeContext): Promise<ProbeResult> {
  const { host, executor, brain } = ctx;
  // executor is Layer 4's read-only interface — Monitor never gets a write handle
  const out = await executor.read("ssh.df", { host, opts: "-h --output=pcent,target" });
  const lines = parseDf(out);
  const max = Math.max(...lines.map(l => l.pct));
  return {
    type: "disk.high",
    signal: max,
    raw: { lines },
    triggered: max >= 80,            // soft check; Decide tier makes the final call
  };
}

export const meta = {
  name: "disk",
  interval: "5m",
  reads: ["ssh.df"],                 // for read-only allowlist verification
};
```

A probe must:
- Be **read-only** (Monitor never writes — Smart Fix in Layer 1 does, AI Plugin via Layer 4 does)
- Return within 30s (probe runner kills slower)
- Use only Layer 4 modules already in the read-only allowlist
- Declare its `meta` (name, interval, reads)

### Built-in probes (seed set)

| Probe | What it watches | Default interval |
|---|---|---|
| `uptime` | HTTP status + response time | 30s |
| `ports` | TCP probes for 22/80/443/3306/6379/custom | 1m |
| `services` | nginx · php-fpm · mysql · redis · pm2 · supervisord | 1m |
| `disk` | filesystem % used + growth + top consumers | 5m |
| `ssl` | cert expiry + chain validity | 1h |
| `logs` | nginx 5xx spike, fatal PHP, OOM, segfault | 5m |
| `visits` | top IPs, anomalous visit spikes, blocked IPs | 5m |
| `ssh-auth` | failed login bursts, fail2ban triggers | 1m |
| `wp-specific` | slow plugins, Lighthouse drop, malware sigs, orphan media | 1h |

Each is ~50–150 LoC. Adding a new one is the canonical "first contribution" path.

---

## Rules (Decide tier)

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

Rules are loaded at boot, cached, reloaded on `BRAIN.guardrails` change.

---

## Inbound webhooks (Watch tier · external probes)

External systems push events INTO Perch. **They land in Watch**, not Decide directly. The handler does only one thing: **normalise the payload into a `ProbeResult`** that Decide then evaluates.

```ts
// src/monitor/watch/webhooks-in/runcloud.ts
export async function handle(req: Request): Promise<ProbeResult[]> {
  verifySignature(req, await brain.secrets.get("runcloud.webhook_secret"));
  const { event_type, server_id, payload } = await req.json();
  const host = await brain.webapps.lookupByRunCloudId(server_id);
  return [{
    type: `runcloud.${event_type}`,
    signal: payload,
    raw: payload,
    triggered: true,
  }];
}
```

Endpoint shape:
```
POST /perch/webhooks/<source>
```

Sources today: `runcloud`, `cloudflare`, `github`, `custom`. Adding a new one is one file in `watch/webhooks-in/`.

---

## How Monitor evolves (the growth plan)

Monitor will be coded **a lot**. Expected pattern:

### Wave 1 (now → v2.5)
- Seed probes (uptime / ports / services / disk / ssl / logs / visits / ssh-auth / wp-specific)
- Threshold + simple anomaly rules
- Inbound: RunCloud + Cloudflare + GitHub
- Single Event output → Notifier

### Wave 2 (v2.6+)
- WP-specific probe explodes into sub-probes (per major plugin)
- Per-stack probe families: `nodejs/`, `laravel/`, `static/`
- Per-platform probe families: `hetzner/`, `cloudflare/`
- Custom probes via user TS file in `~/.perch/probes/`
- Anomaly detection backed by `BRAIN.timeseries` (rolling z-score, EWMA)

### Wave 3 (v3.x)
- ML-driven baselines per host
- Cross-host correlation
- Predictive probes ("disk will hit 95% in ~6 hours at current growth")
- Community probe marketplace

The **only stable contract** through all waves is the `Event` shape. Everything else can change without touching Connectors, Reasoning, or Executor.

---

## Adding a new probe (the canonical recipe)

1. Create `src/monitor/watch/probes/<name>.ts` exporting `probe()` + `meta`.
2. Add a default rule to `src/monitor/decide/thresholds.ts` (or `anomalies.ts`).
3. Optionally add a Smart Fix action in `src/connectors/notifier/smart-fix/actions/` and register it for the new event type.
4. Add a test fixture in `tests/probes/<name>.test.ts`.
5. Open a PR.

No core code changes needed. Monitor grows by addition, not modification.

---

## What Monitor must never do

- **Never write.** Watch only reads via Layer 4's read-only interface. No mutating SSH commands. No mutating API calls.
- **Never call BYOK LLMs.** That's Notifier's job (Layer 1 Surface A). Monitor produces structured Events; Notifier prose-ifies.
- **Never decide policy.** Whether an Event becomes an alert is decided by rules + severity in Decide. Whether to auto-fix is decided by Smart Fix (Layer 1). Whether to apply a big mutation is decided by Reasoning + Guardrails (Layer 2). Monitor just emits facts.
- **Never bypass Brain.** Every Event lands in `BRAIN.incidents`. Every probe writes to `BRAIN.timeseries`. No transient-only state.

The narrowness is the point. It's what lets Monitor evolve fearlessly.
