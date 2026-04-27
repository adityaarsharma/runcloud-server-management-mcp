/**
 * multisite.ts — WordPress Multisite enumeration + super-admin audit
 *
 * Detects whether the install is multisite, lists sub-sites, network
 * plugins, super-admins. Single-site installs return a sane no-op result.
 *
 * WP-CLI used:  wp site list  /  wp super-admin list  /  wp plugin list --network
 */

import { SSHOptions, wpCli, sshExec } from '../../core/ssh-enhanced.js';

export interface SubSite {
  blogId: number;
  url: string;
  domain: string;
  registered: string;
  isPublic: boolean;
}

export interface MultisiteAuditResult {
  isMultisite: boolean;
  type: 'subdomain' | 'subdirectory' | 'single' | 'unknown';
  totalSites: number;
  sites: SubSite[];
  superAdmins: string[];
  networkActivePlugins: string[];
  recommendations: string[];
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

export async function auditMultisite(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<MultisiteAuditResult> {
  safe(wpPath);

  // Detect multisite via wp-config constants
  const cfg = await sshExec(sshOpts, `grep -E "MULTISITE|SUBDOMAIN_INSTALL" ${wpPath}/wp-config.php 2>/dev/null`);
  const isMultisite = /define\(\s*['"]MULTISITE['"]\s*,\s*true/i.test(cfg.stdout);
  const isSubdomain = /define\(\s*['"]SUBDOMAIN_INSTALL['"]\s*,\s*true/i.test(cfg.stdout);

  if (!isMultisite) {
    return {
      isMultisite: false, type: 'single', totalSites: 1,
      sites: [], superAdmins: [], networkActivePlugins: [],
      recommendations: ['Single-site install — multisite features not applicable.'],
    };
  }

  const recommendations: string[] = [];

  // List sites
  const sitesRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `site list --format=json --fields=blog_id,url,domain,registered,public 2>/dev/null`,
  );
  let sites: SubSite[] = [];
  try {
    const arr = JSON.parse(sitesRes.stdout);
    sites = arr.map((s: Record<string, unknown>) => ({
      blogId: Number(s.blog_id ?? 0),
      url: String(s.url ?? ''),
      domain: String(s.domain ?? ''),
      registered: String(s.registered ?? ''),
      isPublic: s.public === '1' || s.public === 1 || s.public === true,
    }));
  } catch { /* leave empty */ }

  // Super admins
  const saRes = await wpCli(sshOpts, wpPath, wpUser, `super-admin list --format=json 2>/dev/null`);
  let superAdmins: string[] = [];
  try {
    const arr = JSON.parse(saRes.stdout);
    superAdmins = arr.map((u: Record<string, unknown>) => String(u.user_login ?? '')).filter(Boolean);
  } catch { /* leave empty */ }

  // Network-active plugins
  const npRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `plugin list --network --status=active-network --format=json --fields=name 2>/dev/null`,
  );
  let networkActivePlugins: string[] = [];
  try {
    const arr = JSON.parse(npRes.stdout);
    networkActivePlugins = arr.map((p: Record<string, unknown>) => String(p.name ?? '')).filter(Boolean);
  } catch { /* leave empty */ }

  if (superAdmins.length > 3) {
    recommendations.push(
      `${superAdmins.length} super-admins — review and reduce. Super-admin can install plugins network-wide.`,
    );
  }
  if (sites.length > 100) {
    recommendations.push(
      `${sites.length} sub-sites — consider running per-site audits via wp.audit_disk in batches.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(`Network healthy — ${sites.length} sub-sites, ${superAdmins.length} super-admin(s).`);
  }

  return {
    isMultisite: true,
    type: isSubdomain ? 'subdomain' : 'subdirectory',
    totalSites: sites.length,
    sites, superAdmins, networkActivePlugins,
    recommendations,
  };
}
