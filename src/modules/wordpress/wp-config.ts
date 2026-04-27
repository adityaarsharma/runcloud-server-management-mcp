/**
 * wp-config.ts — Audit `wp-config.php` for sane production settings
 *
 * Doesn't write — emits a checklist with actual values + recommended values.
 * Common gotchas (all real-world signals):
 *   - WP_DEBUG / WP_DEBUG_DISPLAY left on in prod
 *   - DISALLOW_FILE_EDIT not set (admin → plugin/theme code editor)
 *   - WP_MEMORY_LIMIT too low or too high
 *   - WP_AUTO_UPDATE_CORE values
 *   - Salts not rotated since install
 *   - DB_CHARSET set to deprecated 'utf8' instead of 'utf8mb4'
 */

import { SSHOptions, sshExec } from '../../core/ssh-enhanced.js';

export interface WpConfigCheck {
  id: string;
  label: string;
  current: string | null;
  recommended: string;
  passed: boolean;
  severity: 'info' | 'warning' | 'critical';
  detail: string;
}

export interface WpConfigAuditResult {
  configPath: string;
  permissions: string;
  checks: WpConfigCheck[];
  saltsLikelyRotated: boolean;
  recommendations: string[];
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

function extractDefine(text: string, name: string): string | null {
  // Matches: define( 'NAME', value );  or  define("NAME", value);
  const re = new RegExp(`define\\(\\s*['"]${name}['"]\\s*,\\s*([^)]+?)\\s*\\)\\s*;`, 'i');
  const m = text.match(re);
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

export async function auditWpConfig(
  sshOpts: SSHOptions, wpPath: string,
): Promise<WpConfigAuditResult> {
  safe(wpPath);
  const path = `${wpPath}/wp-config.php`;

  // Permissions
  const stat = await sshExec(sshOpts, `stat -c '%a' ${path} 2>/dev/null || echo MISSING`);
  const perms = stat.stdout.trim();
  if (perms === 'MISSING') {
    throw new Error(`wp-config.php not found at ${path}`);
  }

  const cat = await sshExec(sshOpts, `cat ${path} 2>/dev/null`);
  const text = cat.stdout;

  const checks: WpConfigCheck[] = [];

  // WP_DEBUG
  const wpDebug = extractDefine(text, 'WP_DEBUG');
  checks.push({
    id: 'wp_debug', label: 'WP_DEBUG',
    current: wpDebug, recommended: 'false',
    passed: wpDebug === 'false' || wpDebug === null,
    severity: wpDebug === 'true' ? 'critical' : 'info',
    detail: wpDebug === 'true'
      ? 'WP_DEBUG is true in production — exposes errors to visitors and search engines.'
      : 'WP_DEBUG is off (or unset).',
  });

  const wpDebugDisplay = extractDefine(text, 'WP_DEBUG_DISPLAY');
  checks.push({
    id: 'wp_debug_display', label: 'WP_DEBUG_DISPLAY',
    current: wpDebugDisplay, recommended: 'false',
    passed: wpDebugDisplay === 'false',
    severity: 'warning',
    detail: 'When WP_DEBUG is on, set WP_DEBUG_DISPLAY=false + WP_DEBUG_LOG=true so errors go to a log file, not the page.',
  });

  // DISALLOW_FILE_EDIT
  const fileEdit = extractDefine(text, 'DISALLOW_FILE_EDIT');
  checks.push({
    id: 'disallow_file_edit', label: 'DISALLOW_FILE_EDIT',
    current: fileEdit, recommended: 'true',
    passed: fileEdit === 'true',
    severity: 'warning',
    detail: 'Disables the in-admin plugin/theme code editor — common privilege-escalation vector.',
  });

  // WP_MEMORY_LIMIT
  const memLimit = extractDefine(text, 'WP_MEMORY_LIMIT');
  const memOk = memLimit && /^['"]?\d+M['"]?$/i.test(memLimit) &&
    parseInt(memLimit.replace(/[^\d]/g, ''), 10) >= 256;
  checks.push({
    id: 'wp_memory_limit', label: 'WP_MEMORY_LIMIT',
    current: memLimit, recommended: '256M (or higher for WooCommerce)',
    passed: !!memOk,
    severity: 'warning',
    detail: memOk
      ? 'Memory limit looks adequate.'
      : 'Set WP_MEMORY_LIMIT to at least 256M for modern themes/plugins.',
  });

  // DB_CHARSET
  const charset = extractDefine(text, 'DB_CHARSET');
  checks.push({
    id: 'db_charset', label: 'DB_CHARSET',
    current: charset, recommended: 'utf8mb4',
    passed: charset === 'utf8mb4',
    severity: charset === 'utf8' ? 'warning' : 'info',
    detail: charset === 'utf8'
      ? 'Using deprecated utf8 (no full Unicode emoji support). Migrate to utf8mb4.'
      : 'utf8mb4 is correct.',
  });

  // WP_AUTO_UPDATE_CORE
  const autoCore = extractDefine(text, 'WP_AUTO_UPDATE_CORE');
  checks.push({
    id: 'auto_update_core', label: 'WP_AUTO_UPDATE_CORE',
    current: autoCore, recommended: "'minor' (default) or 'true' to also auto-update major",
    passed: autoCore === null || ['true', 'minor', 'false'].includes(autoCore),
    severity: autoCore === 'false' ? 'warning' : 'info',
    detail: autoCore === 'false'
      ? 'Auto-updates fully disabled — security patches must be manually applied.'
      : 'Auto-update setting looks reasonable.',
  });

  // ALLOW_UNFILTERED_UPLOADS — should NEVER be true in prod
  const unfiltered = extractDefine(text, 'ALLOW_UNFILTERED_UPLOADS');
  checks.push({
    id: 'allow_unfiltered_uploads', label: 'ALLOW_UNFILTERED_UPLOADS',
    current: unfiltered, recommended: 'unset / false',
    passed: unfiltered !== 'true',
    severity: unfiltered === 'true' ? 'critical' : 'info',
    detail: unfiltered === 'true'
      ? 'CRITICAL: lets admins upload arbitrary file types including PHP. Remove unless you have a specific need.'
      : 'Default safe behavior in effect.',
  });

  // Salt rotation heuristic — count distinct salts; if any look like the WP
  // default placeholder ("put your unique phrase here"), fail.
  const saltsLikelyRotated = !/put your unique phrase here/i.test(text);
  if (!saltsLikelyRotated) {
    checks.push({
      id: 'salts', label: 'AUTH/SECURE_AUTH/LOGGED_IN/NONCE keys',
      current: 'placeholder', recommended: 'rotated',
      passed: false, severity: 'critical',
      detail: 'wp-config.php still contains the "put your unique phrase here" placeholder — rotate via https://api.wordpress.org/secret-key/1.1/salt/',
    });
  }

  // Permissions check
  const permsOk = ['400', '440', '600', '640'].includes(perms);
  if (!permsOk) {
    checks.push({
      id: 'perms', label: 'wp-config.php permissions',
      current: perms, recommended: '600 or 640',
      passed: false, severity: 'critical',
      detail: `Permissions ${perms} are too permissive. Run: chmod 640 ${path}`,
    });
  }

  const recommendations: string[] = [];
  const fails = checks.filter(c => !c.passed);
  for (const c of fails) {
    recommendations.push(`[${c.severity}] ${c.label}: ${c.detail}`);
  }
  if (recommendations.length === 0) {
    recommendations.push('wp-config.php passes all checks.');
  }

  return {
    configPath: path,
    permissions: perms,
    checks,
    saltsLikelyRotated,
    recommendations,
  };
}
