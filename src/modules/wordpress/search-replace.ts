/**
 * search-replace.ts — Safe wrapper around `wp search-replace`
 *
 * Used for site URL changes (staging→prod, http→https, domain rename).
 * Always runs --dry-run first; refuses to apply unless dry-run reported
 * non-zero replacements AND apply=true is passed.
 *
 * Skips serialized data only when --skip-tables/--skip-columns says so;
 * defaults to letting WP-CLI handle PHP serialized + JSON re-serialization.
 */

import { SSHOptions, wpCli } from '../../core/ssh-enhanced.js';

export interface SearchReplaceOptions {
  /** Source string. URLs only — must start with http:// or https://. */
  search: string;
  /** Replacement string. URLs only. */
  replace: string;
  /** Optional comma-separated list of tables to skip. */
  skipTables?: string;
  /** Run for real if true, else dry-run. */
  apply: boolean;
  /** Also run on tables that don't have GUIDs (default true). */
  allTables?: boolean;
}

export interface SearchReplaceResult {
  applied: boolean;
  search: string;
  replace: string;
  totalReplacements: number;
  byTable: Array<{ table: string; column: string; replacements: number }>;
  rawOutput: string;
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

function validateUrl(s: string): void {
  if (!/^https?:\/\/[a-zA-Z0-9.-]+/.test(s)) {
    throw new Error(`refusing — search/replace must be URL-shaped. got: ${s.slice(0, 80)}`);
  }
}

function shellArg(s: string): string {
  // Escape single quotes for shell
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function parseSearchReplaceOutput(stdout: string): { total: number; rows: Array<{ table: string; column: string; replacements: number }> } {
  // Output looks like a CSV table:
  //   +-----------------+--------------+-------------+
  //   | Table           | Column       | Replacements |
  //   +-----------------+--------------+-------------+
  //   | wp_posts        | post_content |          12  |
  //   ...
  //   Success: Made N replacements.
  const rows: Array<{ table: string; column: string; replacements: number }> = [];
  let total = 0;
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|/);
    if (m) {
      const replacements = parseInt(m[3], 10) || 0;
      if (replacements > 0) rows.push({ table: m[1], column: m[2], replacements });
    }
    const tot = line.match(/Made (\d+) replacements/i);
    if (tot) total = parseInt(tot[1], 10);
  }
  return { total, rows };
}

export async function searchReplace(
  sshOpts: SSHOptions, wpPath: string, wpUser: string, opts: SearchReplaceOptions,
): Promise<SearchReplaceResult> {
  safe(wpPath);
  validateUrl(opts.search);
  validateUrl(opts.replace);

  const allTables = opts.allTables !== false;
  const skipFlag = opts.skipTables ? `--skip-tables=${opts.skipTables}` : '';
  const tableFlag = allTables ? '--all-tables' : '';

  // 1. Always dry-run first
  const dryRun = await wpCli(
    { ...sshOpts, timeoutMs: 600_000 }, wpPath, wpUser,
    `search-replace ${shellArg(opts.search)} ${shellArg(opts.replace)} ` +
    `${tableFlag} ${skipFlag} --dry-run --format=table 2>&1`,
  );
  const dry = parseSearchReplaceOutput(dryRun.stdout);

  if (!opts.apply) {
    return {
      applied: false,
      search: opts.search, replace: opts.replace,
      totalReplacements: dry.total,
      byTable: dry.rows,
      rawOutput: dryRun.stdout.slice(0, 2000),
    };
  }

  if (dry.total === 0) {
    return {
      applied: false,
      search: opts.search, replace: opts.replace,
      totalReplacements: 0,
      byTable: [],
      rawOutput: 'Nothing to replace — apply skipped.',
    };
  }

  // 2. Apply
  const real = await wpCli(
    { ...sshOpts, timeoutMs: 600_000 }, wpPath, wpUser,
    `search-replace ${shellArg(opts.search)} ${shellArg(opts.replace)} ` +
    `${tableFlag} ${skipFlag} --format=table 2>&1`,
  );
  const result = parseSearchReplaceOutput(real.stdout);

  return {
    applied: true,
    search: opts.search, replace: opts.replace,
    totalReplacements: result.total,
    byTable: result.rows,
    rawOutput: real.stdout.slice(0, 2000),
  };
}
