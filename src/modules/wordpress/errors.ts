/**
 * errors.ts — WordPress Error Diagnosis + White Screen Analysis
 *
 * Parses PHP error logs, identifies the root cause and likely offending
 * plugin/theme, and determines whether Perch can auto-fix the issue.
 */

import { SSHOptions, wpCli, sshExec, httpGet } from '../../core/ssh-enhanced.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export type ErrorLevel = 'fatal' | 'error' | 'warning' | 'notice' | 'deprecated';

export interface ErrorEntry {
  timestamp: Date | null;
  level: ErrorLevel;
  message: string;
  file: string;
  line: number | null;
  /** Slug extracted from wp-content/plugins/<slug>/ path segment */
  pluginSlug: string | null;
  /** Slug extracted from wp-content/themes/<slug>/ path segment */
  themeSlug: string | null;
  isCore: boolean;
}

export interface ErrorDiagnosis {
  httpStatus: number | null;
  isWhiteScreen: boolean;
  recentErrors: ErrorEntry[];
  topPlugin: string | null;
  likelyCause: string | null;
  suggestedFix: string | null;
  fixableByPerch: boolean;
  fixCommand?: string;
  rawLogLines: string[];
}

// ─── Error level parsing ──────────────────────────────────────────────────────

const LEVEL_MAP: Record<string, ErrorLevel> = {
  'fatal error': 'fatal',
  'parse error': 'fatal',
  'error': 'error',
  'warning': 'warning',
  'notice': 'notice',
  'deprecated': 'deprecated',
  'strict standards': 'notice',
  'user error': 'error',
  'user warning': 'warning',
  'user notice': 'notice',
};

function parseLevel(raw: string): ErrorLevel {
  const lower = raw.toLowerCase();
  for (const [key, level] of Object.entries(LEVEL_MAP)) {
    if (lower.includes(key)) return level;
  }
  return 'error';
}

// ─── Path → slug extraction ────────────────────────────────────────────────────

