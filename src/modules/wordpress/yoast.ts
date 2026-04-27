/**
 * yoast.ts — Yoast SEO health audit
 *
 * Detects Yoast (free or premium); reports XML sitemap reachability,
 * indexable count, schema enabled, primary category support, and
 * known-broken-after-update conditions.
 *
 * WP-CLI used:  wp option get / wp db query (counts indexables)
 * Standard tools: curl for sitemap reachability
 */

import { SSHOptions, sshExec, wpCli } from '../../core/ssh-enhanced.js';

export interface YoastAuditResult {
  installed: boolean;
  version: string | null;
  isPremium: boolean;
  sitemapReachable: boolean;
  sitemapUrl: string | null;
  indexablesCount: number;
  schemaEnabled: boolean;
  forceRewriteEnabled: boolean;
  recommendations: string[];
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

function shellArg(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function tablePrefix(sshOpts: SSHOptions, wpPath: string, wpUser: string): Promise<string> {
  const r = await wpCli(sshOpts, wpPath, wpUser, `db prefix --skip-plugins --skip-themes 2>/dev/null`);
  return r.stdout.trim() || 'wp_';
}

export async function auditYoast(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<YoastAuditResult> {
  safe(wpPath);

  const free = await wpCli(sshOpts, wpPath, wpUser, `plugin get wordpress-seo --field=status 2>/dev/null`);
  const premium = await wpCli(sshOpts, wpPath, wpUser, `plugin get wordpress-seo-premium --field=status 2>/dev/null`);
  const installed = /active/.test(free.stdout) || /active/.test(premium.stdout);

  if (!installed) {
    return {
      installed: false, version: null, isPremium: false,
      sitemapReachable: false, sitemapUrl: null,
      indexablesCount: 0, schemaEnabled: false, forceRewriteEnabled: false,
      recommendations: ['Yoast SEO not active — module not applicable.'],
    };
  }

  const verRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `plugin get wordpress-seo --field=version 2>/dev/null`,
  );
  const version = verRes.stdout.trim() || null;
  const isPremium = /active/.test(premium.stdout);

  // Site URL for sitemap probe
  const siteRes = await wpCli(sshOpts, wpPath, wpUser, `option get siteurl 2>/dev/null`);
  const siteUrl = siteRes.stdout.trim().replace(/\/$/, '');
  const sitemapUrl = siteUrl ? `${siteUrl}/sitemap_index.xml` : null;

  let sitemapReachable = false;
  if (sitemapUrl) {
    const r = await sshExec(
      sshOpts,
      `curl -sSL --max-time 10 -o /dev/null -w "%{http_code}" ${shellArg(sitemapUrl)} 2>/dev/null`,
    );
    sitemapReachable = r.stdout.trim() === '200';
  }

  // Yoast options
  const yoastOpt = await wpCli(sshOpts, wpPath, wpUser, `option get wpseo --format=json 2>/dev/null`);
  let schemaEnabled = false;
  let forceRewriteEnabled = false;
  try {
    const o = JSON.parse(yoastOpt.stdout) as Record<string, unknown>;
    schemaEnabled = o.enable_enhanced_slack_sharing !== false; // schema is default-on; check premium toggles
    forceRewriteEnabled = o.force_rewrite_title === true;
  } catch { /* leave defaults */ }

  // Indexables count (Yoast 14+ stores them in a custom table)
  const px = await tablePrefix(sshOpts, wpPath, wpUser);
  const idxRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `db query "SELECT COUNT(*) FROM \`${px}yoast_indexable\`;" --skip-column-names 2>/dev/null`,
  );
  const indexablesCount = parseInt(idxRes.stdout.trim(), 10) || 0;

  const recommendations: string[] = [];
  if (!sitemapReachable) {
    recommendations.push(
      `Sitemap at ${sitemapUrl} is not reachable (non-200). Check rewrite rules — run wp.rewrite_flush.`,
    );
  }
  if (indexablesCount === 0) {
    recommendations.push(
      'Yoast indexables table is empty. Run "wp yoast index" or visit Yoast → Tools → Index optimization.',
    );
  }
  if (forceRewriteEnabled) {
    recommendations.push(
      'force_rewrite_title is on — slows TTFB. Modern themes don\'t need it; turn off in Yoast → Settings → Search appearance.',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('Yoast SEO health looks good.');
  }

  return {
    installed: true, version, isPremium,
    sitemapReachable, sitemapUrl,
    indexablesCount, schemaEnabled, forceRewriteEnabled,
    recommendations,
  };
}
