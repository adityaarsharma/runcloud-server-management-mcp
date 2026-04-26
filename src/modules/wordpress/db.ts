/**
 * db.ts — WordPress Database Audit
 *
 * Audits autoload bloat, transients, orphaned data, revisions,
 * and table fragmentation. All queries run through WP-CLI db query.
 */

import { SSHOptions, wpCli } from '../../core/ssh-enhanced.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface AutoloadOffender {
  optionName: string;
  sizeKb: number;
  likelyPlugin: string;
}

export interface FragmentedTable {
  table: string;
  freeSpaceMb: number;
}

export interface DBHealthResult {
  autoloadSizeKb: number;
  /** < 1 MB = healthy | 3–5 MB = warning | > 10 MB = critical */
  autoloadStatus: 'healthy' | 'warning' | 'critical';
  autoloadTopOffenders: AutoloadOffender[];
  expiredTransients: number;
  expiredTransientsSizeKb: number;
  orphanedPostmeta: number;
  orphanedWooSessions: number;
  postRevisions: number;
  /** Revisions that can be deleted keeping last 5 per post */
  deletableRevisions: number;
  fragmentedTables: FragmentedTable[];
  slowQueriesAvailable: boolean;
  summary: string;
  recommendations: string[];
}

export interface CleanTransientsResult {
  deleted: number;
  savedKb: number;
}

export interface CleanOrphanedSessionsResult {
  deleted: number;
}

