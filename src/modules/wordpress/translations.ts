/**
 * translations.ts — Find unused .po/.mo translation files
 *
 * Themes and plugins ship dozens of language files; most sites use one
 * locale. The unused ones can total 50–200 MB. This module surfaces them
 * and (optionally) deletes ones not matching the active locale.
 *
 * WP-CLI used:  wp option get WPLANG  /  wp eval "echo get_locale();"
 */

import { SSHOptions, sshExec, wpCli } from '../../core/ssh-enhanced.js';

export interface TranslationGroup {
  scope: string;            // "core" | "plugin:<slug>" | "theme:<slug>"
  totalFiles: number;
  totalSizeMb: number;
  byLocale: Array<{ locale: string; sizeMb: number; files: number }>;
}

export interface TranslationsAuditResult {
  activeLocale: string;
  groups: TranslationGroup[];
  totalUnusedMb: number;
  recommendations: string[];
}

export interface TranslationsCleanResult {
  applied: boolean;
  filesDeleted: number;
  bytesFreed: number;
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

async function activeLocale(sshOpts: SSHOptions, wpPath: string, wpUser: string): Promise<string> {
  const r = await wpCli(sshOpts, wpPath, wpUser, `eval "echo get_locale();" 2>/dev/null`);
  return r.stdout.trim() || 'en_US';
}

async function listGroupFiles(
  sshOpts: SSHOptions, dir: string,
): Promise<Array<{ basename: string; bytes: number }>> {
  const r = await sshExec(
    sshOpts,
    `find ${dir} -maxdepth 4 -type f \\( -iname "*.mo" -o -iname "*.po" \\) -printf '%s\\t%f\\n' 2>/dev/null`,
  );
  const out: Array<{ basename: string; bytes: number }> = [];
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [bytesStr, basename] = line.split('\t');
    const bytes = parseInt(bytesStr, 10) || 0;
    out.push({ basename, bytes });
  }
  return out;
}

function localeFromBasename(basename: string): string {
  // Patterns: "<textdomain>-<locale>.mo" or "<locale>.mo"
  const m = basename.match(/(?:^|-)([a-z]{2}(?:_[A-Z]{2})?)\.(mo|po)$/);
  return m ? m[1] : 'unknown';
}

export async function auditTranslations(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<TranslationsAuditResult> {
  safe(wpPath);
  const locale = await activeLocale(sshOpts, wpPath, wpUser);

  const dirs = [
    { scope: 'core', dir: `${wpPath}/wp-content/languages` },
  ];
  // Plugins
  const plugRes = await sshExec(
    sshOpts,
    `find ${wpPath}/wp-content/plugins -mindepth 1 -maxdepth 1 -type d 2>/dev/null`,
  );
  for (const p of plugRes.stdout.split('\n').filter(Boolean)) {
    const slug = p.split('/').pop() ?? '';
    if (!slug || !/^[a-zA-Z0-9._-]+$/.test(slug)) continue;
    dirs.push({ scope: `plugin:${slug}`, dir: `${p}/languages` });
  }
  // Themes
  const themeRes = await sshExec(
    sshOpts,
    `find ${wpPath}/wp-content/themes -mindepth 1 -maxdepth 1 -type d 2>/dev/null`,
  );
  for (const t of themeRes.stdout.split('\n').filter(Boolean)) {
    const slug = t.split('/').pop() ?? '';
    if (!slug || !/^[a-zA-Z0-9._-]+$/.test(slug)) continue;
    dirs.push({ scope: `theme:${slug}`, dir: `${t}/languages` });
  }

  const groups: TranslationGroup[] = [];
  let totalUnusedBytes = 0;

  for (const { scope, dir } of dirs) {
    const files = await listGroupFiles(sshOpts, dir);
    if (files.length === 0) continue;
    const localeMap = new Map<string, { bytes: number; files: number }>();
    let totalBytes = 0;
    for (const f of files) {
      const loc = localeFromBasename(f.basename);
      const cur = localeMap.get(loc) ?? { bytes: 0, files: 0 };
      cur.bytes += f.bytes;
      cur.files++;
      localeMap.set(loc, cur);
      totalBytes += f.bytes;
      if (loc !== locale && loc !== 'unknown') {
        totalUnusedBytes += f.bytes;
      }
    }
    groups.push({
      scope,
      totalFiles: files.length,
      totalSizeMb: Math.round((totalBytes / (1024 * 1024)) * 100) / 100,
      byLocale: Array.from(localeMap.entries())
        .map(([locale, v]) => ({ locale, sizeMb: Math.round((v.bytes / (1024 * 1024)) * 100) / 100, files: v.files }))
        .sort((a, b) => b.sizeMb - a.sizeMb),
    });
  }

  const totalUnusedMb = Math.round((totalUnusedBytes / (1024 * 1024)) * 100) / 100;
  const recommendations: string[] = [];
  if (totalUnusedMb > 50) {
    recommendations.push(
      `~${totalUnusedMb} MB lives in translations for locales other than the active "${locale}". ` +
      `Run wp.translations_clean to remove them; WordPress re-downloads core translations as needed.`,
    );
  } else if (totalUnusedMb > 0) {
    recommendations.push(
      `~${totalUnusedMb} MB in non-active-locale translations. Cleanup is low-priority at this size.`,
    );
  } else {
    recommendations.push('No significant translation bloat detected.');
  }

  return { activeLocale: locale, groups, totalUnusedMb, recommendations };
}

export async function cleanTranslations(
  sshOpts: SSHOptions, wpPath: string, wpUser: string, apply: boolean,
): Promise<TranslationsCleanResult> {
  safe(wpPath);
  const locale = await activeLocale(sshOpts, wpPath, wpUser);
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(locale)) {
    throw new Error(`refusing to act with unparseable locale "${locale}"`);
  }

  // Build a single find expression that ignores active locale & "unknown"
  // ("unknown" = filenames we couldn't classify; safer to keep)
  const cmd =
    `find ${wpPath}/wp-content -type f \\( -iname '*.mo' -o -iname '*.po' \\) ` +
    `! -name '*-${locale}.mo' ! -name '*-${locale}.po' ` +
    `! -name '${locale}.mo' ! -name '${locale}.po' ` +
    `-printf '%s\\n' 2>/dev/null`;

  if (!apply) {
    const r = await sshExec(sshOpts, cmd);
    let bytes = 0;
    let files = 0;
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      bytes += parseInt(line, 10) || 0;
      files++;
    }
    return { applied: false, filesDeleted: files, bytesFreed: bytes };
  }
  // Apply: delete + count
  const r = await sshExec(
    { ...sshOpts, timeoutMs: 600_000 },
    cmd.replace(`-printf '%s\\n'`, `-print -delete`) + ` | wc -l`,
  );
  const filesDeleted = parseInt(r.stdout.trim(), 10) || 0;
  // Bytes freed isn't recoverable post-delete; report 0 here intentionally.
  return { applied: true, filesDeleted, bytesFreed: 0 };
}
