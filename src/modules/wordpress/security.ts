/**
 * security.ts — WordPress Security Hardening Checklist
 *
 * Runs 12 checks covering file permissions, admin accounts, exposed
 * endpoints, SSL, and WordPress core integrity. Produces a scored report.
 */

import { SSHOptions, wpCli, sshExec, httpGet } from '../../core/ssh-enhanced.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface SecurityCheck {
  id: string;
  label: string;
  passed: boolean;
  severity: 'info' | 'warning' | 'critical';
  detail: string;
  fix?: string;
}

export interface SecurityAuditResult {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  critical: SecurityCheck[];
  warnings: SecurityCheck[];
  passed: SecurityCheck[];
  recommendations: string[];
}

// ─── Score → Grade ────────────────────────────────────────────────────────────

function scoreToGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 45) return 'D';
  return 'F';
}

// ─── Individual checks ────────────────────────────────────────────────────────

async function checkWpConfigPermissions(
  sshOpts: SSHOptions,
  wpPath: string
): Promise<SecurityCheck> {
  const id = 'wp-config-permissions';
  const label = 'wp-config.php file permissions';

  try {
    const res = await sshExec(sshOpts, `stat -c '%a' ${wpPath}/wp-config.php 2>/dev/null`);
    const perms = res.stdout.trim();
    const permNum = parseInt(perms, 8);
    // 600 (owner rw) or 640 (owner rw, group r) are acceptable
    const passed = perms === '600' || perms === '640' || perms === '400';
    return {
      id, label, passed, severity: 'critical',
      detail: passed
        ? `wp-config.php permissions are ${perms} — correct.`
        : `wp-config.php permissions are ${perms || 'unknown'} — should be 600 or 640.`,
      fix: passed ? undefined : `chmod 640 ${wpPath}/wp-config.php`,
    };
  } catch {
    return {
      id, label, passed: false, severity: 'critical',
      detail: 'Could not read wp-config.php permissions.',
    };
  }
}

async function checkAdminUsername(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string
): Promise<SecurityCheck> {
  const id = 'no-admin-username';
  const label = 'Admin username is not "admin"';

  const res = await wpCli(
    sshOpts, wpPath, wpUser,
    `user list --role=administrator --field=user_login --format=csv`
  );

  const logins = res.stdout.split('\n').map(l => l.trim()).filter(Boolean);
  const hasAdmin = logins.some(l => l.toLowerCase() === 'admin');

  return {
    id, label, passed: !hasAdmin, severity: 'critical',
    detail: hasAdmin
      ? 'An administrator account with username "admin" exists — easy brute-force target.'
      : `Administrator logins: ${logins.join(', ') || 'none found'}`,
    fix: hasAdmin
      ? 'wp user update <admin-id> --user_login=<new-username>'
      : undefined,
  };
}

async function checkXmlRpc(domain: string): Promise<SecurityCheck> {
  const id = 'xmlrpc-disabled';
  const label = 'xmlrpc.php is not publicly accessible';

  const res = await httpGet(`https://${domain}/xmlrpc.php`);
  // xmlrpc.php returns 200/405 when accessible; 403/404 means blocked
  const accessible = res.status === 200 || res.status === 405;

  return {
    id, label, passed: !accessible, severity: 'warning',
    detail: accessible
      ? `xmlrpc.php is publicly accessible (HTTP ${res.status}) — enables brute-force amplification.`
      : `xmlrpc.php is blocked (HTTP ${res.status}).`,
    fix: accessible
      ? 'Add "location = /xmlrpc.php { deny all; }" to your Nginx config.'
      : undefined,
  };
}

async function checkDirectoryListing(domain: string): Promise<SecurityCheck> {
  const id = 'directory-listing-disabled';
  const label = 'Directory listing disabled for wp-content/';

  const res = await httpGet(`https://${domain}/wp-content/`);
  const listingEnabled = res.ok && (
    res.body.toLowerCase().includes('index of') ||
    res.body.toLowerCase().includes('parent directory')
  );

  return {
    id, label, passed: !listingEnabled, severity: 'warning',
    detail: listingEnabled
      ? 'Directory listing is enabled for wp-content/ — exposes file structure.'
      : 'Directory listing is disabled.',
    fix: listingEnabled
      ? 'Add "autoindex off;" to the Nginx server block.'
      : undefined,
  };
}

