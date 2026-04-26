/**
 * plugins.ts — WordPress Plugin Audit + Vulnerability Check
 *
 * Lists all plugins, checks for updates, detects abandoned plugins,
 * and cross-references with the Wordfence Intelligence API for CVEs.
 */

import { SSHOptions, wpCli } from '../../core/ssh-enhanced.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface PluginInfo {
  slug: string;
  name: string;
  version: string;
  status: 'active' | 'inactive';
  updateAvailable: boolean;
  latestVersion?: string;
  lastUpdated?: string;
}

export interface VulnerabilityInfo {
  slug: string;
  currentVersion: string;
  cve: string;
  cvss: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  fixedInVersion: string;
  source: 'wordfence' | 'wpscan';
}

export interface PluginAuditResult {
  total: number;
  active: number;
  inactive: number;
  needsUpdate: number;
  /** Last updated > 2 years ago */
  abandoned: number;
  vulnerable: VulnerabilityInfo[];
  pluginList: PluginInfo[];
  recommendations: string[];
}

export interface UpdatePluginResult {
  success: boolean;
  oldVersion: string;
  newVersion: string;
  output: string;
}

export interface DeactivatePluginResult {
  success: boolean;
  output: string;
}

// ─── In-memory vulnerability cache (slug@version → entries + timestamp) ──────

interface CacheEntry {
  ts: number;
  vulns: VulnerabilityInfo[];
}

const vulnCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function cacheKey(slug: string, version: string): string {
  return `${slug}@${version}`;
}

function getCached(slug: string, version: string): VulnerabilityInfo[] | null {
  const entry = vulnCache.get(cacheKey(slug, version));
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    vulnCache.delete(cacheKey(slug, version));
    return null;
  }
  return entry.vulns;
}

function setCache(slug: string, version: string, vulns: VulnerabilityInfo[]): void {
  vulnCache.set(cacheKey(slug, version), { ts: Date.now(), vulns });
}

// ─── Wordfence Intelligence API (free, no key required) ──────────────────────

const WORDFENCE_API_BASE = 'https://www.wordfence.com/api/1.0.5/vulnerabilities/plugin';

interface WorkfenceVuln {
  id?: string;
  cve?: string;
  cvss?: { score?: number };
  cvss_score?: number;
  title?: string;
  description?: string;
  fixed_in?: string;
}

function cvssToSeverity(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'high';
  if (score >= 4.0) return 'medium';
  return 'low';
}

/** Returns true if currentVersion < fixedIn (i.e., still affected) */
function isVersionAffected(currentVersion: string, fixedIn: string | undefined): boolean {
  if (!fixedIn) return true; // no known fix → assume affected
  const toSegments = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
  const cur = toSegments(currentVersion);
  const fix = toSegments(fixedIn);
  for (let i = 0; i < Math.max(cur.length, fix.length); i++) {
    const c = cur[i] ?? 0;
    const f = fix[i] ?? 0;
    if (c < f) return true;
    if (c > f) return false;
  }
  return false; // equal → not affected
}

