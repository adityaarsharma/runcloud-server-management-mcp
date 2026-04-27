/**
 * ssl.ts — TLS certificate, redirect chain, mixed-content audit
 *
 * Uses standard openssl + curl on the remote (no remote DNS quirks). Reports
 * cert subject/issuer/expiry, full redirect chain, HSTS presence, and a
 * sample of mixed-content references on the homepage.
 */

import { SSHOptions, sshExec } from '../../core/ssh-enhanced.js';

export interface SslAuditResult {
  url: string;
  certSubject: string;
  certIssuer: string;
  certNotBefore: string;
  certNotAfter: string;
  certDaysUntilExpiry: number;
  redirectChain: string[];
  finalUrl: string;
  hstsHeader: string | null;
  mixedContentSamples: string[];
  recommendations: string[];
}

function validateUrl(s: string): void {
  if (!/^https?:\/\/[a-zA-Z0-9.-]+/.test(s)) throw new Error('url must start with http:// or https://');
}

function shellArg(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export async function auditSsl(
  sshOpts: SSHOptions, url: string,
): Promise<SslAuditResult> {
  validateUrl(url);
  const recommendations: string[] = [];
  const u = new URL(url);
  const host = u.hostname;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');

  // Cert details (HTTPS only)
  let certSubject = '';
  let certIssuer = '';
  let certNotBefore = '';
  let certNotAfter = '';
  let certDaysUntilExpiry = -1;
  if (u.protocol === 'https:') {
    const r = await sshExec(
      sshOpts,
      `echo | openssl s_client -servername ${host} -connect ${host}:${port} 2>/dev/null | ` +
      `openssl x509 -noout -subject -issuer -dates 2>/dev/null`,
    );
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('subject=')) certSubject = line.slice(8).trim();
      else if (line.startsWith('issuer=')) certIssuer = line.slice(7).trim();
      else if (line.startsWith('notBefore=')) certNotBefore = line.slice(10).trim();
      else if (line.startsWith('notAfter=')) certNotAfter = line.slice(9).trim();
    }
    if (certNotAfter) {
      const ms = Date.parse(certNotAfter);
      if (Number.isFinite(ms)) {
        certDaysUntilExpiry = Math.floor((ms - Date.now()) / 86400_000);
      }
    }
    if (certDaysUntilExpiry >= 0 && certDaysUntilExpiry < 14) {
      recommendations.push(
        `TLS cert expires in ${certDaysUntilExpiry} day(s) — verify auto-renewal (Let's Encrypt / RunCloud SSL) is functional.`,
      );
    }
    if (certDaysUntilExpiry < 0 && certNotAfter) {
      recommendations.push('TLS cert is EXPIRED — site likely returning errors to clients.');
    }
  }

  // Redirect chain
  const redir = await sshExec(
    sshOpts,
    `curl -sSL --max-time 15 -o /dev/null -w "%{url_effective}\\n%{redirect_url}\\n" -D - ${shellArg(url)} 2>/dev/null | head -200`,
  );
  const lines = redir.stdout.split('\n');
  const chain: string[] = [];
  let hsts: string | null = null;
  for (const line of lines) {
    const loc = line.match(/^Location:\s*(.+?)\s*$/i);
    if (loc) chain.push(loc[1]);
    const h = line.match(/^Strict-Transport-Security:\s*(.+?)\s*$/i);
    if (h) hsts = h[1];
  }
  // Last two non-empty lines from -w are url_effective + redirect_url
  const tailLines = lines.filter(Boolean);
  const finalUrl = tailLines[tailLines.length - 2] || url;

  if (!hsts && u.protocol === 'https:') {
    recommendations.push(
      'No Strict-Transport-Security (HSTS) header. Recommended: `Strict-Transport-Security: max-age=31536000; includeSubDomains` (set in nginx/Apache config).',
    );
  }
  if (chain.length > 3) {
    recommendations.push(
      `${chain.length}-hop redirect chain — long chains hurt TTFB and SEO. Collapse to a single 301 from canonical entry to canonical destination.`,
    );
  }

  // Mixed content sample (homepage only)
  const homepage = await sshExec(
    sshOpts,
    `curl -sSL --max-time 15 ${shellArg(url)} 2>/dev/null | ` +
    `grep -oE "(src|href)=['\\"]http://[^'\\" ]+" | head -20`,
  );
  const mixedContentSamples = homepage.stdout
    .split('\n').filter(Boolean)
    .map(s => s.replace(/^[a-z]+=["']/, ''))
    .slice(0, 20);
  if (u.protocol === 'https:' && mixedContentSamples.length > 0) {
    recommendations.push(
      `${mixedContentSamples.length}+ mixed-content reference(s) on homepage. Run wp.search_replace from http:// to https:// versions.`,
    );
  }

  if (recommendations.length === 0) {
    recommendations.push('TLS, redirects, HSTS, and mixed-content all look healthy.');
  }

  return {
    url, certSubject, certIssuer, certNotBefore, certNotAfter,
    certDaysUntilExpiry,
    redirectChain: chain,
    finalUrl,
    hstsHeader: hsts,
    mixedContentSamples,
    recommendations,
  };
}
