/**
 * caching.ts — Object cache + page cache audit (deeper than perf.ts)
 *
 * perf.ts gives a binary "cache active / not active". This module reports
 * hit rate, key count, memory usage (Redis), and detects misconfigurations
 * (object-cache.php drop-in pointing at a dead Redis socket, page-cache
 * plugin installed but not generating files, etc.).
 *
 * WP-CLI used:  wp eval (object cache stats)
 * Standard tools: redis-cli info, find on cache directories
 */

import { SSHOptions, sshExec, wpCli } from '../../core/ssh-enhanced.js';

export type ObjectCache = 'redis' | 'memcached' | 'none';
export type PageCache = 'wp-rocket' | 'litespeed' | 'w3-total-cache' | 'wp-super-cache' | 'nginx-fastcgi' | 'cloudflare-page-rules' | 'none';

export interface CachingAuditResult {
  objectCache: {
    type: ObjectCache;
    dropinPresent: boolean;
    connected: boolean;
    redisInfo?: {
      usedMemoryMb: number;
      connectedClients: number;
      hitRate: number;
      keysCount: number;
    };
  };
  pageCache: {
    type: PageCache;
    pluginActive: boolean;
    cachedFiles: number;
    cacheSizeMb: number;
    issues: string[];
  };
  recommendations: string[];
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

async function detectObjectCache(
  sshOpts: SSHOptions, wpPath: string,
): Promise<{ type: ObjectCache; dropinPresent: boolean }> {
  const dropinRes = await sshExec(
    sshOpts,
    `test -f ${wpPath}/wp-content/object-cache.php && cat ${wpPath}/wp-content/object-cache.php | head -50 2>/dev/null`,
  );
  if (!dropinRes.stdout) return { type: 'none', dropinPresent: false };
  if (/redis/i.test(dropinRes.stdout)) return { type: 'redis', dropinPresent: true };
  if (/memcached/i.test(dropinRes.stdout)) return { type: 'memcached', dropinPresent: true };
  return { type: 'none', dropinPresent: true };
}

async function redisInfo(
  sshOpts: SSHOptions,
): Promise<CachingAuditResult['objectCache']['redisInfo'] | null> {
  const r = await sshExec(sshOpts, `redis-cli INFO 2>/dev/null | grep -E "used_memory:|connected_clients:|keyspace_hits:|keyspace_misses:|db0:keys=" | head -10`);
  if (!r.stdout.trim()) return null;
  const map: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^([^:]+):(.*)$/);
    if (m) map[m[1].trim()] = m[2].trim();
  }
  const usedBytes = parseInt(map['used_memory'] ?? '0', 10) || 0;
  const hits = parseInt(map['keyspace_hits'] ?? '0', 10) || 0;
  const misses = parseInt(map['keyspace_misses'] ?? '0', 10) || 0;
  const total = hits + misses;
  const keysMatch = (map['db0'] ?? '').match(/keys=(\d+)/);
  return {
    usedMemoryMb: Math.round((usedBytes / (1024 * 1024)) * 100) / 100,
    connectedClients: parseInt(map['connected_clients'] ?? '0', 10) || 0,
    hitRate: total > 0 ? Math.round((hits / total) * 1000) / 10 : 0,
    keysCount: keysMatch ? parseInt(keysMatch[1], 10) : 0,
  };
}

async function detectPageCache(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<{ type: PageCache; pluginActive: boolean; cachedFiles: number; cacheSizeMb: number; issues: string[] }> {
  const issues: string[] = [];
  const list = await wpCli(sshOpts, wpPath, wpUser, `plugin list --status=active --format=json --fields=name 2>/dev/null`);
  let active: string[] = [];
  try { active = (JSON.parse(list.stdout) as Array<{ name: string }>).map(p => p.name); } catch { /* empty */ }

  const PLUGIN_MAP: Array<{ slug: string; type: PageCache; cacheDir: string }> = [
    { slug: 'wp-rocket', type: 'wp-rocket', cacheDir: 'cache/wp-rocket' },
    { slug: 'litespeed-cache', type: 'litespeed', cacheDir: 'cache/litespeed' },
    { slug: 'w3-total-cache', type: 'w3-total-cache', cacheDir: 'cache' },
    { slug: 'wp-super-cache', type: 'wp-super-cache', cacheDir: 'cache' },
  ];

  let detected: PageCache = 'none';
  let cacheDir = '';
  for (const p of PLUGIN_MAP) {
    if (active.includes(p.slug)) {
      detected = p.type;
      cacheDir = `${wpPath}/wp-content/${p.cacheDir}`;
      break;
    }
  }

  let cachedFiles = 0;
  let cacheSizeMb = 0;
  if (detected !== 'none' && cacheDir) {
    const r = await sshExec(
      sshOpts,
      `find ${cacheDir} -type f -name "*.html" 2>/dev/null | wc -l; du -sb ${cacheDir} 2>/dev/null | cut -f1`,
    );
    const lines = r.stdout.split('\n');
    cachedFiles = parseInt((lines[0] ?? '0').trim(), 10) || 0;
    const bytes = parseInt((lines[1] ?? '0').trim(), 10) || 0;
    cacheSizeMb = Math.round((bytes / (1024 * 1024)) * 100) / 100;
    if (cachedFiles === 0) {
      issues.push(`${detected} plugin is active but no cached HTML files found — pages aren't being cached. Check plugin settings.`);
    }
  }

  return { type: detected, pluginActive: detected !== 'none', cachedFiles, cacheSizeMb, issues };
}

export async function auditCaching(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<CachingAuditResult> {
  safe(wpPath);
  const recommendations: string[] = [];

  const oc = await detectObjectCache(sshOpts, wpPath);
  let connected = false;
  let info: CachingAuditResult['objectCache']['redisInfo'];
  if (oc.type === 'redis') {
    info = await redisInfo(sshOpts) ?? undefined;
    connected = !!info;
  }

  const pc = await detectPageCache(sshOpts, wpPath, wpUser);

  if (oc.type === 'none') {
    recommendations.push(
      'No object cache. Install Redis + a Redis object-cache plugin (Redis Object Cache by Till Krüss). ' +
      'Cuts DB queries 40–80% on busy sites.',
    );
  } else if (oc.dropinPresent && !connected && oc.type === 'redis') {
    recommendations.push(
      'object-cache.php drop-in is in place but Redis is not responding — site is hitting DB on every request, slower than no-cache + drop-in overhead.',
    );
  } else if (info && info.hitRate < 80 && info.keysCount > 1000) {
    recommendations.push(
      `Redis hit rate ${info.hitRate}% is low — investigate cache-buster plugins or insufficient maxmemory.`,
    );
  }

  if (pc.type === 'none') {
    recommendations.push(
      'No page cache plugin active. LiteSpeed Cache (free) or WP Rocket (paid) cuts TTFB dramatically.',
    );
  }
  for (const issue of pc.issues) recommendations.push(issue);
  if (recommendations.length === 0) {
    recommendations.push('Caching layers look healthy.');
  }

  return {
    objectCache: { type: oc.type, dropinPresent: oc.dropinPresent, connected, redisInfo: info },
    pageCache: pc,
    recommendations,
  };
}
