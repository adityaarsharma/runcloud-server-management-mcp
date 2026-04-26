/**
 * perf.ts — WordPress Performance Snapshot
 *
 * Captures a point-in-time snapshot of PHP version, memory, caching,
 * WP-Cron health, TTFB, DB connectivity, and plugin count status.
 */

import { SSHOptions, wpCli, sshExec, httpGet } from '../../core/ssh-enhanced.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export type ObjectCacheType = 'redis' | 'memcached' | 'none';
export type PageCacheType = 'nginx-fastcgi' | 'litespeed' | 'wp-rocket' | 'w3tc' | 'none';
export type PhpVersionStatus = 'current' | 'supported' | 'eol';
export type PluginCountStatus = 'ok' | 'warning' | 'critical';

export interface PerfSnapshotResult {
  phpVersion: string;
  phpVersionStatus: PhpVersionStatus;
  memoryLimit: string;
  memoryUsagePct: number;
  objectCacheConnected: boolean;
  objectCacheType: ObjectCacheType;
  pageCacheActive: boolean;
  pageCacheType: PageCacheType;
  wpCronHealthy: boolean;
  wpCronBacklogCount: number;
  ttfbMs: number | null;
  dbConnectionOk: boolean;
  activePluginCount: number;
  pluginCountStatus: PluginCountStatus;
  recommendations: string[];
}

// ─── PHP version classification ───────────────────────────────────────────────

function classifyPhpVersion(version: string): PhpVersionStatus {
  const m = version.match(/^(\d+)\.(\d+)/);
  if (!m) return 'eol';
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);

  if (major === 8 && minor >= 3) return 'current';
  if (major === 8 && minor >= 1) return 'supported';
  return 'eol';
}

function classifyPluginCount(count: number): PluginCountStatus {
  if (count <= 20) return 'ok';
  if (count <= 30) return 'warning';
  return 'critical';
}

// ─── Memory usage ─────────────────────────────────────────────────────────────

function parseMemoryLimit(limitStr: string): number {
  const m = limitStr.trim().match(/^(\d+)([MG]?)$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = m[2].toUpperCase();
  if (unit === 'G') return n * 1024;
  return n; // MB
}

// ─── Object cache detection ───────────────────────────────────────────────────

async function detectObjectCache(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string
): Promise<{ connected: boolean; type: ObjectCacheType }> {
  // Check for redis object cache drop-in
  const redisDropinRes = await sshExec(
    sshOpts,
    `test -f ${wpPath}/wp-content/object-cache.php && ` +
    `grep -qi 'redis' ${wpPath}/wp-content/object-cache.php 2>/dev/null && echo yes || echo no`
  );

  if (redisDropinRes.stdout.trim() === 'yes') {
    // Verify actual connection
    const pingRes = await wpCli(
      sshOpts, wpPath, wpUser,
      `eval "global \\$wp_object_cache; echo (method_exists(\\$wp_object_cache, 'redis_status') && \\$wp_object_cache->redis_status()) ? 'connected' : 'disconnected';"`
    );
    const connected = pingRes.stdout.includes('connected');
    return { connected, type: 'redis' };
  }

  // Check for memcached drop-in
  const memDropinRes = await sshExec(
    sshOpts,
    `test -f ${wpPath}/wp-content/object-cache.php && ` +
    `grep -qi 'memcach' ${wpPath}/wp-content/object-cache.php 2>/dev/null && echo yes || echo no`
  );

  if (memDropinRes.stdout.trim() === 'yes') {
    return { connected: true, type: 'memcached' }; // Assume connected if drop-in exists
  }

  return { connected: false, type: 'none' };
}

// ─── Page cache detection ─────────────────────────────────────────────────────

async function detectPageCache(
  sshOpts: SSHOptions,
  wpPath: string
): Promise<{ active: boolean; type: PageCacheType }> {
  // Check nginx fastcgi cache config
  const nginxRes = await sshExec(
    sshOpts,
    `grep -r 'fastcgi_cache' /etc/nginx/ 2>/dev/null | head -3`
  );
  if (nginxRes.code === 0 && nginxRes.stdout.trim()) {
    return { active: true, type: 'nginx-fastcgi' };
  }

  // Check for WP Rocket
  const rocketRes = await sshExec(
    sshOpts,
    `test -d ${wpPath}/wp-content/plugins/wp-rocket && echo yes || echo no`
  );
  if (rocketRes.stdout.trim() === 'yes') {
    // Verify it's active
    const cacheDir = await sshExec(sshOpts, `ls ${wpPath}/wp-content/cache/wp-rocket 2>/dev/null | head -1`);
    return { active: cacheDir.code === 0, type: 'wp-rocket' };
  }

  // Check for W3 Total Cache
  const w3tcRes = await sshExec(
    sshOpts,
    `test -d ${wpPath}/wp-content/plugins/w3-total-cache && echo yes || echo no`
  );
  if (w3tcRes.stdout.trim() === 'yes') {
    return { active: true, type: 'w3tc' };
  }

  // Check for LiteSpeed Cache
  const lscacheRes = await sshExec(
    sshOpts,
    `test -d ${wpPath}/wp-content/plugins/litespeed-cache && echo yes || echo no`
  );
  if (lscacheRes.stdout.trim() === 'yes') {
    return { active: true, type: 'litespeed' };
  }

  return { active: false, type: 'none' };
}

// ─── WP-Cron health ──────────────────────────────────────────────────────────

async function checkWpCron(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string
): Promise<{ healthy: boolean; backlogCount: number }> {
  const cronRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `cron event list --format=json`
  );

  if (cronRes.code !== 0) {
    return { healthy: false, backlogCount: 0 };
  }

  try {
    const events = JSON.parse(cronRes.stdout) as Array<{ timestamp: number }>;
    const now = Math.floor(Date.now() / 1000);
    // Count events that are overdue by more than 15 minutes
    const backlog = events.filter(e => e.timestamp < now - 900).length;
    return { healthy: backlog < 5, backlogCount: backlog };
  } catch {
    return { healthy: false, backlogCount: 0 };
  }
}

