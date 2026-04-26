import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { safeForOutput } from "./redact.js";

// ─── INTERFACES ───────────────────────────────────────────────────────────────

export interface ServerRecord {
  hostname: string;
  ip: string;
  os?: string;
  nginx_version?: string;
  php_versions?: string[];       // stored as JSON
  runcloud_server_id?: number;
  baseline?: Record<string, unknown>; // stored as JSON
}

export type WebappType = "wordpress" | "laravel" | "node" | "n8n" | "docker" | "static" | "unknown";

export interface WebappRecord {
  server_id: number;
  domain: string;
  type?: WebappType;
  webroot?: string;
  php_version?: string;
  system_user?: string;
  runcloud_webapp_id?: number;
  stack?: Record<string, unknown>; // stored as JSON
}

export interface WordPressProfile {
  webapp_id: number;
  wp_version?: string;
  theme?: string;
  active_plugins?: PluginEntry[];   // stored as JSON
  db_size_kb?: number;
  autoload_size_kb?: number;
  transient_count?: number;
  object_cache_connected?: boolean;
  wp_cron_healthy?: boolean;
  last_plugin_audit?: string;       // ISO timestamp
  last_security_audit?: string;
  last_image_optimization?: string;
}

export interface PluginEntry {
  slug: string;
  version: string;
  last_updated?: string;
}

export interface ProblemType
  extends String {}

export interface Problem {
  id?: number;
  server_id?: number;
  webapp_id?: number;
  detected_at?: string;
  resolved_at?: string;
  type: string;
  root_cause: string;
  fix_applied?: string;
  fix_worked?: boolean;
  raw_log_snippet?: string;
}

export interface ProblemInput {
  server_id?: number;
  webapp_id?: number;
  type: string;
  root_cause: string;
  fix_applied?: string;
  fix_worked?: boolean;
  raw_log_snippet?: string;
}

export interface VulnEntry {
  cve: string;
  cvss: number;
  fixed_in_version: string;
  severity: "low" | "medium" | "high" | "critical";
}

export interface PluginRegistryData {
  latest_version_known?: string;
  known_vulnerabilities?: VulnEntry[]; // stored as JSON
}

export interface KnowledgeEntry {
  id?: number;
  pattern: string;
  seen_count: number;
  last_seen: string;
  known_causes: string[];  // stored as JSON
  known_fixes: string[];   // stored as JSON
  confidence_score: number;
}

export interface BrainSummary {
  server_count: number;
  webapp_count: number;
  problem_count: number;
  unresolved_problems: number;
  top_problem_types: Array<{ type: string; count: number }>;
  top_patterns: Array<{ pattern: string; seen_count: number; confidence_score: number }>;
  servers: Array<{ id: number; hostname: string; ip: string; webapp_count: number }>;
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = join(homedir(), ".perch", "brain.db");

export function initBrain(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      hostname           TEXT NOT NULL,
      ip                 TEXT NOT NULL,
      os                 TEXT,
      nginx_version      TEXT,
      php_versions       TEXT,          -- JSON array
      runcloud_server_id INTEGER UNIQUE,
      first_seen         TEXT NOT NULL DEFAULT (datetime('now')),
      last_scanned       TEXT NOT NULL DEFAULT (datetime('now')),
      baseline           TEXT,          -- JSON object
      UNIQUE(hostname, ip)
    );

    CREATE TABLE IF NOT EXISTS webapps (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id          INTEGER NOT NULL REFERENCES servers(id),
      domain             TEXT NOT NULL,
      type               TEXT DEFAULT 'unknown',
      webroot            TEXT,
      php_version        TEXT,
      system_user        TEXT,
      runcloud_webapp_id INTEGER UNIQUE,
      stack              TEXT,          -- JSON object
      first_seen         TEXT NOT NULL DEFAULT (datetime('now')),
      last_scanned       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(server_id, domain)
    );

    CREATE TABLE IF NOT EXISTS wordpress_profiles (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      webapp_id              INTEGER NOT NULL UNIQUE REFERENCES webapps(id),
      wp_version             TEXT,
      theme                  TEXT,
      active_plugins         TEXT,      -- JSON array of {slug, version, last_updated}
      db_size_kb             INTEGER,
      autoload_size_kb       INTEGER,
      transient_count        INTEGER,
      object_cache_connected INTEGER,   -- 0/1
      wp_cron_healthy        INTEGER,   -- 0/1
      last_plugin_audit      TEXT,
      last_security_audit    TEXT,
      last_image_optimization TEXT
    );