export interface OptimizeTablesResult {
  optimized: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function guessPlugin(optionName: string): string {
  const cleaned = optionName.replace(/^_+/, '');
  const parts = cleaned.split(/[_\-]/);
  const candidate = parts.slice(0, 2).join('-').toLowerCase();
  if (!candidate || candidate.length < 2) return 'unknown';
  return candidate;
}

function parseNumber(raw: string): number {
  const n = Number(raw.trim().replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function autoloadStatusLabel(kb: number): 'healthy' | 'warning' | 'critical' {
  if (kb < 1024) return 'healthy';
  if (kb < 5120) return 'warning';
  return 'critical';
}

function affectedRows(output: string): number {
  const m = output.match(/(\d+) rows? affected/i);
  return m ? parseInt(m[1], 10) : 0;
}

/** Run a raw SQL query via `wp db query` and return the raw SSHResult */
async function dbQuery(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string,
  sql: string
) {
  // Escape single quotes in SQL for shell safety
  const escapedSql = sql.replace(/'/g, "'\\''");
  return wpCli(sshOpts, wpPath, wpUser, `db query '${escapedSql}'`);
}

// ─── Main audit ───────────────────────────────────────────────────────────────

export async function auditDatabase(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string,
  dbName: string
): Promise<DBHealthResult> {
  const recommendations: string[] = [];
  let autoloadSizeKb = 0;
  let autoloadTopOffenders: AutoloadOffender[] = [];
  let expiredTransients = 0;
  let expiredTransientsSizeKb = 0;
  let orphanedPostmeta = 0;
  let orphanedWooSessions = 0;
  let postRevisions = 0;
  let deletableRevisions = 0;
  const fragmentedTables: FragmentedTable[] = [];

  // 1. Autoload total size
  const autoloadSizeRes = await dbQuery(
    sshOpts, wpPath, wpUser,
    `SELECT ROUND(SUM(LENGTH(option_value)) / 1024, 2) AS size_kb FROM wp_options WHERE autoload = 'yes';`
  );
  if (autoloadSizeRes.code === 0) {
    const lines = autoloadSizeRes.stdout.split('\n').filter(Boolean);
    const dataLine = lines.find(l => l !== 'size_kb' && /[\d.]+/.test(l));
    if (dataLine) autoloadSizeKb = parseNumber(dataLine);
  }

  // 2. Top 10 autoload offenders
  const offendersRes = await dbQuery(
    sshOpts, wpPath, wpUser,
    `SELECT option_name, ROUND(LENGTH(option_value) / 1024, 2) AS size_kb ` +
    `FROM wp_options WHERE autoload = 'yes' ` +
    `ORDER BY LENGTH(option_value) DESC LIMIT 10;`
  );
  if (offendersRes.code === 0) {
    const lines = offendersRes.stdout.split('\n').filter(Boolean).slice(1);
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const optionName = parts[0].trim();
        const sizeKb = parseNumber(parts[1]);
        autoloadTopOffenders.push({
          optionName,
          sizeKb,
          likelyPlugin: guessPlugin(optionName),
        });
      }
    }
  }

  // 3. Expired transients count + size
  const transientsRes = await dbQuery(
    sshOpts, wpPath, wpUser,
    `SELECT COUNT(*) AS cnt, ROUND(SUM(LENGTH(option_value)) / 1024, 2) AS size_kb ` +
    `FROM wp_options ` +
    `WHERE option_name LIKE '_transient_timeout_%' ` +
    `AND option_value < UNIX_TIMESTAMP();`
  );
  if (transientsRes.code === 0) {
    const lines = transientsRes.stdout.split('\n').filter(Boolean).slice(1);
    if (lines[0]) {
      const parts = lines[0].split('\t');
      expiredTransients = parseNumber(parts[0] ?? '0');
      expiredTransientsSizeKb = parseNumber(parts[1] ?? '0');
    }
  }

  // 4. Orphaned postmeta
  const postmetaRes = await dbQuery(
    sshOpts, wpPath, wpUser,
    `SELECT COUNT(*) FROM wp_postmeta pm ` +
    `LEFT JOIN wp_posts p ON pm.post_id = p.ID ` +
    `WHERE p.ID IS NULL;`
  );
  if (postmetaRes.code === 0) {
    const lines = postmetaRes.stdout.split('\n').filter(Boolean).slice(1);
    if (lines[0]) orphanedPostmeta = parseNumber(lines[0]);
  }

  // 5. Orphaned WooCommerce sessions (older than 30 minutes)
  const wooRes = await dbQuery(
    sshOpts, wpPath, wpUser,
    `SELECT COUNT(*) FROM wp_options ` +
    `WHERE option_name LIKE '_wc_session_%' ` +
    `AND CAST(option_value AS UNSIGNED) < UNIX_TIMESTAMP(NOW() - INTERVAL 30 MINUTE);`
  );
  if (wooRes.code === 0) {
    const lines = wooRes.stdout.split('\n').filter(Boolean).slice(1);
    if (lines[0]) orphanedWooSessions = parseNumber(lines[0]);
  }

  // 6. Post revisions count
  const revisionsRes = await dbQuery(
    sshOpts, wpPath, wpUser,
    `SELECT COUNT(*) FROM wp_posts WHERE post_type = 'revision';`
  );
  if (revisionsRes.code === 0) {
    const lines = revisionsRes.stdout.split('\n').filter(Boolean).slice(1);
    if (lines[0]) postRevisions = parseNumber(lines[0]);
  }

  // 7. Deletable revisions (keep last 5 per parent post)
  const deletableRes = await dbQuery(
    sshOpts, wpPath, wpUser,
    `SELECT COUNT(*) FROM ( ` +
    `SELECT ID, ROW_NUMBER() OVER (PARTITION BY post_parent ORDER BY post_date DESC) AS rn ` +
    `FROM wp_posts WHERE post_type = 'revision' ` +
    `) ranked WHERE rn > 5;`
  );
  if (deletableRes.code === 0) {
    const lines = deletableRes.stdout.split('\n').filter(Boolean).slice(1);
    if (lines[0]) deletableRevisions = parseNumber(lines[0]);
  }

  // 8. Fragmented tables from information_schema
  const safeDbName = dbName.replace(/[^a-zA-Z0-9_]/g, '');
  const fragRes = await dbQuery(
    sshOpts, wpPath, wpUser,
    `SELECT TABLE_NAME, ROUND(DATA_FREE / 1024 / 1024, 2) AS free_mb ` +
    `FROM information_schema.TABLES ` +
    `WHERE TABLE_SCHEMA = '${safeDbName}' AND DATA_FREE > 0 ` +
    `ORDER BY DATA_FREE DESC;`
  );
  if (fragRes.code === 0) {
    const lines = fragRes.stdout.split('\n').filter(Boolean).slice(1);
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        fragmentedTables.push({
          table: parts[0].trim(),
          freeSpaceMb: parseNumber(parts[1]),
        });
      }
    }
  }

  // 9. Check if slow query log is on
  const slowRes = await dbQuery(
    sshOpts, wpPath, wpUser,
    `SHOW VARIABLES LIKE 'slow_query_log';`
  );
  const slowQueriesAvailable =
    slowRes.code === 0 && slowRes.stdout.toLowerCase().includes('on');

  // Build recommendations
  const autoloadStatus = autoloadStatusLabel(autoloadSizeKb);
  if (autoloadStatus === 'critical') {
    recommendations.push(
      `Autoload data is ${Math.round(autoloadSizeKb / 1024)} MB — critically high. ` +
      `Review top offenders and disable autoload for large, rarely-read options.`
    );
  } else if (autoloadStatus === 'warning') {
    recommendations.push(
      `Autoload data is ${Math.round(autoloadSizeKb / 1024)} MB — consider pruning unused plugin options.`
    );
  }
  if (expiredTransients > 100) {
    recommendations.push(
      `${expiredTransients} expired transients (${Math.round(expiredTransientsSizeKb)} KB). Run cleanTransients() to reclaim space.`
    );
  }
  if (orphanedPostmeta > 1000) {
    recommendations.push(`${orphanedPostmeta} orphaned postmeta rows — safe to delete.`);
  }
  if (orphanedWooSessions > 500) {
    recommendations.push(`${orphanedWooSessions} stale WooCommerce sessions — run cleanOrphanedSessions().`);
  }
  if (deletableRevisions > 500) {
    recommendations.push(
      `${deletableRevisions} excess revisions can be pruned (keeping last 5 per post).`
    );
  }
  if (fragmentedTables.length > 0) {
    const totalFree = fragmentedTables.reduce((a, t) => a + t.freeSpaceMb, 0);
    recommendations.push(
      `${fragmentedTables.length} fragmented tables with ${totalFree.toFixed(1)} MB free space — run optimizeFragmentedTables().`
    );
  }
  if (!slowQueriesAvailable) {
    recommendations.push('Slow query log is disabled — enable it to diagnose performance bottlenecks.');
  }

