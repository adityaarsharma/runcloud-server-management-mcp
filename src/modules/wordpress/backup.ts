/**
 * backup.ts — Backup Health Check
 *
 * Scans RunCloud backup logs and common backup locations to determine
 * when the last backup ran, whether it was complete, and what its size was.
 */

import { SSHOptions, sshExec } from '../../core/ssh-enhanced.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface BackupHealthResult {
  lastBackupTime: Date | null;
  lastBackupAgeHours: number | null;
  lastBackupSizeGb: number | null;
  /** False if log indicates a failed/truncated backup */
  backupComplete: boolean;
  dbBackupIncluded: boolean;
  remoteDestinationReachable: boolean | null;
  retentionDays: number | null;
  nextScheduled: Date | null;
  issues: string[];
  status: 'healthy' | 'warning' | 'critical';
  summary: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseBytes(raw: string): number {
  const m = raw.trim().match(/^([\d.]+)\s*([KMGT]?)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? '').toUpperCase();
  const multipliers: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return n * (multipliers[unit] ?? 1);
}

function ageHours(d: Date): number {
  return (Date.now() - d.getTime()) / (1000 * 60 * 60);
}

function classifyStatus(
  ageHours: number | null,
  complete: boolean,
  dbIncluded: boolean
): 'healthy' | 'warning' | 'critical' {
  if (!complete) return 'critical';
  if (ageHours === null || ageHours > 48) return 'critical';
  if (ageHours > 25) return 'warning';
  if (!dbIncluded) return 'warning';
  return 'healthy';
}

// ─── Backup log discovery ────────────────────────────────────────────────────

const BACKUP_LOG_PATTERNS = [
  '/var/log/runcloud/backup*.log',
  '/var/log/runcloud/*.backup.log',
  '/home/*/logs/backup*.log',
  '/home/*/logs/*.backup*',
  '/var/log/runcloud-backup.log',
];

const BACKUP_FILE_PATTERNS = [
  '/home/*/backup/*.tar.gz',
  '/home/*/backup/*.zip',
  '/home/*/.runcloud/backup/*',
  '/root/backup/*',
  '/tmp/runcloud-backup-*',
];

async function findRecentLogEntry(
  sshOpts: SSHOptions,
  patterns: string[]
): Promise<{ raw: string; filePath: string } | null> {
  for (const pattern of patterns) {
    const res = await sshExec(
      sshOpts,
      `ls -t ${pattern} 2>/dev/null | head -3`
    );
    if (res.code !== 0 || !res.stdout.trim()) continue;

    const files = res.stdout.trim().split('\n').filter(Boolean);
    for (const file of files) {
      const logRes = await sshExec(
        sshOpts,
        `tail -200 ${file} 2>/dev/null`
      );
      if (logRes.code === 0 && logRes.stdout.trim()) {
        return { raw: logRes.stdout, filePath: file };
      }
    }
  }
  return null;
}

async function findRecentBackupFile(
  sshOpts: SSHOptions,
  webroot: string
): Promise<{ path: string; sizeBytes: number; mtime: Date } | null> {
  // Check both common locations and the webroot's parent directory
  const allPatterns = [
    ...BACKUP_FILE_PATTERNS,
    `${webroot}/../backup/*`,
    `${webroot}/../../backup/*`,
  ];

  for (const pattern of allPatterns) {
    const res = await sshExec(
      sshOpts,
      // ls -l --time-style=+%s for epoch, then sort by mtime desc
      `ls -lt --time-style=+%s ${pattern} 2>/dev/null | head -5`
    );
    if (res.code !== 0 || !res.stdout.trim()) continue;

    const lines = res.stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      // Format: perms links owner group size epoch name...
      if (parts.length < 8) continue;
      const sizeStr = parts[4] ?? '0';
      const epochStr = parts[5] ?? '0';
      const filePath = parts.slice(6).join(' ');
      const epoch = parseInt(epochStr, 10);
      const sizeBytes = parseInt(sizeStr, 10);

      if (isNaN(epoch) || epoch <= 0) continue;
      return {
        path: filePath,
        sizeBytes,
        mtime: new Date(epoch * 1000),
      };
    }
  }
  return null;
}

// ─── Parse backup log for metadata ───────────────────────────────────────────

interface ParsedLog {
  lastRunTime: Date | null;
  complete: boolean;
  dbIncluded: boolean;
  retentionDays: number | null;
  nextScheduled: Date | null;
  issues: string[];
}

function parseBackupLog(raw: string): ParsedLog {
  const issues: string[] = [];
  let lastRunTime: Date | null = null;
  let complete = false;
  let dbIncluded = false;
  let retentionDays: number | null = null;
  let nextScheduled: Date | null = null;

  const lines = raw.split('\n');

  for (const line of lines) {
    // Common timestamp formats in RunCloud logs
    const tsMatch = line.match(
      /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/
    );
    if (tsMatch) {
      const d = new Date(tsMatch[1]);
      if (!isNaN(d.getTime())) {
        if (!lastRunTime || d > lastRunTime) lastRunTime = d;
      }
    }

    const lower = line.toLowerCase();

    if (lower.includes('backup completed') || lower.includes('backup done') || lower.includes('success')) {
      complete = true;
    }

    if (lower.includes('failed') || lower.includes('error') || lower.includes('fatal')) {
      complete = false;
      issues.push(line.trim().slice(0, 200));
    }

    if (lower.includes('database') || lower.includes('mysqldump') || lower.includes('.sql')) {
      dbIncluded = true;
    }

    const retMatch = line.match(/retention[:\s]+(\d+)\s*days?/i);
    if (retMatch) retentionDays = parseInt(retMatch[1], 10);

    const nextMatch = line.match(/next\s+(?:backup\s+)?(?:scheduled\s+)?(?:at|:)?\s*(.{10,30})/i);
    if (nextMatch) {
      const d = new Date(nextMatch[1].trim());
      if (!isNaN(d.getTime())) nextScheduled = d;
    }
  }

  return { lastRunTime, complete, dbIncluded, retentionDays, nextScheduled, issues };
}

