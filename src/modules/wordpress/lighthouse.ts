/**
 * lighthouse.ts — Lighthouse / PageSpeed Insights performance audit
 *
 * Two paths:
 *   1. PSI API (no API key needed for low volume): hits the public Google
 *      PageSpeed Insights endpoint and parses the audit summary.
 *   2. Local lighthouse CLI: if installed on the remote, runs against the
 *      site URL.
 *
 * Read-only. The PSI public endpoint is rate-limited; for production use
 * supply a `psiApiKey` argument or install the lighthouse CLI on the host.
 */

import { SSHOptions, sshExec } from '../../core/ssh-enhanced.js';

export interface LighthouseScores {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
}

export interface LighthouseMetrics {
  fcpMs: number;       // First Contentful Paint
  lcpMs: number;       // Largest Contentful Paint
  tbtMs: number;       // Total Blocking Time
  clsScore: number;    // Cumulative Layout Shift
  speedIndexMs: number;
  ttiMs: number;       // Time to Interactive
}

export interface LighthouseAuditResult {
  url: string;
  strategy: 'mobile' | 'desktop';
  source: 'psi-api' | 'lighthouse-cli';
  scores: LighthouseScores;
  metrics: LighthouseMetrics;
  topOpportunities: Array<{ title: string; savingsMs: number }>;
  recommendations: string[];
}

function shellArg(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function validateUrl(s: string): void {
  if (!/^https?:\/\/[a-zA-Z0-9.-]+/.test(s)) throw new Error('url must start with http(s)://');
}

function pct(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export async function runLighthouse(
  sshOpts: SSHOptions, url: string,
  strategy: 'mobile' | 'desktop' = 'mobile',
  psiApiKey?: string,
): Promise<LighthouseAuditResult> {
  validateUrl(url);
  const recommendations: string[] = [];

  // 1. Try local lighthouse CLI
  const cliCheck = await sshExec(sshOpts, `command -v lighthouse 2>/dev/null && echo ok || echo missing`);
  if (cliCheck.stdout.includes('ok')) {
    const r = await sshExec(
      { ...sshOpts, timeoutMs: 180_000 },
      `lighthouse ${shellArg(url)} --quiet --output=json --chrome-flags="--headless --no-sandbox" ` +
      `--only-categories=performance,accessibility,best-practices,seo ` +
      `--preset=${strategy === 'desktop' ? 'desktop' : 'perf'} 2>/dev/null`,
    );
    try {
      return parseLighthouseJson(r.stdout, url, strategy, 'lighthouse-cli', recommendations);
    } catch { /* fall through to PSI */ }
  }

  // 2. PSI API
  const params = new URLSearchParams({
    url, strategy,
    category: 'performance',
  });
  // PSI accepts multiple `category` params
  const extra = ['accessibility', 'best-practices', 'seo'].map(c => `category=${c}`).join('&');
  let psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params.toString()}&${extra}`;
  if (psiApiKey) psiUrl += `&key=${encodeURIComponent(psiApiKey)}`;

  const r = await sshExec(
    { ...sshOpts, timeoutMs: 60_000 },
    `curl -sS --max-time 50 ${shellArg(psiUrl)} 2>/dev/null`,
  );
  return parseLighthouseJson(r.stdout, url, strategy, 'psi-api', recommendations);
}

function parseLighthouseJson(
  raw: string, url: string,
  strategy: 'mobile' | 'desktop',
  source: 'psi-api' | 'lighthouse-cli',
  recommendations: string[],
): LighthouseAuditResult {
  if (!raw.trim().startsWith('{')) {
    throw new Error(`Lighthouse output not JSON: ${raw.slice(0, 200)}`);
  }
  const data = JSON.parse(raw) as Record<string, any>;
  const lh = source === 'psi-api' ? (data.lighthouseResult ?? data) : data;
  const cats = lh.categories ?? {};
  const audits = lh.audits ?? {};

  const scores: LighthouseScores = {
    performance: pct(cats.performance?.score),
    accessibility: pct(cats.accessibility?.score),
    bestPractices: pct(cats['best-practices']?.score),
    seo: pct(cats.seo?.score),
  };

  const metrics: LighthouseMetrics = {
    fcpMs: num(audits['first-contentful-paint']?.numericValue),
    lcpMs: num(audits['largest-contentful-paint']?.numericValue),
    tbtMs: num(audits['total-blocking-time']?.numericValue),
    clsScore: Math.round((Number(audits['cumulative-layout-shift']?.numericValue ?? 0)) * 1000) / 1000,
    speedIndexMs: num(audits['speed-index']?.numericValue),
    ttiMs: num(audits['interactive']?.numericValue),
  };

  // Top opportunities by savings
  const topOpportunities: Array<{ title: string; savingsMs: number }> = [];
  for (const auditId of Object.keys(audits)) {
    const a = audits[auditId];
    if (a?.details?.type === 'opportunity' && Number(a.numericValue) > 100) {
      topOpportunities.push({
        title: a.title ?? auditId,
        savingsMs: num(a.numericValue),
      });
    }
  }
  topOpportunities.sort((a, b) => b.savingsMs - a.savingsMs);

  if (scores.performance < 50) {
    recommendations.push(
      `Mobile performance score ${scores.performance} — critical. Top fix: ${topOpportunities[0]?.title ?? 'investigate render-blocking resources'}.`,
    );
  } else if (scores.performance < 80) {
    recommendations.push(
      `Performance score ${scores.performance} — improvable. Address top ${Math.min(3, topOpportunities.length)} opportunities for biggest wins.`,
    );
  }
  if (metrics.lcpMs > 2500) {
    recommendations.push(
      `LCP ${metrics.lcpMs}ms exceeds 2.5s threshold (Core Web Vitals failing). Common cause: large hero image not optimized — combine with wp.images_compress_bulk_start.`,
    );
  }
  if (metrics.clsScore > 0.1) {
    recommendations.push(
      `CLS ${metrics.clsScore} fails Core Web Vitals (>0.1). Add explicit width/height attributes to images.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('Lighthouse scores look healthy.');
  }

  return {
    url, strategy, source,
    scores, metrics,
    topOpportunities: topOpportunities.slice(0, 5),
    recommendations,
  };
}
