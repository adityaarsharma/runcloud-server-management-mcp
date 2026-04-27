/**
 * cron.ts — WP-Cron diagnostics + permalink rewrite-rule flush
 *
 * Combines two small but commonly-asked operations:
 *   - Inspect WP-Cron events: stuck/overdue, missing standard hooks
 *   - Flush rewrite rules (the "Settings → Permalinks → Save" equivalent)
 *
 * WP-CLI used:  wp cron event list  /  wp cron event run
 *               wp rewrite flush  /  wp rewrite list
 */

import { SSHOptions, wpCli } from '../../core/ssh-enhanced.js';

export interface CronEvent {
  hook: string;
  nextRun: string;        // ISO
  schedule: string;       // 'hourly' | 'twicedaily' | 'daily' | recurrence | 'one-time'
  overdueSeconds: number; // negative if scheduled in future
}

export interface CronAuditResult {
  totalEvents: number;
  overdueEvents: CronEvent[];
  missingStandardHooks: string[];   // ['wp_version_check', ...]
  doingCronStuck: boolean;          // _transient_doing_cron lingering > 60s
  recommendations: string[];
}

export interface CronRunResult {
  ran: number;
  outputs: Array<{ hook: string; status: string }>;
}

export interface RewriteFlushResult {
  hardFlush: boolean;
  rulesCountBefore: number;
  rulesCountAfter: number;
  output: string;
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

const STANDARD_HOOKS = [
  'wp_version_check',
  'wp_update_plugins',
  'wp_update_themes',
  'wp_scheduled_delete',
  'wp_scheduled_auto_draft_delete',
];

export async function auditCron(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<CronAuditResult> {
  safe(wpPath);
  const r = await wpCli(
    sshOpts, wpPath, wpUser,
    `cron event list --format=json 2>/dev/null`,
  );
  let events: Array<Record<string, string>> = [];
  try { events = JSON.parse(r.stdout); } catch { /* leave empty */ }

  const now = Math.floor(Date.now() / 1000);
  const overdueEvents: CronEvent[] = [];
  const seenHooks = new Set<string>();
  for (const e of events) {
    seenHooks.add(e.hook);
    const nextTs = parseInt(e.next_run_relative ?? e.next_run ?? '0', 10);
    // wp cron event list gives next_run_relative like "5 minutes ago" — JSON
    // gives next_run as unix ts. Use the unix ts.
    const tsField = parseInt(e.next_run_gmt ?? e.next_run ?? '0', 10);
    const overdue = tsField > 0 ? now - tsField : 0;
    if (overdue > 300) {
      overdueEvents.push({
        hook: e.hook,
        nextRun: e.next_run_gmt ? new Date(parseInt(e.next_run_gmt, 10) * 1000).toISOString() : '',
        schedule: e.schedule || 'one-time',
        overdueSeconds: overdue,
      });
    }
  }
  const missingStandardHooks = STANDARD_HOOKS.filter(h => !seenHooks.has(h));

  // doing_cron transient: if set & old, cron is wedged
  const dc = await wpCli(
    sshOpts, wpPath, wpUser,
    `transient get doing_cron 2>/dev/null`,
  );
  const dcVal = parseFloat(dc.stdout.trim());
  const doingCronStuck = Number.isFinite(dcVal) && dcVal > 0 && (now - dcVal) > 60;

  const recommendations: string[] = [];
  if (overdueEvents.length > 0) {
    recommendations.push(
      `${overdueEvents.length} overdue cron event(s). Run wp.cron_run to dispatch them, OR install a real cron via 'crontab -e' to bypass WP-Cron entirely.`,
    );
  }
  if (missingStandardHooks.length > 0) {
    recommendations.push(
      `Missing standard hooks: ${missingStandardHooks.join(', ')}. WordPress will normally re-schedule on next admin visit; if persistent, a plugin may be unschedulling them.`,
    );
  }
  if (doingCronStuck) {
    recommendations.push(
      `_transient_doing_cron is set and stale — clear via 'wp transient delete doing_cron' to unwedge cron.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('WP-Cron is healthy.');
  }

  return {
    totalEvents: events.length,
    overdueEvents,
    missingStandardHooks,
    doingCronStuck,
    recommendations,
  };
}

export async function runCronEvents(
  sshOpts: SSHOptions, wpPath: string, wpUser: string, dueOnly = true,
): Promise<CronRunResult> {
  safe(wpPath);
  const r = await wpCli(
    { ...sshOpts, timeoutMs: 300_000 }, wpPath, wpUser,
    `cron event run ${dueOnly ? '--due-now' : '--all'} 2>&1`,
  );
  const outputs: Array<{ hook: string; status: string }> = [];
  for (const line of r.stdout.split('\n')) {
    const ok = line.match(/Executed the cron event '([^']+)'/);
    if (ok) outputs.push({ hook: ok[1], status: 'ok' });
    const fail = line.match(/Could not execute the cron event '([^']+)'/);
    if (fail) outputs.push({ hook: fail[1], status: 'failed' });
  }
  return { ran: outputs.length, outputs };
}

export async function flushRewrites(
  sshOpts: SSHOptions, wpPath: string, wpUser: string, hardFlush = false,
): Promise<RewriteFlushResult> {
  safe(wpPath);
  const before = await wpCli(sshOpts, wpPath, wpUser, `rewrite list --format=count 2>/dev/null`);
  const out = await wpCli(
    { ...sshOpts, timeoutMs: 60_000 }, wpPath, wpUser,
    `rewrite flush ${hardFlush ? '--hard' : ''} 2>&1`,
  );
  const after = await wpCli(sshOpts, wpPath, wpUser, `rewrite list --format=count 2>/dev/null`);
  return {
    hardFlush,
    rulesCountBefore: parseInt(before.stdout.trim(), 10) || 0,
    rulesCountAfter: parseInt(after.stdout.trim(), 10) || 0,
    output: out.stdout.slice(0, 500),
  };
}
