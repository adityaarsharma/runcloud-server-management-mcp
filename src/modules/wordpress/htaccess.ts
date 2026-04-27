/**
 * htaccess.ts — Validate WordPress .htaccess (Apache + LiteSpeed installs)
 *
 * Only relevant when the webapp uses Apache or NGINX-fronting-Apache /
 * LiteSpeed. Checks for the canonical WP block, presence of stale rules,
 * dangerous directives, and broken redirects.
 */

import { SSHOptions, sshExec } from '../../core/ssh-enhanced.js';

export interface HtaccessFinding {
  severity: 'info' | 'warning' | 'critical';
  message: string;
  line?: number;
}

export interface HtaccessAuditResult {
  exists: boolean;
  sizeBytes: number;
  hasWpBlock: boolean;
  findings: HtaccessFinding[];
  recommendations: string[];
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

const DANGEROUS = [
  /Options\s+\+ExecCGI/i,
  /Options\s+\+Indexes/i,
  /AddType\s+application\/x-httpd-php\s+\.(jpg|png|gif)/i,
  /SetHandler\s+application\/x-httpd-php/i,
  /Header\s+set\s+Content-Security-Policy\s+["']unsafe-eval/i,
];

export async function auditHtaccess(
  sshOpts: SSHOptions, wpPath: string,
): Promise<HtaccessAuditResult> {
  safe(wpPath);
  const path = `${wpPath}/.htaccess`;

  const stat = await sshExec(sshOpts, `stat -c '%s' ${path} 2>/dev/null || echo MISSING`);
  if (stat.stdout.trim() === 'MISSING') {
    return {
      exists: false, sizeBytes: 0, hasWpBlock: false, findings: [],
      recommendations: [
        '.htaccess not present. If your stack is pure NGINX (RunCloud default), this is normal — WP rewrite rules live in the NGINX config. If your stack is Apache or LiteSpeed, generate via Settings → Permalinks → Save.',
      ],
    };
  }
  const sizeBytes = parseInt(stat.stdout.trim(), 10) || 0;

  const content = await sshExec(sshOpts, `cat ${path} 2>/dev/null`);
  const text = content.stdout;
  const findings: HtaccessFinding[] = [];

  const hasWpBlock = /# BEGIN WordPress[\s\S]+# END WordPress/.test(text);
  if (!hasWpBlock) {
    findings.push({
      severity: 'warning',
      message: 'Canonical "# BEGIN WordPress … # END WordPress" block missing. Visit Settings → Permalinks → Save to regenerate.',
    });
  }

  // Detect dangerous directives
  text.split('\n').forEach((line, idx) => {
    for (const pat of DANGEROUS) {
      if (pat.test(line)) {
        findings.push({
          severity: 'critical',
          line: idx + 1,
          message: `Dangerous directive: ${line.trim()}`,
        });
      }
    }
    // Common typos
    if (/RewirteRule|RewirteCond/i.test(line)) {
      findings.push({
        severity: 'warning',
        line: idx + 1,
        message: `Typo: "${line.trim()}" — should be RewriteRule / RewriteCond`,
      });
    }
  });

  // Stale plugin blocks: many cache plugins leave behind blocks even after uninstall
  const STALE_BLOCKS = ['# BEGIN WP Rocket', '# BEGIN W3TC', '# BEGIN LSCACHE', '# BEGIN WPSuperCache', '# BEGIN Wordfence'];
  for (const marker of STALE_BLOCKS) {
    if (text.includes(marker)) {
      // Cross-check: is the matching plugin still in wp-content/plugins?
      const slug = marker.replace('# BEGIN ', '').toLowerCase().replace(/\s+/g, '-');
      const r = await sshExec(sshOpts, `ls -d ${wpPath}/wp-content/plugins/*${slug}* 2>/dev/null | head -1`);
      if (!r.stdout.trim()) {
        findings.push({
          severity: 'warning',
          message: `Block "${marker}" present but matching plugin folder not found — likely stale, safe to remove manually.`,
        });
      }
    }
  }

  const recommendations: string[] = [];
  const criticals = findings.filter(f => f.severity === 'critical');
  if (criticals.length > 0) {
    recommendations.push(
      `${criticals.length} critical finding(s) — review and remove dangerous directives manually before next deploy.`,
    );
  } else if (findings.length === 0) {
    recommendations.push('.htaccess looks clean.');
  }

  return { exists: true, sizeBytes, hasWpBlock, findings, recommendations };
}