async function fetchVulnsForSlug(
  slug: string,
  currentVersion: string
): Promise<VulnerabilityInfo[]> {
  const cached = getCached(slug, currentVersion);
  if (cached !== null) return cached;

  try {
    const res = await fetch(`${WORDFENCE_API_BASE}/${encodeURIComponent(slug)}`, {
      headers: { 'User-Agent': 'Perch-Audit/1.0' },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      setCache(slug, currentVersion, []);
      return [];
    }

    const data = await res.json() as Record<string, WorkfenceVuln>;
    const vulns: VulnerabilityInfo[] = [];

    for (const entry of Object.values(data)) {
      const cvss = entry.cvss?.score ?? entry.cvss_score ?? 0;
      const fixedIn = entry.fixed_in ?? undefined;

      if (!isVersionAffected(currentVersion, fixedIn)) continue;

      vulns.push({
        slug,
        currentVersion,
        cve: entry.cve ?? entry.id ?? 'N/A',
        cvss,
        severity: cvssToSeverity(cvss),
        description: entry.title ?? entry.description ?? 'No description available',
        fixedInVersion: fixedIn ?? 'No fix available',
        source: 'wordfence',
      });
    }

    setCache(slug, currentVersion, vulns);
    return vulns;
  } catch {
    setCache(slug, currentVersion, []);
    return [];
  }
}

// ─── Parse WP-CLI plugin list CSV output ──────────────────────────────────────

function parsePluginListCsv(raw: string): PluginInfo[] {
  const plugins: PluginInfo[] = [];
  const lines = raw.split('\n').filter(Boolean);

  for (const line of lines.slice(1)) { // skip CSV header
    // CSV: name,slug,status,version,update,update_version
    const parts = line.split(',').map(p => p.trim());
    if (parts.length < 4) continue;

    const name = parts[0] ?? '';
    const slug = parts[1] ?? '';
    const status = parts[2] ?? '';
    const version = parts[3] ?? '';
    const update = parts[4] ?? '';
    const latestVersion = parts[5] ?? undefined;

    if (!slug) continue;

    plugins.push({
      slug,
      name,
      version,
      status: status === 'active' ? 'active' : 'inactive',
      updateAvailable: update === 'available',
      latestVersion: latestVersion || undefined,
    });
  }

  return plugins;
}

function isAbandoned(plugin: PluginInfo): boolean {
  if (!plugin.lastUpdated) return false;
  const updated = new Date(plugin.lastUpdated);
  if (isNaN(updated.getTime())) return false;
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  return updated < twoYearsAgo;
}

// ─── Main audit ───────────────────────────────────────────────────────────────

export async function auditPlugins(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string,
  _wordfenceApiKey?: string // reserved for future paid-tier support
): Promise<PluginAuditResult> {
  const recommendations: string[] = [];

  const listRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `plugin list --fields=name,slug,status,version,update,update_version --format=csv`
  );

  if (listRes.code !== 0 && !listRes.stdout) {
    return {
      total: 0, active: 0, inactive: 0, needsUpdate: 0, abandoned: 0,
      vulnerable: [], pluginList: [],
      recommendations: [
        `WP-CLI plugin list failed: ${listRes.stderr.slice(0, 300)}`,
      ],
    };
  }

  const pluginList = parsePluginListCsv(listRes.stdout);

  const active = pluginList.filter(p => p.status === 'active').length;
  const inactive = pluginList.filter(p => p.status === 'inactive').length;
  const needsUpdate = pluginList.filter(p => p.updateAvailable).length;
  const abandoned = pluginList.filter(isAbandoned).length;

  // Vulnerability scan — batch active plugins in groups of 10 with 100ms spacing
  const activeSlugs = pluginList.filter(p => p.status === 'active');
  const vulnerable: VulnerabilityInfo[] = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < activeSlugs.length; i += BATCH_SIZE) {
    const batch = activeSlugs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(p => fetchVulnsForSlug(p.slug, p.version))
    );
    for (const vulns of results) {
      vulnerable.push(...vulns);
    }
    if (i + BATCH_SIZE < activeSlugs.length) {
      await new Promise<void>(r => setTimeout(r, 100));
    }
  }

  // Recommendations
  if (needsUpdate > 0) {
    recommendations.push(
      `${needsUpdate} plugin(s) have updates available — update to patch security issues and bugs.`
    );
  }
  if (inactive > 5) {
    recommendations.push(
      `${inactive} inactive plugins found — remove unused plugins to reduce attack surface.`
    );
  }
  if (abandoned > 0) {
    recommendations.push(
      `${abandoned} plugin(s) not updated in 2+ years — evaluate replacements.`
    );
  }
  const criticalHighVulns = vulnerable.filter(v => v.severity === 'critical' || v.severity === 'high');
  if (criticalHighVulns.length > 0) {
    const affectedSlugs = [...new Set(criticalHighVulns.map(v => v.slug))].join(', ');
    recommendations.push(
      `CRITICAL: ${criticalHighVulns.length} high/critical vulnerability(ies) detected. Affected: ${affectedSlugs}`
    );
  }

  return {
    total: pluginList.length,
    active,
    inactive,
    needsUpdate,
    abandoned,
    vulnerable,
    pluginList,
    recommendations,
  };
}

// ─── Action functions ─────────────────────────────────────────────────────────

export async function updatePlugin(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string,
  slug: string
): Promise<UpdatePluginResult> {
  const oldInfoRes = await wpCli(sshOpts, wpPath, wpUser, `plugin get ${slug} --field=version`);
  const oldVersion = oldInfoRes.stdout.trim();

  const updateRes = await wpCli(sshOpts, wpPath, wpUser, `plugin update ${slug}`);

  const newInfoRes = await wpCli(sshOpts, wpPath, wpUser, `plugin get ${slug} --field=version`);
  const newVersion = newInfoRes.stdout.trim();

  return {
    success: updateRes.code === 0,
    oldVersion,
    newVersion,
    output: [updateRes.stdout, updateRes.stderr].filter(Boolean).join('\n').trim(),
  };
}

export async function deactivatePlugin(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string,
  slug: string
): Promise<DeactivatePluginResult> {
  const res = await wpCli(sshOpts, wpPath, wpUser, `plugin deactivate ${slug}`);
  return {
    success: res.code === 0,
    output: [res.stdout, res.stderr].filter(Boolean).join('\n').trim(),
  };
}