    CREATE TABLE IF NOT EXISTS problems (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id        INTEGER REFERENCES servers(id),
      webapp_id        INTEGER REFERENCES webapps(id),
      detected_at      TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at      TEXT,
      type             TEXT NOT NULL,
      root_cause       TEXT NOT NULL,
      fix_applied      TEXT,
      fix_worked       INTEGER,         -- 0/1/NULL
      raw_log_snippet  TEXT
    );

    CREATE TABLE IF NOT EXISTS plugin_registry (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      slug                 TEXT NOT NULL UNIQUE,
      latest_version_known TEXT,
      known_vulnerabilities TEXT,       -- JSON array of {cve, cvss, fixed_in_version, severity}
      last_checked         TEXT NOT NULL DEFAULT (datetime('now')),
      flagged_count        INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS knowledge (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern          TEXT NOT NULL UNIQUE,
      seen_count       INTEGER NOT NULL DEFAULT 1,
      last_seen        TEXT NOT NULL DEFAULT (datetime('now')),
      known_causes     TEXT NOT NULL DEFAULT '[]',  -- JSON array
      known_fixes      TEXT NOT NULL DEFAULT '[]',  -- JSON array
      confidence_score REAL NOT NULL DEFAULT 0.0
    );

    CREATE INDEX IF NOT EXISTS idx_problems_server ON problems(server_id);
    CREATE INDEX IF NOT EXISTS idx_problems_webapp  ON problems(webapp_id);
    CREATE INDEX IF NOT EXISTS idx_problems_type    ON problems(type);
    CREATE INDEX IF NOT EXISTS idx_webapps_server   ON webapps(server_id);
    CREATE INDEX IF NOT EXISTS idx_webapps_domain   ON webapps(domain);

    -- Action log for undo + audit (every destructive op records here)
    CREATE TABLE IF NOT EXISTS actions_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT NOT NULL DEFAULT (datetime('now')),
      action_type  TEXT NOT NULL,            -- e.g., wp_plugin_deactivate
      target       TEXT,                      -- domain or server identifier
      args         TEXT NOT NULL DEFAULT '{}',-- JSON of inputs
      before_state TEXT,                      -- JSON of pre-action state (for undo)
      result       TEXT,                      -- JSON of result
      ok           INTEGER NOT NULL DEFAULT 1,
      undone       INTEGER NOT NULL DEFAULT 0,
      undone_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions_log(ts DESC);

    -- FTS5 mirror for fast search across problems (root_cause + raw_log_snippet)
    CREATE VIRTUAL TABLE IF NOT EXISTS problems_fts USING fts5(
      root_cause, raw_log_snippet,
      content='problems', content_rowid='id'
    );
    -- Triggers keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS problems_fts_ai AFTER INSERT ON problems BEGIN
      INSERT INTO problems_fts(rowid, root_cause, raw_log_snippet)
      VALUES (new.id, new.root_cause, coalesce(new.raw_log_snippet, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS problems_fts_ad AFTER DELETE ON problems BEGIN
      INSERT INTO problems_fts(problems_fts, rowid, root_cause, raw_log_snippet)
      VALUES ('delete', old.id, old.root_cause, coalesce(old.raw_log_snippet, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS problems_fts_au AFTER UPDATE ON problems BEGIN
      INSERT INTO problems_fts(problems_fts, rowid, root_cause, raw_log_snippet)
      VALUES ('delete', old.id, old.root_cause, coalesce(old.raw_log_snippet, ''));
      INSERT INTO problems_fts(rowid, root_cause, raw_log_snippet)
      VALUES (new.id, new.root_cause, coalesce(new.raw_log_snippet, ''));
    END;
  `);

  return db;
}

// ─── ACTIONS LOG (undo + audit trail) ─────────────────────────────────────────

export interface ActionLogInput {
  action_type: string;
  target?: string;
  args?: Record<string, unknown>;
  before_state?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  ok?: boolean;
}

export interface ActionLogEntry {
  id: number;
  ts: string;
  action_type: string;
  target: string | null;
  args: Record<string, unknown>;
  before_state: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  ok: boolean;
  undone: boolean;
  undone_at: string | null;
}

export function logAction(db: Database.Database, data: ActionLogInput): number {
  const stmt = db.prepare(`
    INSERT INTO actions_log (action_type, target, args, before_state, result, ok)
    VALUES (@action_type, @target, @args, @before_state, @result, @ok)
    RETURNING id
  `);
  const row = stmt.get({
    action_type: data.action_type,
    target: data.target ?? null,
    args: JSON.stringify(safeForOutput(JSON.stringify(data.args ?? {}))),
    before_state: data.before_state ? JSON.stringify(data.before_state) : null,
    result: data.result ? JSON.stringify(data.result) : null,
    ok: (data.ok ?? true) ? 1 : 0,
  }) as { id: number };
  return row.id;
}

export function getRecentActions(db: Database.Database, limit = 10): ActionLogEntry[] {
  const rows = db.prepare(`SELECT * FROM actions_log ORDER BY ts DESC LIMIT ?`).all(limit) as Array<{
    id: number; ts: string; action_type: string; target: string | null;
    args: string; before_state: string | null; result: string | null;
    ok: number; undone: number; undone_at: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id, ts: r.ts, action_type: r.action_type, target: r.target,
    args: JSON.parse(r.args || "{}"),
    before_state: r.before_state ? JSON.parse(r.before_state) : null,
    result: r.result ? JSON.parse(r.result) : null,
    ok: r.ok === 1, undone: r.undone === 1, undone_at: r.undone_at,
  }));
}

export function getActionForUndo(db: Database.Database, actionId?: number): ActionLogEntry | null {
  const sql = actionId
    ? `SELECT * FROM actions_log WHERE id = ? AND undone = 0`
    : `SELECT * FROM actions_log WHERE undone = 0 ORDER BY ts DESC LIMIT 1`;
  const row = (actionId ? db.prepare(sql).get(actionId) : db.prepare(sql).get()) as
    | { id: number; ts: string; action_type: string; target: string | null;
        args: string; before_state: string | null; result: string | null;
        ok: number; undone: number; undone_at: string | null; }
    | undefined;
  if (!row) return null;
  return {
    id: row.id, ts: row.ts, action_type: row.action_type, target: row.target,
    args: JSON.parse(row.args || "{}"),
    before_state: row.before_state ? JSON.parse(row.before_state) : null,
    result: row.result ? JSON.parse(row.result) : null,
    ok: row.ok === 1, undone: row.undone === 1, undone_at: row.undone_at,
  };
}

export function markActionUndone(db: Database.Database, actionId: number): void {
  db.prepare(`UPDATE actions_log SET undone = 1, undone_at = datetime('now') WHERE id = ?`).run(actionId);
}

// ─── PROBLEMS SEARCH (FTS5-backed) ───────────────────────────────────────────

export interface ProblemSearchHit {
  id: number;
  ts: string;
  type: string;
  root_cause: string;
  fix_applied: string | null;
  fix_worked: boolean | null;
  domain: string | null;
}

export function searchProblems(db: Database.Database, query: string, limit = 20): ProblemSearchHit[] {
  // FTS5 sometimes errors on bare colons / dashes — sanitize to prefix words.
  const safe = query.replace(/[^\w\s]/g, " ").trim();
  if (!safe) return [];
  const ftsQuery = safe.split(/\s+/).map((w) => `${w}*`).join(" ");
  const rows = db.prepare(`
    SELECT p.id, p.detected_at AS ts, p.type, p.root_cause, p.fix_applied, p.fix_worked,
           w.domain
    FROM problems_fts f
    JOIN problems p ON p.id = f.rowid
    LEFT JOIN webapps w ON w.id = p.webapp_id
    WHERE problems_fts MATCH ?
    ORDER BY p.detected_at DESC
    LIMIT ?
  `).all(ftsQuery, limit) as Array<{
    id: number; ts: string; type: string; root_cause: string;
    fix_applied: string | null; fix_worked: number | null; domain: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id, ts: r.ts, type: r.type, root_cause: r.root_cause,
    fix_applied: r.fix_applied,
    fix_worked: r.fix_worked === null ? null : r.fix_worked === 1,
    domain: r.domain,
  }));
}

// ─── SERVER ───────────────────────────────────────────────────────────────────

export function upsertServer(db: Database.Database, data: ServerRecord): number {
  const stmt = db.prepare(`
    INSERT INTO servers (hostname, ip, os, nginx_version, php_versions, runcloud_server_id, baseline, last_scanned)
    VALUES (@hostname, @ip, @os, @nginx_version, @php_versions, @runcloud_server_id, @baseline, datetime('now'))
    ON CONFLICT(hostname, ip) DO UPDATE SET
      os                 = excluded.os,
      nginx_version      = excluded.nginx_version,
      php_versions       = excluded.php_versions,
      runcloud_server_id = coalesce(excluded.runcloud_server_id, runcloud_server_id),
      baseline           = coalesce(excluded.baseline, baseline),
      last_scanned       = datetime('now')
    RETURNING id
  `);

  const row = stmt.get({
    hostname: data.hostname,
    ip: data.ip,
    os: data.os ?? null,
    nginx_version: data.nginx_version ?? null,
    php_versions: data.php_versions ? JSON.stringify(data.php_versions) : null,
    runcloud_server_id: data.runcloud_server_id ?? null,
    baseline: data.baseline ? JSON.stringify(data.baseline) : null,
  }) as { id: number };

  return row.id;
}

// ─── WEBAPP ───────────────────────────────────────────────────────────────────

export function upsertWebapp(db: Database.Database, data: WebappRecord): number {
  const stmt = db.prepare(`
    INSERT INTO webapps (server_id, domain, type, webroot, php_version, system_user, runcloud_webapp_id, stack, last_scanned)
    VALUES (@server_id, @domain, @type, @webroot, @php_version, @system_user, @runcloud_webapp_id, @stack, datetime('now'))
    ON CONFLICT(server_id, domain) DO UPDATE SET
      type               = coalesce(excluded.type, type),
      webroot            = coalesce(excluded.webroot, webroot),
      php_version        = coalesce(excluded.php_version, php_version),
      system_user        = coalesce(excluded.system_user, system_user),
      runcloud_webapp_id = coalesce(excluded.runcloud_webapp_id, runcloud_webapp_id),
      stack              = coalesce(excluded.stack, stack),
      last_scanned       = datetime('now')
    RETURNING id
  `);

  const row = stmt.get({
    server_id: data.server_id,
    domain: data.domain,
    type: data.type ?? "unknown",
    webroot: data.webroot ?? null,
    php_version: data.php_version ?? null,
    system_user: data.system_user ?? null,
    runcloud_webapp_id: data.runcloud_webapp_id ?? null,
    stack: data.stack ? JSON.stringify(data.stack) : null,
  }) as { id: number };

  return row.id;
}

// ─── WORDPRESS PROFILE ────────────────────────────────────────────────────────

export function upsertWordPressProfile(db: Database.Database, data: WordPressProfile): void {
  db.prepare(`
    INSERT INTO wordpress_profiles (
      webapp_id, wp_version, theme, active_plugins, db_size_kb, autoload_size_kb,
      transient_count, object_cache_connected, wp_cron_healthy,
      last_plugin_audit, last_security_audit, last_image_optimization
    ) VALUES (
      @webapp_id, @wp_version, @theme, @active_plugins, @db_size_kb, @autoload_size_kb,
      @transient_count, @object_cache_connected, @wp_cron_healthy,
      @last_plugin_audit, @last_security_audit, @last_image_optimization
    )
    ON CONFLICT(webapp_id) DO UPDATE SET
      wp_version             = coalesce(excluded.wp_version, wp_version),
      theme                  = coalesce(excluded.theme, theme),
      active_plugins         = coalesce(excluded.active_plugins, active_plugins),
      db_size_kb             = coalesce(excluded.db_size_kb, db_size_kb),
      autoload_size_kb       = coalesce(excluded.autoload_size_kb, autoload_size_kb),
      transient_count        = coalesce(excluded.transient_count, transient_count),
      object_cache_connected = coalesce(excluded.object_cache_connected, object_cache_connected),
      wp_cron_healthy        = coalesce(excluded.wp_cron_healthy, wp_cron_healthy),
      last_plugin_audit      = coalesce(excluded.last_plugin_audit, last_plugin_audit),
      last_security_audit    = coalesce(excluded.last_security_audit, last_security_audit),
      last_image_optimization = coalesce(excluded.last_image_optimization, last_image_optimization)
  `).run({
    webapp_id: data.webapp_id,
    wp_version: data.wp_version ?? null,
    theme: data.theme ?? null,
    active_plugins: data.active_plugins ? JSON.stringify(data.active_plugins) : null,
    db_size_kb: data.db_size_kb ?? null,
    autoload_size_kb: data.autoload_size_kb ?? null,
    transient_count: data.transient_count ?? null,
    object_cache_connected: data.object_cache_connected !== undefined ? (data.object_cache_connected ? 1 : 0) : null,
    wp_cron_healthy: data.wp_cron_healthy !== undefined ? (data.wp_cron_healthy ? 1 : 0) : null,
    last_plugin_audit: data.last_plugin_audit ?? null,
    last_security_audit: data.last_security_audit ?? null,
    last_image_optimization: data.last_image_optimization ?? null,
  });
}

// ─── PROBLEMS ─────────────────────────────────────────────────────────────────

export function logProblem(db: Database.Database, data: ProblemInput): number {
  const stmt = db.prepare(`
    INSERT INTO problems (server_id, webapp_id, type, root_cause, fix_applied, fix_worked, raw_log_snippet)
    VALUES (@server_id, @webapp_id, @type, @root_cause, @fix_applied, @fix_worked, @raw_log_snippet)
    RETURNING id
  `);

  // SECURITY [M6]: redact raw_log_snippet + root_cause before persisting.
  // brain.db sits unencrypted on disk; never let secrets land in it.
  const cleanRoot = safeForOutput(data.root_cause);
  const cleanSnippet = data.raw_log_snippet ? safeForOutput(data.raw_log_snippet) : null;

  const row = stmt.get({
    server_id: data.server_id ?? null,
    webapp_id: data.webapp_id ?? null,
    type: data.type,
    root_cause: cleanRoot,
    fix_applied: data.fix_applied ?? null,
    fix_worked: data.fix_worked !== undefined ? (data.fix_worked ? 1 : 0) : null,
    raw_log_snippet: cleanSnippet,
  }) as { id: number };

  return row.id;
}

export function resolveProblem(
  db: Database.Database,
  problemId: number,
  fixApplied: string,
  fixWorked: boolean
): void {
  db.prepare(`
    UPDATE problems
    SET resolved_at = datetime('now'), fix_applied = @fix_applied, fix_worked = @fix_worked
    WHERE id = @id
  `).run({ id: problemId, fix_applied: fixApplied, fix_worked: fixWorked ? 1 : 0 });
}

// ─── PLUGIN REGISTRY ──────────────────────────────────────────────────────────

export function updatePluginRegistry(
  db: Database.Database,
  slug: string,
  data: PluginRegistryData
): void {
  db.prepare(`
    INSERT INTO plugin_registry (slug, latest_version_known, known_vulnerabilities, last_checked, flagged_count)
    VALUES (@slug, @latest_version_known, @known_vulnerabilities, datetime('now'), @flagged_count)
    ON CONFLICT(slug) DO UPDATE SET
      latest_version_known  = coalesce(excluded.latest_version_known, latest_version_known),
      known_vulnerabilities = coalesce(excluded.known_vulnerabilities, known_vulnerabilities),
      last_checked          = datetime('now'),
      flagged_count         = flagged_count + @increment
  `).run({
    slug,
    latest_version_known: data.latest_version_known ?? null,
    known_vulnerabilities: data.known_vulnerabilities ? JSON.stringify(data.known_vulnerabilities) : null,
    flagged_count: data.known_vulnerabilities && data.known_vulnerabilities.length > 0 ? 1 : 0,
    increment: data.known_vulnerabilities && data.known_vulnerabilities.length > 0 ? 1 : 0,
  });
}

export function getPluginVulnerabilities(db: Database.Database, slug: string): VulnEntry[] {
  const row = db.prepare(`SELECT known_vulnerabilities FROM plugin_registry WHERE slug = ?`).get(slug) as
    | { known_vulnerabilities: string | null }
    | undefined;

  if (!row || !row.known_vulnerabilities) return [];
  return JSON.parse(row.known_vulnerabilities) as VulnEntry[];
}

// ─── KNOWLEDGE ────────────────────────────────────────────────────────────────

export function incrementKnowledge(
  db: Database.Database,
  pattern: string,
  cause: string,
  fix: string
): void {
  const existing = db.prepare(`SELECT * FROM knowledge WHERE pattern = ?`).get(pattern) as
    | {
        seen_count: number;
        known_causes: string;
        known_fixes: string;
        confidence_score: number;
      }
    | undefined;

  if (!existing) {
    db.prepare(`
      INSERT INTO knowledge (pattern, seen_count, last_seen, known_causes, known_fixes, confidence_score)
      VALUES (@pattern, 1, datetime('now'), @known_causes, @known_fixes, 0.1)
    `).run({
      pattern,
      known_causes: JSON.stringify([cause]),
      known_fixes: JSON.stringify([fix]),
    });
    return;
  }

  const causes: string[] = JSON.parse(existing.known_causes);
  const fixes: string[] = JSON.parse(existing.known_fixes);

  if (!causes.includes(cause)) causes.push(cause);
  if (!fixes.includes(fix)) fixes.push(fix);

  const newCount = existing.seen_count + 1;
  // Confidence grows with observations, capped at 0.95
  const confidence = Math.min(0.95, 0.1 + (newCount - 1) * 0.05);

  db.prepare(`
    UPDATE knowledge
    SET seen_count = @seen_count, last_seen = datetime('now'),
        known_causes = @known_causes, known_fixes = @known_fixes,
        confidence_score = @confidence_score
    WHERE pattern = @pattern
  `).run({
    pattern,
    seen_count: newCount,
    known_causes: JSON.stringify(causes),
    known_fixes: JSON.stringify(fixes),
    confidence_score: confidence,
  });
}

export function getKnowledge(db: Database.Database, pattern: string): KnowledgeEntry | null {
  const row = db.prepare(`SELECT * FROM knowledge WHERE pattern = ?`).get(pattern) as
    | {
        id: number;
        pattern: string;
        seen_count: number;
        last_seen: string;
        known_causes: string;
        known_fixes: string;
        confidence_score: number;
      }
    | undefined;

  if (!row) return null;

  return {
    id: row.id,
    pattern: row.pattern,
    seen_count: row.seen_count,
    last_seen: row.last_seen,
    known_causes: JSON.parse(row.known_causes) as string[],
    known_fixes: JSON.parse(row.known_fixes) as string[],
    confidence_score: row.confidence_score,
  };
}

// ─── HISTORY / QUERIES ────────────────────────────────────────────────────────

export function getWebappHistory(db: Database.Database, domain: string): Problem[] {
  const webapp = db.prepare(`SELECT id FROM webapps WHERE domain = ?`).get(domain) as
    | { id: number }
    | undefined;

  if (!webapp) return [];

  const rows = db.prepare(`
    SELECT * FROM problems WHERE webapp_id = ? ORDER BY detected_at DESC LIMIT 100
  `).all(webapp.id) as Array<{
    id: number;
    server_id: number | null;
    webapp_id: number | null;
    detected_at: string;
    resolved_at: string | null;
    type: string;
    root_cause: string;
    fix_applied: string | null;
    fix_worked: number | null;
    raw_log_snippet: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    server_id: r.server_id ?? undefined,
    webapp_id: r.webapp_id ?? undefined,
    detected_at: r.detected_at,
    resolved_at: r.resolved_at ?? undefined,
    type: r.type,
    root_cause: r.root_cause,
    fix_applied: r.fix_applied ?? undefined,
    fix_worked: r.fix_worked !== null ? Boolean(r.fix_worked) : undefined,
    raw_log_snippet: r.raw_log_snippet ?? undefined,
  }));
}

export function getBrain(db: Database.Database): BrainSummary {
  const server_count = (db.prepare(`SELECT count(*) as c FROM servers`).get() as { c: number }).c;
  const webapp_count = (db.prepare(`SELECT count(*) as c FROM webapps`).get() as { c: number }).c;
  const problem_count = (db.prepare(`SELECT count(*) as c FROM problems`).get() as { c: number }).c;
  const unresolved_problems = (
    db.prepare(`SELECT count(*) as c FROM problems WHERE resolved_at IS NULL`).get() as { c: number }
  ).c;

  const top_problem_types = db
    .prepare(`SELECT type, count(*) as count FROM problems GROUP BY type ORDER BY count DESC LIMIT 10`)
    .all() as Array<{ type: string; count: number }>;

  const top_patterns = db
    .prepare(
      `SELECT pattern, seen_count, confidence_score FROM knowledge ORDER BY seen_count DESC LIMIT 10`
    )
    .all() as Array<{ pattern: string; seen_count: number; confidence_score: number }>;

  const servers = db
    .prepare(`
      SELECT s.id, s.hostname, s.ip,
             (SELECT count(*) FROM webapps w WHERE w.server_id = s.id) as webapp_count
      FROM servers s
      ORDER BY s.hostname
    `)
    .all() as Array<{ id: number; hostname: string; ip: string; webapp_count: number }>;

  return {
    server_count,
    webapp_count,
    problem_count,
    unresolved_problems,
    top_problem_types,
    top_patterns,
    servers,
  };
}