function extractPluginSlug(filePath: string): string | null {
  const m = filePath.match(/wp-content\/plugins\/([^/]+)\//);
  return m ? m[1] : null;
}

function extractThemeSlug(filePath: string): string | null {
  const m = filePath.match(/wp-content\/themes\/([^/]+)\//);
  return m ? m[1] : null;
}

function isWordPressCore(filePath: string): boolean {
  return (
    filePath.includes('/wp-admin/') ||
    filePath.includes('/wp-includes/') ||
    (/wp-[^/]+\.php$/.test(filePath) &&
      !filePath.includes('/plugins/') &&
      !filePath.includes('/themes/'))
  );
}

// ─── PHP log line parser ──────────────────────────────────────────────────────

/**
 * Parse a single PHP error log line.
 *
 * Formats handled:
 *   [DD-Mon-YYYY HH:MM:SS UTC] PHP Fatal error: message in /path/file.php on line N
 *   [YYYY-MM-DD HH:MM:SS] PHP Warning: message in /path/file.php on line N
 */
function parseLogLine(line: string): ErrorEntry | null {
  if (!line.trim()) return null;

  // Extract timestamp
  const tsMatch = line.match(/^\[([^\]]+)\]/);
  let timestamp: Date | null = null;
  if (tsMatch) {
    const d = new Date(tsMatch[1]);
    if (!isNaN(d.getTime())) timestamp = d;
  }

  // Extract PHP error level and message
  const phpMatch = line.match(/PHP\s+([^:]+):\s+(.+?)(?:\s+in\s+(.+?)\s+on\s+line\s+(\d+))?$/i);
  if (!phpMatch) return null;

  const level = parseLevel(phpMatch[1]);
  const message = phpMatch[2].trim();
  const file = phpMatch[3]?.trim() ?? '';
  const lineNum = phpMatch[4] ? parseInt(phpMatch[4], 10) : null;

  return {
    timestamp,
    level,
    message,
    file,
    line: lineNum,
    pluginSlug: extractPluginSlug(file),
    themeSlug: extractThemeSlug(file),
    isCore: isWordPressCore(file),
  };
}

// ─── Root cause analysis ──────────────────────────────────────────────────────

interface CauseAnalysis {
  likelyCause: string;
  suggestedFix: string;
  fixableByPerch: boolean;
  fixCommand?: string;
}

function analyzeErrors(errors: ErrorEntry[]): CauseAnalysis | null {
  if (errors.length === 0) return null;

  // Look at fatal errors first, then warnings
  const fatals = errors.filter(e => e.level === 'fatal');
  const candidates = fatals.length > 0 ? fatals : errors;
  const topError = candidates[0];

  const msg = topError.message.toLowerCase();

  // Pattern matching — most specific first
  if (/class ['"]?(\w+)['"]? not found/.test(msg)) {
    const match = topError.message.match(/class ['"]?(\w+)['"]? not found/i);
    const className = match?.[1] ?? 'unknown';
    const plugin = topError.pluginSlug ?? 'a plugin';
    return {
      likelyCause: `Missing class "${className}" — likely a plugin dependency is missing or deactivated.`,
      suggestedFix: `Check that all required plugins for ${plugin} are installed and active.`,
      fixableByPerch: false,
    };
  }

  if (/cannot redeclare function (\w+)/i.test(topError.message)) {
    const fnMatch = topError.message.match(/cannot redeclare function (\w+)/i);
    const fn = fnMatch?.[1] ?? 'unknown';
    const plugin = topError.pluginSlug ?? 'unknown plugin';
    return {
      likelyCause: `Function "${fn}" declared twice — plugin conflict or duplicate plugin load.`,
      suggestedFix: `Deactivate ${plugin} and check for conflicting plugins.`,
      fixableByPerch: !!topError.pluginSlug,
      fixCommand: topError.pluginSlug ? `plugin deactivate ${topError.pluginSlug}` : undefined,
    };
  }

  if (/allowed memory size of \d+ bytes exhausted/i.test(topError.message)) {
    const script = topError.file.split('/').pop() ?? 'unknown';
    return {
      likelyCause: `Memory limit exhausted in ${script} — plugin or theme consuming excessive memory.`,
      suggestedFix: 'Increase PHP memory_limit in wp-config.php or deactivate heavy plugins.',
      fixableByPerch: false,
    };
  }

  if (/maximum execution time of \d+ seconds exceeded/i.test(topError.message)) {
    const plugin = topError.pluginSlug ?? 'a plugin or theme';
    return {
      likelyCause: `Execution timeout in ${plugin} — likely a slow database query or external API call.`,
      suggestedFix: 'Increase max_execution_time or deactivate the offending plugin to diagnose.',
      fixableByPerch: !!topError.pluginSlug,
      fixCommand: topError.pluginSlug ? `plugin deactivate ${topError.pluginSlug}` : undefined,
    };
  }

  if (/call to undefined function (\w+)/i.test(topError.message)) {
    const fnMatch = topError.message.match(/call to undefined function (\w+)/i);
    const fn = fnMatch?.[1] ?? 'unknown';
    const plugin = topError.pluginSlug ?? 'unknown plugin';
    return {
      likelyCause: `Undefined function "${fn}" — a required plugin providing this function is inactive or deleted.`,
      suggestedFix: `Reactivate or reinstall the plugin that provides "${fn}".`,
      fixableByPerch: false,
    };
  }

  if (/parse error.*syntax error/i.test(topError.message)) {
    const file = topError.file || 'unknown file';
    const plugin = topError.pluginSlug;
    return {
      likelyCause: `PHP syntax error in ${file} — likely a bad code edit or corrupted file.`,
      suggestedFix: plugin
        ? `Deactivate ${plugin} and restore the file from backup.`
        : 'Restore the affected file from backup.',
      fixableByPerch: !!plugin,
      fixCommand: plugin ? `plugin deactivate ${plugin}` : undefined,
    };
  }

  if (/require|include/i.test(msg) && /no such file/i.test(msg)) {
    const plugin = topError.pluginSlug ?? 'a plugin';
    return {
      likelyCause: `Required file not found — ${plugin} may be partially installed or missing files.`,
      suggestedFix: `Reinstall ${plugin} or restore from backup.`,
      fixableByPerch: false,
    };
  }

  // Generic fatal
  if (topError.level === 'fatal') {
    const origin = topError.pluginSlug ?? topError.themeSlug ?? (topError.isCore ? 'WordPress core' : 'unknown');
    return {
      likelyCause: `Fatal PHP error in ${origin}: ${topError.message.slice(0, 120)}`,
      suggestedFix: topError.pluginSlug
        ? `Deactivate ${topError.pluginSlug} to restore site functionality.`
        : 'Check error log and disable recently activated plugins.',
      fixableByPerch: !!topError.pluginSlug,
      fixCommand: topError.pluginSlug ? `plugin deactivate ${topError.pluginSlug}` : undefined,
    };
  }

  return null;
}

/** Count errors per plugin slug, return the most frequent offender */
function findTopPlugin(errors: ErrorEntry[]): string | null {
  const counts = new Map<string, number>();
  for (const e of errors) {
    if (e.pluginSlug) {
      counts.set(e.pluginSlug, (counts.get(e.pluginSlug) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ─── Log file discovery ────────────────────────────────────────────────────────

async function findPhpErrorLog(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string
): Promise<string | null> {
  // Ask WP for configured log path
  const confRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `eval "echo ini_get('error_log');"`
  );
  if (confRes.code === 0 && confRes.stdout.trim()) {
    const logPath = confRes.stdout.trim();
    const testRes = await sshExec(sshOpts, `test -f ${logPath} && echo yes || echo no`);
    if (testRes.stdout.trim() === 'yes') return logPath;
  }

  // Fallback locations
  const candidates = [
    `${wpPath}/wp-content/debug.log`,
    `${wpPath}/error_log`,
    '/var/log/php/error.log',
    '/var/log/php-fpm/www-error.log',
    '/var/log/nginx/php-error.log',
  ];

  for (const path of candidates) {
    const res = await sshExec(sshOpts, `test -f ${path} && test -s ${path} && echo yes || echo no`);
    if (res.stdout.trim() === 'yes') return path;
  }

  return null;
}

// ─── Main functions ───────────────────────────────────────────────────────────

export async function getRecentPhpErrors(
  sshOpts: SSHOptions,
  wpPath: string,
  lines = 200
): Promise<ErrorEntry[]> {
  // We can't run wpCli without wpUser — use a server-level lookup
  const candidates = [
    `${wpPath}/wp-content/debug.log`,
    `${wpPath}/error_log`,
    '/var/log/php/error.log',
    '/var/log/php-fpm/www-error.log',
  ];

  let rawLog = '';

  for (const logPath of candidates) {
    const res = await sshExec(
      sshOpts,
      `test -f ${logPath} && tail -${lines} ${logPath} 2>/dev/null || true`
    );
    if (res.stdout.trim()) {
      rawLog = res.stdout;
      break;
    }
  }

  return rawLog
    .split('\n')
    .map(parseLogLine)
    .filter((e): e is ErrorEntry => e !== null);
}

export async function diagnoseErrors(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string,
  domain: string,
  lines = 300
): Promise<ErrorDiagnosis> {
  // Check HTTP status + white screen in parallel with log parsing
  const [httpRes, logPath] = await Promise.all([
    httpGet(`https://${domain}/`),
    findPhpErrorLog(sshOpts, wpPath, wpUser),
  ]);

  const httpStatus = httpRes.status > 0 ? httpRes.status : null;
  const isWhiteScreen =
    httpStatus === 500 || (httpStatus === 200 && httpRes.body.trim().length < 100);

  let rawLogLines: string[] = [];
  let recentErrors: ErrorEntry[] = [];

  if (logPath) {
    const logRes = await sshExec(
      sshOpts,
      `tail -${lines} ${logPath} 2>/dev/null`
    );
    if (logRes.code === 0) {
      rawLogLines = logRes.stdout.split('\n').filter(Boolean).slice(-lines);
      recentErrors = rawLogLines
        .map(parseLogLine)
        .filter((e): e is ErrorEntry => e !== null)
        .slice(-100); // cap at 100 parsed entries
    }
  }

  // If site is down and no log, also try WP-CLI error log retrieval
  if (recentErrors.length === 0 && isWhiteScreen) {
    const wpLogRes = await wpCli(
      sshOpts, wpPath, wpUser,
      `eval "echo ini_get('error_log');"`
    );
    const altLog = wpLogRes.stdout.trim();
    if (altLog && altLog !== logPath) {
      const altRes = await sshExec(sshOpts, `tail -${lines} ${altLog} 2>/dev/null`);
      if (altRes.code === 0 && altRes.stdout.trim()) {
        rawLogLines = altRes.stdout.split('\n').filter(Boolean);
        recentErrors = rawLogLines
          .map(parseLogLine)
          .filter((e): e is ErrorEntry => e !== null)
          .slice(-100);
      }
    }
  }

  const topPlugin = findTopPlugin(recentErrors);
  const analysis = analyzeErrors(recentErrors);

  return {
    httpStatus,
    isWhiteScreen,
    recentErrors,
    topPlugin,
    likelyCause: analysis?.likelyCause ?? null,
    suggestedFix: analysis?.suggestedFix ?? null,
    fixableByPerch: analysis?.fixableByPerch ?? false,
    fixCommand: analysis?.fixCommand,
    rawLogLines: rawLogLines.slice(-50), // return last 50 raw lines for context
  };
}

export async function clearDebugLog(
  sshOpts: SSHOptions,
  wpPath: string
): Promise<void> {
  const debugLog = `${wpPath}/wp-content/debug.log`;
  await sshExec(sshOpts, `test -f ${debugLog} && truncate -s 0 ${debugLog} 2>/dev/null || true`);
}