async function checkLoginRateLimit(
  sshOpts: SSHOptions,
  domain: string
): Promise<SecurityCheck> {
  const id = 'login-rate-limited';
  const label = 'wp-login.php rate limiting configured';

  // Check nginx configs for rate limiting on wp-login.php
  const res = await sshExec(
    sshOpts,
    `grep -r 'wp-login' /etc/nginx/ 2>/dev/null | grep -i 'limit_req' | head -5`
  );

  const hasLimit = res.code === 0 && res.stdout.trim().length > 0;

  return {
    id, label, passed: hasLimit, severity: 'warning',
    detail: hasLimit
      ? 'Rate limiting found for wp-login.php in Nginx config.'
      : 'No rate limiting found for wp-login.php — vulnerable to brute-force attacks.',
    fix: hasLimit
      ? undefined
      : 'Add "limit_req zone=one burst=5;" to the wp-login.php Nginx location block.',
  };
}

async function checkDebugLog(domain: string): Promise<SecurityCheck> {
  const id = 'debug-log-private';
  const label = 'debug.log is not publicly accessible';

  const res = await httpGet(`https://${domain}/wp-content/debug.log`);
  const accessible = res.status === 200 && res.body.length > 0;

  return {
    id, label, passed: !accessible, severity: 'critical',
    detail: accessible
      ? 'debug.log is publicly readable — exposes server paths and error details.'
      : 'debug.log is not publicly accessible.',
    fix: accessible
      ? 'Add "location ~* /debug\\.log$ { deny all; }" to Nginx config.'
      : undefined,
  };
}

async function checkFileEditor(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string
): Promise<SecurityCheck> {
  const id = 'file-editor-disabled';
  const label = 'WordPress file editor is disabled';

  const res = await wpCli(
    sshOpts, wpPath, wpUser,
    `eval "echo (defined('DISALLOW_FILE_EDIT') && DISALLOW_FILE_EDIT) ? 'disabled' : 'enabled';"`
  );

  const editorEnabled = res.stdout.trim() === 'enabled';

  return {
    id, label, passed: !editorEnabled, severity: 'warning',
    detail: editorEnabled
      ? 'WordPress file editor is enabled — allows code editing via admin panel if compromised.'
      : 'WordPress file editor is disabled (DISALLOW_FILE_EDIT = true).',
    fix: editorEnabled
      ? "Add \"define('DISALLOW_FILE_EDIT', true);\" to wp-config.php"
      : undefined,
  };
}

async function checkWpVersionExposure(domain: string): Promise<SecurityCheck> {
  const id = 'wp-version-hidden';
  const label = 'WordPress version not exposed in HTTP headers/meta';

  const res = await httpGet(`https://${domain}/`);
  const versionInBody = /generator.*wordpress\s+[\d.]+/i.test(res.body);
  const exposed = versionInBody;

  return {
    id, label, passed: !exposed, severity: 'info',
    detail: exposed
      ? 'WordPress version is exposed in the page source meta generator tag.'
      : 'WordPress version is not visible in page source.',
    fix: exposed
      ? "Add remove_action('wp_head', 'wp_generator'); to functions.php or use a security plugin."
      : undefined,
  };
}

async function checkReadmeHtml(
  sshOpts: SSHOptions,
  wpPath: string
): Promise<SecurityCheck> {
  const id = 'readme-removed';
  const label = 'readme.html removed from WordPress root';

  const res = await sshExec(
    sshOpts,
    `test -f ${wpPath}/readme.html && echo exists || echo missing`
  );
  const exists = res.stdout.trim() === 'exists';

  return {
    id, label, passed: !exists, severity: 'info',
    detail: exists
      ? 'readme.html exists — reveals WordPress version number to scanners.'
      : 'readme.html not present.',
    fix: exists ? `rm ${wpPath}/readme.html` : undefined,
  };
}