// ─── Remote destination check ─────────────────────────────────────────────────

async function checkRemoteDestination(
  sshOpts: SSHOptions
): Promise<boolean | null> {
  // Look for S3/FTP/Rclone config in runcloud backup configs
  const configRes = await sshExec(
    sshOpts,
    `cat /etc/runcloud/backup.conf 2>/dev/null || cat /etc/runcloud-backup.json 2>/dev/null || echo ""`
  );

  if (!configRes.stdout.trim()) return null;

  const conf = configRes.stdout.toLowerCase();

  // Check for S3 bucket reachability
  if (conf.includes('s3') || conf.includes('aws')) {
    const s3Res = await sshExec(
      sshOpts,
      `aws s3 ls 2>/dev/null | head -1 || echo "unreachable"`
    );
    return s3Res.code === 0 && !s3Res.stdout.includes('unreachable');
  }

  // Check for FTP destination
  if (conf.includes('ftp')) {
    const ftpHost = conf.match(/(?:ftp_host|ftphost)["\s:=]+([^\s"']+)/)?.[1];
    if (ftpHost) {
      const pingRes = await sshExec(sshOpts, `ping -c 1 -W 3 ${ftpHost} 2>/dev/null`);
      return pingRes.code === 0;
    }
  }

  return null;
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function checkBackupHealth(
  sshOpts: SSHOptions,
  webroot: string,
  _domain: string
): Promise<BackupHealthResult> {
  const issues: string[] = [];

  // Run log and file discovery concurrently
  const [logEntry, backupFile, remoteReachable] = await Promise.all([
    findRecentLogEntry(sshOpts, BACKUP_LOG_PATTERNS),
    findRecentBackupFile(sshOpts, webroot),
    checkRemoteDestination(sshOpts),
  ]);

  let lastBackupTime: Date | null = null;
  let lastBackupSizeGb: number | null = null;
  let backupComplete = false;
  let dbBackupIncluded = false;
  let retentionDays: number | null = null;
  let nextScheduled: Date | null = null;

  // Parse log if found
  if (logEntry) {
    const parsed = parseBackupLog(logEntry.raw);
    lastBackupTime = parsed.lastRunTime;
    backupComplete = parsed.complete;
    dbBackupIncluded = parsed.dbIncluded;
    retentionDays = parsed.retentionDays;
    nextScheduled = parsed.nextScheduled;
    issues.push(...parsed.issues.slice(0, 5));
  }

  // Use most recent backup file as fallback/confirmation
  if (backupFile) {
    if (!lastBackupTime || backupFile.mtime > lastBackupTime) {
      lastBackupTime = backupFile.mtime;
    }
    lastBackupSizeGb = backupFile.sizeBytes / (1024 ** 3);

    // Flag suspiciously small backups (< 1 MB) for non-trivial sites
    if (backupFile.sizeBytes < 1_048_576) {
      issues.push(`Backup file is only ${(backupFile.sizeBytes / 1024).toFixed(0)} KB — may be incomplete.`);
      backupComplete = false;
    } else if (!logEntry) {
      // No log found but file exists — assume complete
      backupComplete = true;
    }

    // Infer DB inclusion from file name
    if (!dbBackupIncluded) {
      dbBackupIncluded = /db|sql|database/i.test(backupFile.path);
    }
  }

  if (!logEntry && !backupFile) {
    issues.push('No backup logs or backup files found in common locations.');
  }

  const lastBackupAgeHours = lastBackupTime ? ageHours(lastBackupTime) : null;

  if (lastBackupAgeHours !== null && lastBackupAgeHours > 48) {
    issues.push(`Last backup is ${Math.round(lastBackupAgeHours)} hours old — older than 48-hour threshold.`);
  }

  if (!dbBackupIncluded) {
    issues.push('Database backup not detected — ensure db dump is included in backup.');
  }

  const status = classifyStatus(lastBackupAgeHours, backupComplete, dbBackupIncluded);

  const ageLabel = lastBackupAgeHours !== null
    ? `${Math.round(lastBackupAgeHours)}h ago`
    : 'unknown';

  const summary = `Last backup: ${ageLabel} | Status: ${status} | DB: ${dbBackupIncluded ? 'yes' : 'no'} | Complete: ${backupComplete ? 'yes' : 'no'}`;

  return {
    lastBackupTime,
    lastBackupAgeHours,
    lastBackupSizeGb,
    backupComplete,
    dbBackupIncluded,
    remoteDestinationReachable: remoteReachable,
    retentionDays,
    nextScheduled,
    issues,
    status,
    summary,
  };
}
