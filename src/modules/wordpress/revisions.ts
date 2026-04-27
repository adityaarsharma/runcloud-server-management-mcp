/**
 * revisions.ts — Audit + clean WordPress post revisions, auto-drafts, spam
 *
 * Long-running WP installs accumulate revisions, auto-draft posts, and spam
 * comments that bloat the database. This module surfaces counts/sizes and
 * provides a safe cleaner that keeps last-N revisions per post.
 *
 * WP-CLI used:  wp db query  /  wp post delete --force
 */

import { SSHOptions, wpCli } from '../../core/ssh-enhanced.js';

export interface RevisionsAuditResult {
  postRevisions: number;
  autoDrafts: number;
  trashedPosts: number;
  spamComments: number;
  trashComments: number;
  oversizedRevisionsKb: number;
  estimatedReclaimableKb: number;
  recommendations: string[];
}

export interface RevisionsCleanOptions {
  keepRevisionsPerPost: number;       // default 5
  deleteAutoDrafts: boolean;
  deleteTrashedPosts: boolean;
  deleteSpamComments: boolean;
  deleteTrashedComments: boolean;
  apply: boolean;                     // default false (dry-run)
}

export interface RevisionsCleanResult {
  applied: boolean;
  revisionsDeleted: number;
  autoDraftsDeleted: number;
  trashedPostsDeleted: number;
  spamCommentsDeleted: number;
  trashedCommentsDeleted: number;
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

async function tablePrefix(sshOpts: SSHOptions, wpPath: string, wpUser: string): Promise<string> {
  const r = await wpCli(sshOpts, wpPath, wpUser, `db prefix --skip-plugins --skip-themes 2>/dev/null`);
  return r.stdout.trim() || 'wp_';
}

export async function auditRevisions(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<RevisionsAuditResult> {
  safe(wpPath);
  const px = await tablePrefix(sshOpts, wpPath, wpUser);

  const counts = await wpCli(
    sshOpts, wpPath, wpUser,
    `db query "` +
    `SELECT 'rev', COUNT(*) FROM \`${px}posts\` WHERE post_type='revision' UNION ALL ` +
    `SELECT 'auto', COUNT(*) FROM \`${px}posts\` WHERE post_status='auto-draft' UNION ALL ` +
    `SELECT 'trashp', COUNT(*) FROM \`${px}posts\` WHERE post_status='trash' UNION ALL ` +
    `SELECT 'spam', COUNT(*) FROM \`${px}comments\` WHERE comment_approved='spam' UNION ALL ` +
    `SELECT 'trashc', COUNT(*) FROM \`${px}comments\` WHERE comment_approved='trash';" --skip-column-names 2>/dev/null`,
  );
  const m = new Map<string, number>();
  for (const line of counts.stdout.split('\n').filter(Boolean)) {
    const [k, v] = line.split(/\s+/);
    m.set(k, parseInt(v, 10) || 0);
  }

  const sizeRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `db query "SELECT ROUND(SUM(LENGTH(post_content) + LENGTH(post_title) + LENGTH(post_excerpt))/1024) ` +
    `FROM \`${px}posts\` WHERE post_type='revision';" --skip-column-names 2>/dev/null`,
  );
  const oversizedRevisionsKb = parseInt(sizeRes.stdout.trim(), 10) || 0;

  const postRevisions = m.get('rev') ?? 0;
  const autoDrafts = m.get('auto') ?? 0;
  const trashedPosts = m.get('trashp') ?? 0;
  const spamComments = m.get('spam') ?? 0;
  const trashComments = m.get('trashc') ?? 0;

  const recommendations: string[] = [];
  if (postRevisions > 1000) {
    recommendations.push(
      `${postRevisions} post revisions consume ~${oversizedRevisionsKb} KB. Run wp.revisions_clean keeping last 5 per post.`,
    );
  }
  if (autoDrafts > 100) {
    recommendations.push(`${autoDrafts} auto-drafts — safe to clear via wp.revisions_clean.`);
  }
  if (spamComments > 100) {
    recommendations.push(`${spamComments} spam comments — purge via wp.revisions_clean.`);
  }
  if (recommendations.length === 0) {
    recommendations.push('Revision and trash counts look healthy.');
  }

  return {
    postRevisions, autoDrafts, trashedPosts, spamComments, trashComments,
    oversizedRevisionsKb,
    estimatedReclaimableKb: oversizedRevisionsKb,
    recommendations,
  };
}

export async function cleanRevisions(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
  opts: RevisionsCleanOptions,
): Promise<RevisionsCleanResult> {
  safe(wpPath);
  const px = await tablePrefix(sshOpts, wpPath, wpUser);
  const keep = Math.max(0, Math.min(50, opts.keepRevisionsPerPost ?? 5));

  let revisionsDeleted = 0;
  let autoDraftsDeleted = 0;
  let trashedPostsDeleted = 0;
  let spamCommentsDeleted = 0;
  let trashedCommentsDeleted = 0;

  if (!opts.apply) {
    // Dry run: count what would be deleted
    const dryRev = await wpCli(
      sshOpts, wpPath, wpUser,
      `db query "SELECT COUNT(*) FROM \`${px}posts\` r ` +
      `WHERE r.post_type='revision' AND r.ID NOT IN ( ` +
      `  SELECT ID FROM (SELECT ID, ROW_NUMBER() OVER (PARTITION BY post_parent ORDER BY post_modified DESC) rn ` +
      `  FROM \`${px}posts\` WHERE post_type='revision') t WHERE rn <= ${keep});" --skip-column-names 2>/dev/null`,
    );
    revisionsDeleted = parseInt(dryRev.stdout.trim(), 10) || 0;
    if (opts.deleteAutoDrafts) {
      const r = await wpCli(sshOpts, wpPath, wpUser,
        `db query "SELECT COUNT(*) FROM \`${px}posts\` WHERE post_status='auto-draft';" --skip-column-names 2>/dev/null`);
      autoDraftsDeleted = parseInt(r.stdout.trim(), 10) || 0;
    }
    if (opts.deleteTrashedPosts) {
      const r = await wpCli(sshOpts, wpPath, wpUser,
        `db query "SELECT COUNT(*) FROM \`${px}posts\` WHERE post_status='trash';" --skip-column-names 2>/dev/null`);
      trashedPostsDeleted = parseInt(r.stdout.trim(), 10) || 0;
    }
    if (opts.deleteSpamComments) {
      const r = await wpCli(sshOpts, wpPath, wpUser,
        `db query "SELECT COUNT(*) FROM \`${px}comments\` WHERE comment_approved='spam';" --skip-column-names 2>/dev/null`);
      spamCommentsDeleted = parseInt(r.stdout.trim(), 10) || 0;
    }
    if (opts.deleteTrashedComments) {
      const r = await wpCli(sshOpts, wpPath, wpUser,
        `db query "SELECT COUNT(*) FROM \`${px}comments\` WHERE comment_approved='trash';" --skip-column-names 2>/dev/null`);
      trashedCommentsDeleted = parseInt(r.stdout.trim(), 10) || 0;
    }
    return {
      applied: false,
      revisionsDeleted, autoDraftsDeleted, trashedPostsDeleted,
      spamCommentsDeleted, trashedCommentsDeleted,
    };
  }

  // Apply: keep last N revisions per post
  const delRev = await wpCli(
    { ...sshOpts, timeoutMs: 600_000 }, wpPath, wpUser,
    `db query "DELETE FROM \`${px}posts\` WHERE post_type='revision' AND ID NOT IN ( ` +
    `SELECT ID FROM (SELECT ID, ROW_NUMBER() OVER (PARTITION BY post_parent ORDER BY post_modified DESC) rn ` +
    `FROM \`${px}posts\` WHERE post_type='revision') t WHERE rn <= ${keep});" 2>&1`,
  );
  const m1 = delRev.stdout.match(/(\d+) rows? affected/i);
  revisionsDeleted = m1 ? parseInt(m1[1], 10) : 0;

  if (opts.deleteAutoDrafts) {
    const r = await wpCli(sshOpts, wpPath, wpUser,
      `db query "DELETE FROM \`${px}posts\` WHERE post_status='auto-draft';" 2>&1`);
    const mm = r.stdout.match(/(\d+) rows? affected/i);
    autoDraftsDeleted = mm ? parseInt(mm[1], 10) : 0;
  }
  if (opts.deleteTrashedPosts) {
    const r = await wpCli(sshOpts, wpPath, wpUser,
      `db query "DELETE FROM \`${px}posts\` WHERE post_status='trash';" 2>&1`);
    const mm = r.stdout.match(/(\d+) rows? affected/i);
    trashedPostsDeleted = mm ? parseInt(mm[1], 10) : 0;
  }
  if (opts.deleteSpamComments) {
    const r = await wpCli(sshOpts, wpPath, wpUser,
      `db query "DELETE FROM \`${px}comments\` WHERE comment_approved='spam';" 2>&1`);
    const mm = r.stdout.match(/(\d+) rows? affected/i);
    spamCommentsDeleted = mm ? parseInt(mm[1], 10) : 0;
  }
  if (opts.deleteTrashedComments) {
    const r = await wpCli(sshOpts, wpPath, wpUser,
      `db query "DELETE FROM \`${px}comments\` WHERE comment_approved='trash';" 2>&1`);
    const mm = r.stdout.match(/(\d+) rows? affected/i);
    trashedCommentsDeleted = mm ? parseInt(mm[1], 10) : 0;
  }

  return {
    applied: true,
    revisionsDeleted, autoDraftsDeleted, trashedPostsDeleted,
    spamCommentsDeleted, trashedCommentsDeleted,
  };
}