  const summaryParts: string[] = [
    `Autoload ${Math.round(autoloadSizeKb)} KB (${autoloadStatus})`,
  ];
  if (expiredTransients > 0) summaryParts.push(`${expiredTransients} expired transients`);
  if (orphanedPostmeta > 0) summaryParts.push(`${orphanedPostmeta} orphaned postmeta`);
  if (postRevisions > 0) summaryParts.push(`${postRevisions} revisions`);

  return {
    autoloadSizeKb,
    autoloadStatus,
    autoloadTopOffenders,
    expiredTransients,
    expiredTransientsSizeKb,
    orphanedPostmeta,
    orphanedWooSessions,
    postRevisions,
    deletableRevisions,
    fragmentedTables,
    slowQueriesAvailable,
    summary: summaryParts.join(' | '),
    recommendations,
  };
}

// ─── Action functions ─────────────────────────────────────────────────────────

export async function cleanTransients(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string
): Promise<CleanTransientsResult> {
  // Capture size before deletion
  const sizeRes = await dbQuery(
    sshOpts, wpPath, wpUser,
    `SELECT ROUND(SUM(LENGTH(option_value)) / 1024, 2) ` +
    `FROM wp_options WHERE option_name LIKE '_transient_timeout_%' AND option_value < UNIX_TIMESTAMP();`
  );
  const lines = sizeRes.stdout.split('\n').filter(Boolean).slice(1);
  const savedKb = parseNumber(lines[0] ?? '0');

  // Delete expired timeout markers
  const delTimeouts = await dbQuery(
    sshOpts, wpPath, wpUser,
    `DELETE FROM wp_options WHERE option_name LIKE '_transient_timeout_%' AND option_value < UNIX_TIMESTAMP();`
  );

  // Delete orphaned transient values (no matching timeout key)
  const delValues = await dbQuery(
    sshOpts, wpPath, wpUser,
    `DELETE FROM wp_options ` +
    `WHERE option_name LIKE '_transient_%' ` +
    `AND option_name NOT LIKE '_transient_timeout_%' ` +
    `AND CONCAT('_transient_timeout_', SUBSTRING(option_name, 12)) NOT IN ` +
    `(SELECT option_name FROM (SELECT option_name FROM wp_options WHERE option_name LIKE '_transient_timeout_%') t);`
  );

  const deleted =
    affectedRows(delTimeouts.stdout) + affectedRows(delValues.stdout);

  return { deleted, savedKb };
}

export async function cleanOrphanedSessions(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string
): Promise<CleanOrphanedSessionsResult> {
  const res = await dbQuery(
    sshOpts, wpPath, wpUser,
    `DELETE FROM wp_options ` +
    `WHERE option_name LIKE '_wc_session_%' ` +
    `AND CAST(option_value AS UNSIGNED) < UNIX_TIMESTAMP(NOW() - INTERVAL 30 MINUTE);`
  );
  return { deleted: affectedRows(res.stdout) };
}

export async function optimizeFragmentedTables(
  sshOpts: SSHOptions,
  wpPath: string,
  wpUser: string
): Promise<OptimizeTablesResult> {
  const fragRes = await dbQuery(
    sshOpts, wpPath, wpUser,
    `SELECT TABLE_NAME FROM information_schema.TABLES ` +
    `WHERE TABLE_SCHEMA = DATABASE() AND DATA_FREE > 1048576 ` +
    `ORDER BY DATA_FREE DESC LIMIT 20;`
  );

  const tables = fragRes.stdout
    .split('\n')
    .filter(Boolean)
    .slice(1) // skip header
    .map(l => l.trim())
    .filter(t => /^[a-zA-Z0-9_]+$/.test(t)); // sanitize — only safe names

  const optimized: string[] = [];

  for (const table of tables) {
    const res = await dbQuery(
      sshOpts, wpPath, wpUser,
      `OPTIMIZE TABLE \`${table}\`;`
    );
    if (res.code === 0) optimized.push(table);
  }

  return { optimized };
}
