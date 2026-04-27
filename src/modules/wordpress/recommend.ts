/**
 * recommend.ts — Brain-integrated aggregator
 *
 * Runs every read-only audit in parallel, collates findings, scores them
 * by impact, and emits a prioritized action plan. Logs each finding to
 * the per-host SQLite brain (via core/brain.ts) so future runs can see
 * recurring issues and Perch can learn what fixes worked.
 *
 * This is the "intelligence" layer that makes Perch more than a
 * collection of scripts — it joins the dots across modules.
 */

import { SSHOptions } from '../../core/ssh-enhanced.js';
import type { default as Database } from 'better-sqlite3';
import { logProblem } from '../../core/brain.js';
import { auditDisk } from './disk.js';
import { scanMalware } from './malware.js';
import { auditThumbnails } from './thumbnails.js';
import { auditUnusedPlugins } from './plugins-cleanup.js';
import { auditMediaOrphans } from './media-orphans.js';
import { auditRevisions } from './revisions.js';
import { auditTranslations } from './translations.js';
import { auditHtaccess } from './htaccess.js';
import { getCoreStatus } from './core.js';
import { auditCron } from './cron.js';
import { auditWpConfig } from './wp-config.js';
import { auditCaching } from './caching.js';
import { auditWooCommerce } from './woocommerce.js';
import { auditYoast } from './yoast.js';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface RecommendedAction {
  module: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Estimated impact in MB freed / ms saved / risk delta (free-form). */
  impact: string;
  /** The Perch tool name to call. Caller will need to pass appropriate args. */
  suggestedTool: string | null;
}

export interface RecommendResult {
  ranTimestamp: string;
  modulesRun: string[];
  modulesSkipped: Array<{ module: string; reason: string }>;
  topActions: RecommendedAction[];      // sorted by severity desc, then impact
  diskUsedPercent: number;
  malwareRisk: Severity;
  performanceScore: number | null;      // 0-100 if Lighthouse data available
  brainProblemsLogged: number;
  summary: string;
}

interface ModulePromise<T> {
  module: string;
  promise: Promise<T>;
}

function severityRank(s: Severity): number {
  return ({ low: 0, medium: 1, high: 2, critical: 3 })[s];
}

export interface RecommendOptions {
  wpPath: string;
  wpUser: string;
  /** When provided, recommendations also get logged to brain.db */
  brain?: Database.Database;
  /** Server identity for brain logs */
  serverId?: number;
  webappId?: number;
}