// ─── TTFB via localhost curl ───────────────────────────────────────────────────

async function measureTtfb(
  sshOpts: SSHOptions,
  domain: string
): Promise<number | null> {
  const res = await sshExec(
    sshOpts,
    `curl -o /dev/null -s -w "%{time_starttransfer}" http://localhost/ -H "Host: ${domain}" --max-time 10 2>/dev/null`
  );
  if (res.code !== 0) {
    // Fallback: try the domain directly
    const fallback = await httpGet(`https://${domain}/`);
    return fallback.status > 0 ? null : null;
  }
  const ttfbSeconds = parseFloat(res.stdout.trim());
  if (!Number.isFinite(ttfbSeconds)) return null;
  return Math.round(ttfbSeconds * 1000);
}

// ─── Main snapshot ────────────────────────────────────────────────────────────

export async function snapshotPerformance(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string,
  domain: string
): Promise<PerfSnapshotResult> {
  const recommendations: string[] = [];

  // Run independent checks concurrently
  const [
    phpVersionRes,
    memLimitRes,
    memUsageRes,
    objectCache,
    pageCache,
    cronHealth,
    ttfbMs,
    dbCheckRes,
    pluginCountRes,
  ] = await Promise.all([
    wpCli(sshOpts, wpPath, wpUser, `eval "echo phpversion();"`),
    wpCli(sshOpts, wpPath, wpUser, `eval "echo ini_get('memory_limit');"`),
    wpCli(sshOpts, wpPath, wpUser, `eval "echo round(memory_get_usage(true) / 1024 / 1024, 1);"`),
    detectObjectCache(sshOpts, wpPath, wpUser),
    detectPageCache(sshOpts, wpPath),
    checkWpCron(sshOpts, wpPath, wpUser),
    measureTtfb(sshOpts, domain),
    wpCli(sshOpts, wpPath, wpUser, `db check 2>&1 | tail -5`),
    wpCli(sshOpts, wpPath, wpUser, `plugin list --status=active --format=count`),
  ]);

  const phpVersion = phpVersionRes.stdout.trim() || 'unknown';
  const phpVersionStatus = classifyPhpVersion(phpVersion);

  const memoryLimit = memLimitRes.stdout.trim() || 'unknown';
  const memLimitMb = parseMemoryLimit(memoryLimit);
  const memUsageMb = parseFloat(memUsageRes.stdout.trim()) || 0;
  const memoryUsagePct = memLimitMb > 0 ? Math.round((memUsageMb / memLimitMb) * 100) : 0;

  const dbConnectionOk = dbCheckRes.code === 0 &&
    !dbCheckRes.stdout.toLowerCase().includes('error');

  const activePluginCount = parseInt(pluginCountRes.stdout.trim(), 10) || 0;
  const pluginCountStatus = classifyPluginCount(activePluginCount);

  // Build recommendations
  if (phpVersionStatus === 'eol') {
    recommendations.push(`PHP ${phpVersion} is end-of-life — upgrade to PHP 8.2+ immediately for security.`);
  } else if (phpVersionStatus === 'supported') {
    recommendations.push(`PHP ${phpVersion} is supported but PHP 8.3 is current — consider upgrading.`);
  }

  if (memoryUsagePct > 80) {
    recommendations.push(`Memory usage at ${memoryUsagePct}% of ${memoryLimit} limit — increase memory_limit or optimize plugins.`);
  }

  if (!objectCache.connected) {
    recommendations.push('No object cache connected — install Redis and WP Redis plugin for significant performance gains.');
  }

  if (!pageCache.active) {
    recommendations.push('No page cache detected — enable Nginx FastCGI cache or WP Rocket to reduce TTFB.');
  }

  if (!cronHealth.healthy) {
    recommendations.push(`WP-Cron backlog: ${cronHealth.backlogCount} overdue event(s) — check scheduled task runner or enable real cron.`);
  }

  if (ttfbMs !== null && ttfbMs > 800) {
    recommendations.push(`TTFB is ${ttfbMs}ms — above 800ms threshold. Investigate slow queries or enable page caching.`);
  }

  if (!dbConnectionOk) {
    recommendations.push('Database check returned errors — inspect wp db check output immediately.');
  }

  if (pluginCountStatus === 'critical') {
    recommendations.push(`${activePluginCount} active plugins is high (>30) — audit and remove unnecessary plugins.`);
  } else if (pluginCountStatus === 'warning') {
    recommendations.push(`${activePluginCount} active plugins — consider reducing below 20 for best performance.`);
  }

  return {
    phpVersion,
    phpVersionStatus,
    memoryLimit,
    memoryUsagePct,
    objectCacheConnected: objectCache.connected,
    objectCacheType: objectCache.type,
    pageCacheActive: pageCache.active,
    pageCacheType: pageCache.type,
    wpCronHealthy: cronHealth.healthy,
    wpCronBacklogCount: cronHealth.backlogCount,
    ttfbMs,
    dbConnectionOk,
    activePluginCount,
    pluginCountStatus,
    recommendations,
  };
}