async function checkUploadsPhpExecution(
  sshOpts: SSHOptions
): Promise<SecurityCheck> {
  const id = 'uploads-no-php';
  const label = 'PHP execution blocked in wp-content/uploads/';

  const res = await sshExec(
    sshOpts,
    `grep -r 'uploads' /etc/nginx/ 2>/dev/null | grep -i '\\.php' | head -5`
  );

  const hasBlock = res.code === 0 && res.stdout.trim().length > 0 &&
    res.stdout.toLowerCase().includes('deny');

  return {
    id, label, passed: hasBlock, severity: 'critical',
    detail: hasBlock
      ? 'Nginx config blocks PHP execution in uploads directory.'
      : 'No PHP execution block found for wp-content/uploads/ — allows malicious file execution.',
    fix: hasBlock
      ? undefined
      : 'Add "location ~* /wp-content/uploads/.*\\.php$ { deny all; }" to Nginx config.',
  };
}

async function checkSslValid(domain: string): Promise<SecurityCheck> {
  const id = 'ssl-valid';
  const label = 'SSL certificate is valid';

  const res = await httpGet(`https://${domain}/`);
  const sslOk = res.status > 0 && res.status !== 0;

  return {
    id, label, passed: sslOk, severity: 'critical',
    detail: sslOk
      ? 'SSL certificate is valid and HTTPS is reachable.'
      : 'HTTPS connection failed — SSL certificate may be invalid or expired.',
    fix: sslOk ? undefined : 'Renew or reinstall the SSL certificate via RunCloud SSL manager.',
  };
}

async function checkCoreChecksums(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string
): Promise<SecurityCheck> {
  const id = 'core-checksums';
  const label = 'WordPress core files pass checksum verification';

  const res = await wpCli(
    sshOpts, wpPath, wpUser,
    `core verify-checksums`
  );

  const passed = res.code === 0 && !res.stdout.toLowerCase().includes('error');

  return {
    id, label, passed, severity: 'critical',
    detail: passed
      ? 'All WordPress core files match official checksums.'
      : `Core checksum mismatch detected: ${res.stdout.slice(0, 300)}`,
    fix: passed
      ? undefined
      : 'Run "wp core download --force" to restore modified core files.',
  };
}

// ─── Main audit ───────────────────────────────────────────────────────────────

export async function auditSecurity(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string,
  domain: string
): Promise<SecurityAuditResult> {
  // Run all checks concurrently where safe
  const [
    configPerms,
    adminUser,
    xmlRpc,
    dirListing,
    loginRateLimit,
    debugLog,
    fileEditor,
    versionExposure,
    readmeHtml,
    uploadsPhp,
    ssl,
    coreChecksums,
  ] = await Promise.all([
    checkWpConfigPermissions(sshOpts, wpPath),
    checkAdminUsername(sshOpts, wpPath, wpUser),
    checkXmlRpc(domain),
    checkDirectoryListing(domain),
    checkLoginRateLimit(sshOpts, domain),
    checkDebugLog(domain),
    checkFileEditor(sshOpts, wpPath, wpUser),
    checkWpVersionExposure(domain),
    checkReadmeHtml(sshOpts, wpPath),
    checkUploadsPhpExecution(sshOpts),
    checkSslValid(domain),
    checkCoreChecksums(sshOpts, wpPath, wpUser),
  ]);

  const allChecks: SecurityCheck[] = [
    configPerms, adminUser, xmlRpc, dirListing, loginRateLimit,
    debugLog, fileEditor, versionExposure, readmeHtml, uploadsPhp,
    ssl, coreChecksums,
  ];

  const critical = allChecks.filter(c => !c.passed && c.severity === 'critical');
  const warnings = allChecks.filter(c => !c.passed && c.severity === 'warning');
  const passed = allChecks.filter(c => c.passed);

  // Score: start at 100, deduct by severity
  let score = 100;
  score -= critical.length * 15;
  score -= warnings.length * 7;
  score = Math.max(0, score);

  const recommendations: string[] = [
    ...critical.map(c => `[CRITICAL] ${c.label}: ${c.fix ?? c.detail}`),
    ...warnings.map(c => `[WARNING] ${c.label}: ${c.fix ?? c.detail}`),
  ];

  return {
    score,
    grade: scoreToGrade(score),
    critical,
    warnings,
    passed,
    recommendations,
  };
}