export async function buildRecommendations(
  sshOpts: SSHOptions, opts: RecommendOptions,
): Promise<RecommendResult> {
  const { wpPath, wpUser, brain, serverId, webappId } = opts;
  const ranTimestamp = new Date().toISOString();
  const modulesRun: string[] = [];
  const modulesSkipped: Array<{ module: string; reason: string }> = [];
  const actions: RecommendedAction[] = [];

  // Run every read-only module in parallel; tolerate per-module failure
  const tasks = [
    safeRun('disk', auditDisk(sshOpts, wpPath)),
    safeRun('malware', scanMalware(sshOpts, wpPath, wpUser)),
    safeRun('thumbnails', auditThumbnails(sshOpts, wpPath, wpUser)),
    safeRun('plugins_cleanup', auditUnusedPlugins(sshOpts, wpPath, wpUser)),
    safeRun('media_orphans', auditMediaOrphans(sshOpts, wpPath, wpUser, 100)),
    safeRun('revisions', auditRevisions(sshOpts, wpPath, wpUser)),
    safeRun('translations', auditTranslations(sshOpts, wpPath, wpUser)),
    safeRun('htaccess', auditHtaccess(sshOpts, wpPath)),
    safeRun('core_status', getCoreStatus(sshOpts, wpPath, wpUser)),
    safeRun('cron', auditCron(sshOpts, wpPath, wpUser)),
    safeRun('wp_config', auditWpConfig(sshOpts, wpPath)),
    safeRun('caching', auditCaching(sshOpts, wpPath, wpUser)),
    safeRun('woocommerce', auditWooCommerce(sshOpts, wpPath, wpUser)),
    safeRun('yoast', auditYoast(sshOpts, wpPath, wpUser)),
  ];

  const results = await Promise.all(tasks);

  let diskUsedPercent = 0;
  let malwareRisk: Severity = 'low';

  for (const { module, ok, value, error } of results) {
    if (!ok) {
      modulesSkipped.push({ module, reason: error?.message ?? 'unknown error' });
      continue;
    }
    modulesRun.push(module);

    // Per-module → action extraction
    switch (module) {
      case 'disk': {
        const r = value as Awaited<ReturnType<typeof auditDisk>>;
        diskUsedPercent = r.diskUsedPercent;
        if (r.diskUsedPercent >= 90) {
          actions.push({
            module, severity: 'critical',
            title: `Disk ${r.diskUsedPercent}% full`,
            detail: `Free space below safe threshold. Largest contributor: ${r.imageFormats[0]?.ext ?? 'images'} (${(r.imageFormats[0]?.sizeMb ?? 0).toFixed(0)} MB).`,
            impact: `Could free ~${Math.round(r.totals.uploadsMb * 0.5)} MB via image compression`,
            suggestedTool: 'wp.images_compress_bulk_start',
          });
        }
        for (const rec of r.recommendations) {
          actions.push({
            module, severity: 'medium',
            title: 'Disk audit recommendation',
            detail: rec,
            impact: '—',
            suggestedTool: null,
          });
        }
        break;
      }
      case 'malware': {
        const r = value as Awaited<ReturnType<typeof scanMalware>>;
        malwareRisk = r.riskLevel;
        if (r.riskLevel === 'critical' || r.riskLevel === 'high') {
          actions.push({
            module, severity: r.riskLevel,
            title: `Malware risk: ${r.riskLevel} (score ${r.riskScore})`,
            detail: r.recommendations.slice(0, 2).join(' '),
            impact: 'Security',
            suggestedTool: 'wp.scan_malware',
          });
        }
        break;
      }
      case 'plugins_cleanup': {
        const r = value as Awaited<ReturnType<typeof auditUnusedPlugins>>;
        if (r.candidates.length > 0) {
          actions.push({
            module, severity: 'medium',
            title: `${r.candidates.length} plugin(s) safe to remove`,
            detail: `Reclaim ~${r.totalReclaimableMb.toFixed(0)} MB. Top: ${r.candidates.slice(0, 3).map(c => c.slug).join(', ')}.`,
            impact: `${r.totalReclaimableMb.toFixed(0)} MB freed`,
            suggestedTool: 'wp.plugins_cleanup_apply',
          });
        }
        break;
      }
      case 'core_status': {
        const r = value as Awaited<ReturnType<typeof getCoreStatus>>;
        if (r.updateAvailable) {
          actions.push({
            module, severity: r.updateType === 'major' ? 'high' : 'medium',
            title: `WordPress ${r.latestVersion} update available`,
            detail: `Currently ${r.currentVersion}. ${r.updateType} update.`,
            impact: 'Security + features',
            suggestedTool: 'wp.core_update',
          });
        }
        if (r.checksumMismatches > 0) {
          actions.push({
            module, severity: 'critical',
            title: `${r.checksumMismatches} core file(s) failed checksum`,
            detail: 'Likely tampering or partial update — re-download core via "wp core download --force".',
            impact: 'Integrity risk',
            suggestedTool: 'wp.scan_malware',
          });
        }
        break;
      }
      case 'wp_config': {
        const r = value as Awaited<ReturnType<typeof auditWpConfig>>;
        for (const c of r.checks.filter(c => !c.passed && c.severity === 'critical')) {
          actions.push({
            module, severity: 'critical',
            title: `wp-config: ${c.label}`,
            detail: c.detail,
            impact: 'Security',
            suggestedTool: null,
          });
        }
        break;
      }
      case 'caching': {
        const r = value as Awaited<ReturnType<typeof auditCaching>>;
        if (r.objectCache.type === 'none') {
          actions.push({
            module, severity: 'medium',
            title: 'No object cache configured',
            detail: 'Install Redis + Redis Object Cache plugin. Cuts DB queries 40–80% on busy sites.',
            impact: 'Performance',
            suggestedTool: null,
          });
        }
        if (r.pageCache.type === 'none') {
          actions.push({
            module, severity: 'medium',
            title: 'No page cache plugin active',
            detail: 'LiteSpeed Cache (free) or WP Rocket cuts TTFB dramatically.',
            impact: 'Performance',
            suggestedTool: null,
          });
        }
        break;
      }
      case 'thumbnails': {
        const r = value as Awaited<ReturnType<typeof auditThumbnails>>;
        if (r.unusedDiskMb > 50) {
          actions.push({
            module, severity: 'medium',
            title: `${r.unusedDiskMb.toFixed(0)} MB in unused thumbnail variants`,
            detail: 'Some registered image sizes have no theme/plugin/post references.',
            impact: `${r.unusedDiskMb.toFixed(0)} MB freed`,
            suggestedTool: 'wp.thumbnails_clean',
          });
        }
        break;
      }
      case 'revisions': {
        const r = value as Awaited<ReturnType<typeof auditRevisions>>;
        if (r.postRevisions > 1000) {
          actions.push({
            module, severity: 'low',
            title: `${r.postRevisions} post revisions consuming ~${r.oversizedRevisionsKb} KB`,
            detail: 'Keep last 5 per post via wp.revisions_clean.',
            impact: `~${(r.oversizedRevisionsKb / 1024).toFixed(1)} MB freed`,
            suggestedTool: 'wp.revisions_clean',
          });
        }
        break;
      }
      case 'cron': {
        const r = value as Awaited<ReturnType<typeof auditCron>>;
        if (r.doingCronStuck) {
          actions.push({
            module, severity: 'high',
            title: 'WP-Cron is wedged',
            detail: 'doing_cron transient is stale — cron events not firing. Clear with `wp transient delete doing_cron`.',
            impact: 'Background jobs not running',
            suggestedTool: 'wp.cron_run',
          });
        }
        break;
      }
    }
  }

  // Log to brain (best-effort)
  let brainProblemsLogged = 0;
  if (brain) {
    for (const a of actions.filter(a => a.severity === 'critical' || a.severity === 'high')) {
      try {
        logProblem(brain, {
          server_id: serverId, webapp_id: webappId,
          type: a.module,
          root_cause: a.title,
          raw_log_snippet: a.detail.slice(0, 1000),
        });
        brainProblemsLogged++;
      } catch { /* don't fail recommend on brain write errors */ }
    }
  }

  // Sort: severity desc, then alpha
  actions.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.title.localeCompare(b.title));

  const criticalCount = actions.filter(a => a.severity === 'critical').length;
  const highCount = actions.filter(a => a.severity === 'high').length;
  const summary =
    `${actions.length} action(s): ${criticalCount} critical, ${highCount} high. ` +
    `Disk ${diskUsedPercent}%. Malware risk: ${malwareRisk}. ` +
    `Modules run: ${modulesRun.length}/${modulesRun.length + modulesSkipped.length}.`;

  return {
    ranTimestamp,
    modulesRun,
    modulesSkipped,
    topActions: actions.slice(0, 20),
    diskUsedPercent,
    malwareRisk,
    performanceScore: null,
    brainProblemsLogged,
    summary,
  };
}

// ─── Local helpers ──────────────────────────────────────────────────────────

interface SafeRunResult<T> { module: string; ok: boolean; value: T | null; error: Error | null; }

async function safeRun<T>(module: string, p: Promise<T>): Promise<SafeRunResult<T>> {
  try {
    const value = await p;
    return { module, ok: true, value, error: null };
  } catch (e) {
    return { module, ok: false, value: null, error: e as Error };
  }
}
