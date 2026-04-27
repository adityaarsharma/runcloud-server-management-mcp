/**
 * core.ts — WordPress core update + checksum verification
 *
 * Reports current vs latest WP version, runs `wp core verify-checksums`,
 * and (gated) performs `wp core update`. Strongly recommends a backup
 * before applying.
 *
 * WP-CLI used:  wp core version  /  wp core check-update  /  wp core update
 *               wp core verify-checksums
 */

import { SSHOptions, wpCli } from '../../core/ssh-enhanced.js';

export interface CoreStatusResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateType: 'major' | 'minor' | 'patch' | null;
  checksumMismatches: number;
  recommendations: string[];
}

export interface CoreUpdateResult {
  applied: boolean;
  fromVersion: string;
  toVersion: string | null;
  output: string;
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

function compareVersions(a: string, b: string): 'major' | 'minor' | 'patch' | 'same' {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  if (pa[0] !== pb[0]) return 'major';
  if ((pa[1] ?? 0) !== (pb[1] ?? 0)) return 'minor';
  if ((pa[2] ?? 0) !== (pb[2] ?? 0)) return 'patch';
  return 'same';
}

export async function getCoreStatus(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<CoreStatusResult> {
  safe(wpPath);

  const cur = await wpCli(sshOpts, wpPath, wpUser, `core version 2>/dev/null`);
  const currentVersion = cur.stdout.trim();

  const upd = await wpCli(sshOpts, wpPath, wpUser, `core check-update --format=json 2>/dev/null`);
  let latestVersion: string | null = null;
  let updateAvailable = false;
  try {
    const arr = JSON.parse(upd.stdout) as Array<{ version: string }>;
    if (Array.isArray(arr) && arr.length > 0) {
      latestVersion = arr[0].version;
      updateAvailable = true;
    }
  } catch { /* none available */ }

  const updateType = (latestVersion && currentVersion)
    ? (compareVersions(currentVersion, latestVersion) === 'same' ? null : compareVersions(currentVersion, latestVersion))
    : null;

  // Checksum verify (best-effort)
  const sums = await wpCli(sshOpts, wpPath, wpUser, `core verify-checksums 2>&1`);
  const checksumMismatches =
    (sums.stderr.match(/File doesn't verify against checksum/g) ?? []).length +
    (sums.stderr.match(/File should be deleted/g) ?? []).length +
    (sums.stderr.match(/File is missing/g) ?? []).length;

  const recommendations: string[] = [];
  if (updateAvailable) {
    recommendations.push(
      `WordPress ${latestVersion} available (current ${currentVersion}, ${updateType} update). ` +
      `Backup first, then run wp.core_update with confirm:true.`,
    );
  }
  if (checksumMismatches > 0) {
    recommendations.push(
      `${checksumMismatches} core file(s) failed checksum verification — see wp.scan_malware for details before updating.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push(`WP ${currentVersion} is current and core integrity verified.`);
  }

  return {
    currentVersion: currentVersion || 'unknown',
    latestVersion,
    updateAvailable,
    updateType: updateType === 'same' ? null : updateType,
    checksumMismatches,
    recommendations,
  };
}

export async function applyCoreUpdate(
  sshOpts: SSHOptions, wpPath: string, wpUser: string, apply: boolean,
): Promise<CoreUpdateResult> {
  safe(wpPath);
  const status = await getCoreStatus(sshOpts, wpPath, wpUser);
  if (!status.updateAvailable) {
    return {
      applied: false,
      fromVersion: status.currentVersion,
      toVersion: null,
      output: 'No update available.',
    };
  }
  if (status.checksumMismatches > 0) {
    throw new Error(
      `${status.checksumMismatches} core file(s) failed checksum verification — fix integrity before updating. Run wp.scan_malware.`,
    );
  }
  if (!apply) {
    return {
      applied: false,
      fromVersion: status.currentVersion,
      toVersion: status.latestVersion,
      output: '[dry-run] would apply core update',
    };
  }

  const r = await wpCli(
    { ...sshOpts, timeoutMs: 600_000 }, wpPath, wpUser,
    `core update 2>&1`,
  );
  return {
    applied: true,
    fromVersion: status.currentVersion,
    toVersion: status.latestVersion,
    output: r.stdout.slice(0, 1000),
  };
}
