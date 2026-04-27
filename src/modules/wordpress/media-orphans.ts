/**
 * media-orphans.ts — Find media-library attachments not referenced anywhere
 *
 * Cross-references the `wp_posts` table (post_type='attachment') against
 * post content, post meta, options, and active widget data to identify
 * uploads that no rendered URL points to. Typical sites carry 20–40%
 * orphan media after years of editing.
 *
 * Read-only audit. Deletion is a separate (yet-to-build) action; orphans
 * can be misclassified by complex page builders, so we never auto-delete.
 *
 * WP-CLI used:  wp post list --post_type=attachment  /  wp db query
 */

import { SSHOptions, wpCli } from '../../core/ssh-enhanced.js';

export interface OrphanAttachment {
  id: number;
  url: string;
  fileSizeKb: number;
  uploadedAt: string;
  reason: string;
}

export interface MediaOrphanAuditResult {
  totalAttachments: number;
  orphanCount: number;
  orphanFraction: number;
  estimatedReclaimableMb: number;
  orphans: OrphanAttachment[];
  recommendations: string[];
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

export async function auditMediaOrphans(
  sshOpts: SSHOptions, wpPath: string, wpUser: string, sampleLimit = 200,
): Promise<MediaOrphanAuditResult> {
  safe(wpPath);

  // 1. Total attachment count
  const totalRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `post list --post_type=attachment --format=count 2>/dev/null`,
  );
  const totalAttachments = parseInt(totalRes.stdout.trim(), 10) || 0;
  if (totalAttachments === 0) {
    return {
      totalAttachments: 0, orphanCount: 0, orphanFraction: 0,
      estimatedReclaimableMb: 0, orphans: [],
      recommendations: ['Media library is empty.'],
    };
  }

  // 2. Pull a sample of attachments (id, guid, date, file size) — full scan
  // on million-attachment installs is expensive; sampleLimit keeps it sane.
  const listRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `post list --post_type=attachment --posts_per_page=${sampleLimit} ` +
    `--orderby=ID --order=ASC ` +
    `--fields=ID,guid,post_date --format=json 2>/dev/null`,
  );
  let attachments: Array<{ ID: number; guid: string; post_date: string }> = [];
  try { attachments = JSON.parse(listRes.stdout); } catch { /* empty */ }

  const orphans: OrphanAttachment[] = [];
  let totalKb = 0;

  for (const a of attachments) {
    if (!a.guid) continue;
    const filename = a.guid.split('/').pop() ?? '';
    if (!filename) continue;
    // Look for the filename in post_content (any post type) and in postmeta
    const escFilename = filename.replace(/'/g, "''");
    const probeRes = await wpCli(
      sshOpts, wpPath, wpUser,
      `db query "SELECT 1 FROM \\$(wp db prefix --skip-plugins --skip-themes 2>/dev/null)posts ` +
      `WHERE post_content LIKE '%${escFilename}%' LIMIT 1; ` +
      `SELECT 1 FROM \\$(wp db prefix --skip-plugins --skip-themes 2>/dev/null)postmeta ` +
      `WHERE meta_value LIKE '%${escFilename}%' LIMIT 1; ` +
      `SELECT 1 FROM \\$(wp db prefix --skip-plugins --skip-themes 2>/dev/null)options ` +
      `WHERE option_value LIKE '%${escFilename}%' LIMIT 1;" --skip-column-names 2>/dev/null`,
    );
    const referenced = probeRes.stdout.trim().length > 0;
    if (!referenced) {
      // Probe file size on disk
      const sizeRes = await wpCli(
        sshOpts, wpPath, wpUser,
        `eval "echo (file_exists(get_attached_file(${a.ID})) ? filesize(get_attached_file(${a.ID})) : 0);" 2>/dev/null`,
      );
      const bytes = parseInt(sizeRes.stdout.trim(), 10) || 0;
      const kb = Math.round(bytes / 1024);
      totalKb += kb;
      orphans.push({
        id: a.ID,
        url: a.guid,
        fileSizeKb: kb,
        uploadedAt: a.post_date,
        reason: 'No post_content / postmeta / options reference matched the filename',
      });
    }
  }

  const orphanFraction = attachments.length > 0
    ? Math.round((orphans.length / attachments.length) * 1000) / 1000
    : 0;
  const projectedTotal = Math.round(orphanFraction * totalAttachments);

  const recommendations: string[] = [];
  if (attachments.length < totalAttachments) {
    recommendations.push(
      `Sampled ${attachments.length} of ${totalAttachments} attachments; orphan fraction ${(orphanFraction * 100).toFixed(1)}% suggests ~${projectedTotal} orphans library-wide.`,
    );
  }
  if (orphanFraction > 0.2) {
    recommendations.push(
      `High orphan rate. Run a bulk-delete only after spot-checking a sample manually — page builders (Elementor, Divi, Beaver) sometimes store image references in formats this audit can miss.`,
    );
  }

  return {
    totalAttachments,
    orphanCount: orphans.length,
    orphanFraction,
    estimatedReclaimableMb: Math.round(totalKb / 1024),
    orphans,
    recommendations,
  };
}
