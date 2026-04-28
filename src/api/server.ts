#!/usr/bin/env node
/**
 * Perch HTTP API
 *
 * Bearer-authenticated HTTP wrapper that exposes Perch's MCP tools as
 * `POST /api/<tool_name>` endpoints. Designed for external integrations
 * (Niyati, n8n, Make.com, custom dashboards) that need Perch intelligence
 * over HTTPS.
 *
 * Security:
 * - Binds to 127.0.0.1 by default (override with PERCH_API_HOST)
 * - Bearer token from PERCH_API_TOKEN env var (required, no default)
 * - Per-IP rate limit: 60 req/min (sliding window)
 * - Allowlist enforced — only tools in ALLOWED_TOOLS responded to
 * - Body size cap: 64KB
 *
 * Endpoints:
 *   GET  /health                 — liveness
 *   GET  /api/tools              — list of allowed tools + their schemas
 *   POST /api/<tool>             — invoke a tool with JSON body { args: {...} }
 *
 * Run as a system service:
 *   ExecStart=node dist/api/server.js
 *   EnvironmentFile=$PERCH_HOME/.env
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { initBrain, getBrain, getWebappHistory, incrementKnowledge, logProblem, logAction, appendConversation, getRecentConversation, type ConversationTurn } from "../core/brain.js";
import { vaultGet, vaultList } from "../core/vault.js";
import { safeForOutput, safeTruncate } from "../core/redact.js";
import { sshExec, wpCli, detectWebappType } from "../core/ssh-enhanced.js";
import { auditDatabase, cleanTransients } from "../modules/stack/wordpress/cleanup/db.js";
import { auditPlugins } from "../modules/stack/wordpress/security/plugins.js";
import { auditSecurity } from "../modules/stack/wordpress/security/security.js";
import { checkBackupHealth } from "../modules/stack/wordpress/operations/backup.js";
import { scanImages, optimizeImages } from "../modules/stack/wordpress/performance/images.js";
import {
  startBulkCompression,
  getBulkCompressionStatus,
  cancelBulkCompression,
  listBulkCompressionJobs,
  cleanupBulkCompression,
} from "../modules/stack/wordpress/performance/images-bulk.js";
import { snapshotPerformance } from "../modules/stack/wordpress/performance/perf.js";
import { diagnoseErrors } from "../modules/stack/wordpress/diagnostics/errors.js";
import { auditDisk } from "../modules/stack/wordpress/diagnostics/disk.js";
import { scanMalware } from "../modules/stack/wordpress/security/malware.js";
import { auditThumbnails, cleanThumbnails } from "../modules/stack/wordpress/performance/thumbnails.js";
import { profilePlugins } from "../modules/stack/wordpress/performance/plugins-perf.js";
import { auditUnusedPlugins, applyPluginCleanup } from "../modules/stack/wordpress/cleanup/plugins-cleanup.js";
import { auditMediaOrphans } from "../modules/stack/wordpress/cleanup/media-orphans.js";
import { auditRevisions, cleanRevisions } from "../modules/stack/wordpress/cleanup/revisions.js";
import { auditTranslations, cleanTranslations } from "../modules/stack/wordpress/cleanup/translations.js";
import { auditHtaccess } from "../modules/stack/wordpress/security/htaccess.js";
import { getCoreStatus, applyCoreUpdate } from "../modules/stack/wordpress/operations/core.js";
import { searchReplace } from "../modules/stack/wordpress/operations/search-replace.js";
import { auditCron, runCronEvents, flushRewrites } from "../modules/stack/wordpress/operations/cron.js";
import { auditSsl } from "../modules/stack/wordpress/security/ssl.js";
import { auditWpConfig } from "../modules/stack/wordpress/security/wp-config.js";
import { auditMultisite } from "../modules/stack/wordpress/operations/multisite.js";
import { testEmail } from "../modules/stack/wordpress/operations/email-test.js";
import { auditCaching } from "../modules/stack/wordpress/performance/caching.js";
import { auditWooCommerce } from "../modules/stack/wordpress/plugins/woocommerce.js";
import { auditYoast } from "../modules/stack/wordpress/plugins/yoast.js";
import { runLighthouse } from "../modules/stack/wordpress/performance/lighthouse.js";
import { buildRecommendations } from "../modules/stack/wordpress/recommend.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const HOST  = process.env.PERCH_API_HOST  || "127.0.0.1";
const PORT  = parseInt(process.env.PERCH_API_PORT || "3012", 10);
const TOKEN = process.env.PERCH_API_TOKEN || "";

if (!TOKEN) {
  console.error("FATAL: PERCH_API_TOKEN env var is required.");
  console.error("  Generate: openssl rand -hex 32");
  console.error("  Add to ~/.perch/.env, then restart.");
  process.exit(1);
}
if (!process.env.PERCH_MASTER_KEY) {
  console.error("FATAL: PERCH_MASTER_KEY env var is required.");
  process.exit(1);
}

const MAX_BODY = 64 * 1024; // 64 KB

// Initialize the brain — shared with the MCP process if running side-by-side
const brain = initBrain();

// ─── Tool registry ───────────────────────────────────────────────────────────
//
// Map of allowed external tool names → handler functions.
// Each handler receives parsed args and returns a JSON-serialisable result.
// Tools that are dangerous or that mutate state should require explicit args
// AND log to the brain via logProblem/incrementKnowledge.

interface SshAuthArgs {
  host: string;
  username: string;
  password?: string;
  privateKey?: string;
  vaultId?: string;
}

function buildSshOpts(args: SshAuthArgs): {
  host: string;
  username: string;
  auth: { type: "key"; privateKey: string } | { type: "password"; password: string };
} {
  // Resolve credentials: explicit > vault > error
  let auth: { type: "key"; privateKey: string } | { type: "password"; password: string };
  if (args.privateKey) {
    auth = { type: "key", privateKey: args.privateKey };
  } else if (args.password) {
    auth = { type: "password", password: args.password };
  } else if (args.vaultId) {
    const v = vaultGet(args.vaultId);
    if (v === null) throw new Error(`vault entry not found: ${args.vaultId}`);
    if (v.includes("PRIVATE KEY")) auth = { type: "key", privateKey: v };
    else auth = { type: "password", password: v };
  } else {
    throw new Error("missing credentials: provide password, privateKey, or vaultId");
  }
  return { host: args.host, username: args.username, auth };
}

// ── Script runner — spawns whitelisted shell scripts under perch-src/scripts/.
//    Args dict becomes uppercase env vars (whitelisted [A-Z_]+ keys, scalar values).
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_DIR = path.resolve(__dirname, "../../scripts");
const SCRIPT_WHITELIST = new Set([
  "access-top-ips.sh",
  "access-summary.sh",
  "wp-errors.sh",
  "php-errors.sh",
  "mysql-errors.sh",
  "server-pulse.sh",
]);

async function runScript(scriptName: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<{ output: string; ok: boolean }> {
  if (!SCRIPT_WHITELIST.has(scriptName)) {
    throw new Error(`Script not whitelisted: ${scriptName}`);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(args)) {
    // Auto-uppercase to ENV style — accept both {domain} and {DOMAIN}
    const K = k.toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(K)) continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    const sv = String(v);
    if (sv.length > 200 || !/^[A-Za-z0-9._-]+$/.test(sv)) continue;
    env[K] = sv;
  }
  return new Promise((resolve) => {
    const proc = spawn("bash", [path.join(SCRIPT_DIR, scriptName)], { env, cwd: "/tmp" });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { err += d.toString(); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve({ output: "Script timed out", ok: false }); }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output: (out + err).trim(), ok: code === 0 });
    });
  });
}

// Tool dispatcher — kept terse and verifiable.
const HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  // ── Brain
  "brain": async () => getBrain(brain),
  "brain.history": async (a) => getWebappHistory(brain, String(a.domain || "")),

  // ── Read-only server intelligence (whitelisted shell scripts)
  "access_top_ips": async (a) => await runScript("access-top-ips.sh", { DOMAIN: String(a.domain || ""), COUNT: a.count ? String(a.count) : "10" }),
  "access_summary": async (a) => await runScript("access-summary.sh", { DOMAIN: String(a.domain || "") }),
  "wp_errors":      async (a) => await runScript("wp-errors.sh", a.domain ? { DOMAIN: String(a.domain) } : {}),
  "php_errors":     async () => await runScript("php-errors.sh", {}),
  "mysql_errors":   async () => await runScript("mysql-errors.sh", {}),
  "server_pulse":   async () => await runScript("server-pulse.sh", {}),

  // ── Audit log (used by fix-server.py to record shell-side actions)
  "log_action": async (a) => {
    const id = logAction(brain, {
      action_type: String(a.action_type || "unknown"),
      target: a.target ? String(a.target) : undefined,
      args: (a.args as Record<string, unknown>) ?? {},
      result: (a.result as Record<string, unknown>) ?? null,
      ok: a.ok !== false,
    });
    return { id, recorded: true };
  },

  // ── Vault (read-only over HTTP — no put/delete via API for safety)
  "vault.list": async () => ({ entries: vaultList() }),

  // ── SSH
  "ssh.detect_webapp": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await detectWebappType(opts, String(a.webroot || ""));
  },
  "ssh.exec": async (a) => {
    // Restricted: only safe read-only commands accepted via API
    const cmd = String(a.command || "");
    if (!/^(systemctl is-active|df |free |uptime|ls |cat \/etc\/(hostname|os-release)|nginx -t|pgrep |ps -e|hostname)/.test(cmd)) {
      throw new Error("ssh.exec via API only allows read-only commands");
    }
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await sshExec(opts, cmd);
  },

  // ── WordPress audits (read-only — safe)
  "wp.db_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    const r = await auditDatabase(opts, String(a.wpPath), String(a.wpUser), String(a.dbName));
    incrementKnowledge(brain, "wp_db_audit", "api_audit", "none");
    return r;
  },
  "wp.plugins": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditPlugins(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.security": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditSecurity(opts, String(a.wpPath), String(a.wpUser), String(a.domain));
  },
  "wp.backup": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await checkBackupHealth(opts, String(a.webroot), String(a.domain));
  },
  "wp.perf": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await snapshotPerformance(opts, String(a.wpPath), String(a.wpUser), String(a.domain));
  },
  "wp.errors": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    const lines = a.lines ? Number(a.lines) : 200;
    const diagnosis = await diagnoseErrors(opts, String(a.wpPath), String(a.wpUser), String(a.domain), lines);
    if (diagnosis.likelyCause) {
      logProblem(brain, {
        type: diagnosis.isWhiteScreen ? "white_screen" : "php_error",
        root_cause: diagnosis.likelyCause,
        raw_log_snippet: diagnosis.rawLogLines.join("\n").slice(0, 2000),
      });
    }
    return diagnosis;
  },
  "wp.images_scan": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await scanImages(opts, String(a.uploadsPath));
  },
  "wp.images_compress_bulk_status": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await getBulkCompressionStatus(opts, String(a.jobId));
  },
  "wp.images_compress_bulk_list": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await listBulkCompressionJobs(opts);
  },
  "wp.audit_disk": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditDisk(opts, String(a.wpPath));
  },
  "wp.scan_malware": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await scanMalware(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.thumbnails_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditThumbnails(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.plugins_perf_profile": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await profilePlugins(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.plugins_cleanup_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditUnusedPlugins(
      opts, String(a.wpPath), String(a.wpUser),
      a.inactiveDaysThreshold ? Number(a.inactiveDaysThreshold) : undefined,
    );
  },
  "wp.media_orphans_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditMediaOrphans(
      opts, String(a.wpPath), String(a.wpUser),
      a.sampleLimit ? Number(a.sampleLimit) : undefined,
    );
  },
  "wp.revisions_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditRevisions(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.translations_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditTranslations(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.htaccess_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditHtaccess(opts, String(a.wpPath));
  },
  "wp.core_status": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await getCoreStatus(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.cron_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditCron(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.ssl_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditSsl(opts, String(a.url));
  },
  "wp.wp_config_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditWpConfig(opts, String(a.wpPath));
  },
  "wp.multisite_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditMultisite(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.caching_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditCaching(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.woocommerce_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditWooCommerce(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.yoast_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await auditYoast(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.lighthouse_audit": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    const strategy = (a.strategy === 'desktop' ? 'desktop' : 'mobile') as 'mobile' | 'desktop';
    return await runLighthouse(opts, String(a.url), strategy, a.psiApiKey ? String(a.psiApiKey) : undefined);
  },
  "wp.recommend": async (a) => {
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await buildRecommendations(opts, {
      wpPath: String(a.wpPath),
      wpUser: String(a.wpUser),
      brain,
      serverId: a.serverId ? Number(a.serverId) : undefined,
      webappId: a.webappId ? Number(a.webappId) : undefined,
    });
  },

  // ── WordPress mutations (require explicit confirm flag)
  "wp.db_clean": async (a) => {
    if (a.confirm !== true) throw new Error("wp.db_clean requires confirm:true to actually delete data");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await cleanTransients(opts, String(a.wpPath), String(a.wpUser));
  },
  "wp.images_optimize": async (a) => {
    if (a.confirm !== true) throw new Error("wp.images_optimize requires confirm:true to mutate files");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await optimizeImages(opts, String(a.uploadsPath), {
      generateWebp: a.generateWebp === undefined ? true : Boolean(a.generateWebp),
      losslessOnly: a.losslessOnly === undefined ? true : Boolean(a.losslessOnly),
      dryRun: Boolean(a.dryRun),
      preferPngquant: a.preferPngquant === undefined ? true : Boolean(a.preferPngquant),
      pngQualityRange: a.pngQualityRange ? String(a.pngQualityRange) : undefined,
      parallelism: a.parallelism ? Number(a.parallelism) : undefined,
      nicePriority: a.nicePriority ? Number(a.nicePriority) : undefined,
    });
  },
  "wp.images_compress_bulk_start": async (a) => {
    if (a.confirm !== true) throw new Error("wp.images_compress_bulk_start requires confirm:true to launch a long-running job");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await startBulkCompression(opts, String(a.uploadsPath), {
      pngQualityRange: a.pngQualityRange ? String(a.pngQualityRange) : undefined,
      parallelism: a.parallelism ? Number(a.parallelism) : undefined,
      nicePriority: a.nicePriority ? Number(a.nicePriority) : undefined,
      includeJpeg: Boolean(a.includeJpeg),
      jpegQuality: a.jpegQuality ? Number(a.jpegQuality) : undefined,
    });
  },
  "wp.images_compress_bulk_cancel": async (a) => {
    if (a.confirm !== true) throw new Error("wp.images_compress_bulk_cancel requires confirm:true");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await cancelBulkCompression(opts, String(a.jobId));
  },
  "wp.images_compress_bulk_cleanup": async (a) => {
    if (a.confirm !== true) throw new Error("wp.images_compress_bulk_cleanup requires confirm:true");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await cleanupBulkCompression(opts, String(a.jobId));
  },
  "wp.thumbnails_clean": async (a) => {
    if (a.confirm !== true) throw new Error("wp.thumbnails_clean requires confirm:true");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    if (!Array.isArray(a.sizeSlugs)) throw new Error("sizeSlugs (string[]) is required");
    return await cleanThumbnails(opts, String(a.wpPath), String(a.wpUser), {
      sizeSlugs: (a.sizeSlugs as unknown[]).map(String),
      apply: Boolean(a.apply),
    });
  },
  "wp.plugins_cleanup_apply": async (a) => {
    if (a.confirm !== true) throw new Error("wp.plugins_cleanup_apply requires confirm:true");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    if (!Array.isArray(a.slugs)) throw new Error("slugs (string[]) is required");
    const action = String(a.action);
    if (action !== "deactivate" && action !== "uninstall") {
      throw new Error('action must be "deactivate" or "uninstall"');
    }
    return await applyPluginCleanup(opts, String(a.wpPath), String(a.wpUser), {
      slugs: (a.slugs as unknown[]).map(String),
      action: action as "deactivate" | "uninstall",
      apply: Boolean(a.apply),
    });
  },
  "wp.revisions_clean": async (a) => {
    if (a.confirm !== true) throw new Error("wp.revisions_clean requires confirm:true");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await cleanRevisions(opts, String(a.wpPath), String(a.wpUser), {
      keepRevisionsPerPost: a.keepRevisionsPerPost ? Number(a.keepRevisionsPerPost) : 5,
      deleteAutoDrafts: Boolean(a.deleteAutoDrafts),
      deleteTrashedPosts: Boolean(a.deleteTrashedPosts),
      deleteSpamComments: Boolean(a.deleteSpamComments),
      deleteTrashedComments: Boolean(a.deleteTrashedComments),
      apply: Boolean(a.apply),
    });
  },
  "wp.translations_clean": async (a) => {
    if (a.confirm !== true) throw new Error("wp.translations_clean requires confirm:true");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await cleanTranslations(opts, String(a.wpPath), String(a.wpUser), Boolean(a.apply));
  },
  "wp.core_update": async (a) => {
    if (a.confirm !== true) throw new Error("wp.core_update requires confirm:true");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await applyCoreUpdate(opts, String(a.wpPath), String(a.wpUser), Boolean(a.apply));
  },
  "wp.search_replace": async (a) => {
    if (a.confirm !== true) throw new Error("wp.search_replace requires confirm:true");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await searchReplace(opts, String(a.wpPath), String(a.wpUser), {
      search: String(a.search),
      replace: String(a.replace),
      skipTables: a.skipTables ? String(a.skipTables) : undefined,
      apply: Boolean(a.apply),
      allTables: a.allTables !== false,
    });
  },
  "wp.cron_run": async (a) => {
    if (a.confirm !== true) throw new Error("wp.cron_run requires confirm:true");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await runCronEvents(opts, String(a.wpPath), String(a.wpUser), a.dueOnly !== false);
  },
  "wp.rewrite_flush": async (a) => {
    if (a.confirm !== true) throw new Error("wp.rewrite_flush requires confirm:true");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await flushRewrites(opts, String(a.wpPath), String(a.wpUser), Boolean(a.hardFlush));
  },
  "wp.email_test": async (a) => {
    if (a.confirm !== true) throw new Error("wp.email_test requires confirm:true (sends a real email)");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await testEmail(
      opts, String(a.wpPath), String(a.wpUser),
      String(a.to), a.subject ? String(a.subject) : undefined,
    );
  },

  // ── Conversational chat (v2.5 Surface A read-only) ────────────────────────
  // Senior-sysadmin voice. Memory across turns. Heuristic tool routing for
  // live data (top IPs, WP errors, server pulse, etc.). Read-only — refuses
  // mutating asks and redirects to Smart Fix or Claude Code MCP.
  "chat": async (a) => chatHandler(a),
};

// ─── PERCH CHAT (sysadmin voice) ───────────────────────────────────────────

const PERCH_SYSADMIN_VOICE = `You are Perch — a senior sysadmin who lives inside the user's server. You've watched these systems for years. Sharp. Calm. Hands-on.

# Scope
- Servers, webapps, infra (nginx-rc, php-fpm-rc, mariadb, redis, SSL)
- WordPress, Laravel, Node sites
- RunCloud panel state, Hetzner servers
- Logs, errors, performance, security
- Past issues + fixes from your memory

# Out of scope
- Marketing, content writing, code that's not infra, weather, jokes, personal life
If asked: "Not my lane — I focus on your infrastructure."

# Voice
- Hindi/English/Hinglish — match the user's tone exactly
- Calm, direct, hands-on. Like an oncall engineer who's seen it all.
- Numbers, paths, service names. Not "things look fine" — "/var/log/nginx-rc/error.log: 12 5xx in last hour, all from 142.93.*."
- Use 🦅 ONCE at the start when you have fresh data. Never sprinkled.
- 2-4 sentences typical. No fluff. No "great question". No motivational filler. No trailing emojis.
- Builder, not best friend. Builder doesn't gush.

# Memory
You have access to the user's last 20 turns and a brain snapshot (servers, webapps, problems). Reference past issues when relevant — "last time we did pngquant on startupcooking", "yesterday's disk alert was from /var/log/nginx-rc/access". Don't pretend to forget what was discussed earlier.

# Tools (read-only, fired automatically when relevant)
The orchestrator may auto-fire one of these and inject results as [TOOL: <name>]. Use the result verbatim — don't invent or estimate around it.
- access_top_ips(domain) — top visitor IPs
- access_summary(domain) — traffic + URLs + status codes
- wp_errors(domain?) — WordPress debug.log + plugin errors
- php_errors() — PHP-FPM errors all sites
- mysql_errors() — MariaDB errors + slow queries
- server_pulse() — load/disk/RAM/top procs

# Hard rule (the one you don't break)
You never write or mutate. If user asks for a fix:
- Safe known fixes: "Smart Fix card aayega next nudge mei — wait for it. Ya tap karo agar already aaya."
- Deeper work: "Claude Code mei khol — wahan mera full toolkit hai."

You're Perch. Read-only conversation. Smart Fix is for change. Be useful, be fast, be unfluffy.`;

interface ToolMatch { name: string; args: Record<string, unknown>; }

function detectTool(text: string): ToolMatch | null {
  const lo = text.toLowerCase();
  // Pull a domain if mentioned (e.g. "top ips theplusaddons.com")
  const domainMatch = text.match(/\b([a-z0-9][a-z0-9-]*\.[a-z]{2,}(?:\.[a-z]{2,})?)\b/i);
  const domain = domainMatch?.[1];

  if (/(top.*ip|visitor|kaun.*visit|top hit|popular ip)/i.test(lo) && domain) {
    return { name: "access_top_ips", args: { domain } };
  }
  if (/(traffic|access.*summary|hits|visits today|status code|url breakdown)/i.test(lo) && domain) {
    return { name: "access_summary", args: { domain } };
  }
  if (/(wp.*error|wordpress.*error|plugin.*error|debug\.log|wp-content.*error)/i.test(lo)) {
    return { name: "wp_errors", args: domain ? { domain } : {} };
  }
  if (/(php.*error|fpm.*error|php8\d.*error)/i.test(lo)) {
    return { name: "php_errors", args: {} };
  }
  if (/(mysql|mariadb|slow.*query|db.*error|sql.*err)/i.test(lo)) {
    return { name: "mysql_errors", args: {} };
  }
  if (/(load|cpu|ram|memory|disk usage|server.*pulse|server.*health|server.*status|kya chal raha|kya hua server)/i.test(lo)) {
    return { name: "server_pulse", args: {} };
  }
  return null;
}

function buildContextBlock(): string {
  try {
    const s = getBrain(brain);
    const head = `Servers: ${s.server_count} · Webapps: ${s.webapp_count} · Open problems: ${s.unresolved_problems}`;
    const list = s.servers.slice(0, 5).map((srv) =>
      `- ${srv.hostname} (${srv.ip}): ${srv.webapp_count} webapps`).join("\n");
    return `${head}\n${list}`;
  } catch {
    return "(brain snapshot unavailable)";
  }
}

interface GeminiContent { role: "user" | "model"; parts: Array<{ text: string }>; }

async function callGemini(opts: {
  apiKey: string;
  model: string;
  systemInstruction: string;
  contents: GeminiContent[];
}): Promise<{ reply: string; raw: unknown }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: opts.systemInstruction }] },
    contents: opts.contents,
    generationConfig: { temperature: 0.6, maxOutputTokens: 1024, topP: 0.9 },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
  if (data.error) {
    throw new Error(`Gemini API error: ${data.error.message ?? JSON.stringify(data.error)}`);
  }
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return { reply, raw: data };
}

async function chatHandler(args: Record<string, unknown>): Promise<unknown> {
  const t0 = Date.now();
  const chatId = String(args.chat_id ?? args.chatId ?? "default");
  const message = String(args.message ?? args.text ?? "").trim();
  const channel = String(args.channel ?? "http");

  if (!message) return { ok: false, error: "message required" };

  const apiKey = String(args.llm_key ?? process.env.PERCH_LLM_API_KEY ?? "");
  const model = String(args.llm_model ?? process.env.PERCH_LLM_MODEL ?? "gemini-2.5-flash-lite");

  if (!apiKey) {
    return { ok: false, error: "PERCH_LLM_API_KEY not configured. Set it in ~/.perch/.env (Gemini reference deploy)." };
  }

  // Heuristic tool routing — fire ONE read-only tool if relevant.
  let toolMatch: ToolMatch | null = detectTool(message);
  let toolOutput = "";
  let toolError = "";
  if (toolMatch) {
    try {
      const handler = HANDLERS[toolMatch.name];
      if (!handler) {
        toolError = `Tool ${toolMatch.name} not registered.`;
      } else {
        const raw = await handler(toolMatch.args);
        if (typeof raw === "string") {
          toolOutput = raw;
        } else if (raw && typeof raw === "object" && "output" in raw) {
          toolOutput = String((raw as { output: unknown }).output ?? "");
        } else {
          toolOutput = JSON.stringify(raw, null, 2);
        }
        toolOutput = toolOutput.slice(0, 3000); // cap context
      }
    } catch (e) {
      toolError = (e as Error).message;
    }
  }

  // Load history + brain snapshot
  const history = getRecentConversation(brain, chatId, 20);
  const contextBlock = buildContextBlock();

  // Compose Gemini contents
  const contents: GeminiContent[] = [];
  // Inject brain context as a model "primer"
  contents.push({
    role: "user",
    parts: [{ text: `[brain snapshot — fresh as of now]\n${contextBlock}` }],
  });
  contents.push({
    role: "model",
    parts: [{ text: "Acknowledged — I'll reference this snapshot for infra-state questions." }],
  });
  // Replay last N turns
  for (const t of history) {
    if (t.role === "tool") continue; // tool results inline below if just-fired
    contents.push({
      role: t.role === "model" ? "model" : "user",
      parts: [{ text: t.content }],
    });
  }
  // Current message — with tool result inlined if any
  let userTurn = message;
  if (toolMatch && toolOutput) {
    userTurn = `[TOOL: ${toolMatch.name} ${JSON.stringify(toolMatch.args)}]\n${toolOutput}\n[/TOOL]\n\n${message}`;
  } else if (toolMatch && toolError) {
    userTurn = `[TOOL: ${toolMatch.name} — failed: ${toolError}]\n\n${message}`;
  }
  contents.push({ role: "user", parts: [{ text: userTurn }] });

  // Call Gemini
  let reply = "";
  let geminiErr = "";
  try {
    const out = await callGemini({
      apiKey,
      model,
      systemInstruction: PERCH_SYSADMIN_VOICE,
      contents,
    });
    reply = out.reply;
  } catch (e) {
    geminiErr = (e as Error).message;
  }

  if (!reply) {
    return {
      ok: false,
      error: geminiErr || "Empty Gemini reply",
      tool_used: toolMatch?.name,
    };
  }

  // Persist turns (user, optional tool, model)
  appendConversation(brain, chatId, channel, { role: "user", content: message });
  if (toolMatch && (toolOutput || toolError)) {
    appendConversation(brain, chatId, channel, {
      role: "tool",
      content: toolOutput || `error: ${toolError}`,
      tool_name: toolMatch.name,
      tool_args: JSON.stringify(toolMatch.args),
    });
  }
  appendConversation(brain, chatId, channel, { role: "model", content: reply });

  return {
    ok: true,
    reply,
    tool_used: toolMatch?.name,
    tool_args: toolMatch?.args,
    model,
    latency_ms: Date.now() - t0,
  };
}

// ─── Rate limiter (per IP, 60 req/min sliding window) ────────────────────────

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT     = 60;
const rateBuckets    = new Map<string, number[]>();

function rateOk(ip: string): boolean {
  const now = Date.now();
  const arr = (rateBuckets.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) return false;
  arr.push(now);
  rateBuckets.set(ip, arr);
  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "X-Perch-Api": "1.0",
  });
  res.end(text);
}

function authOk(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return false;
  // Constant-time compare
  const a = Buffer.from(m[1]);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let len = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      len += chunk.length;
      if (len > MAX_BODY) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress || "unknown";
}

// ─── Request router ──────────────────────────────────────────────────────────

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url    = req.url || "/";
  const method = req.method || "GET";
  const ip     = clientIp(req);

  // Health check (unauthenticated)
  if (method === "GET" && (url === "/health" || url === "/healthz")) {
    return send(res, 200, { ok: true, service: "perch-api", version: "1.0.0" });
  }

  // Everything else needs auth
  if (!authOk(req)) {
    return send(res, 401, { ok: false, error: "unauthorized" });
  }

  if (!rateOk(ip)) {
    return send(res, 429, { ok: false, error: "rate limit exceeded — 60 req/min" });
  }

  // Tool catalog
  if (method === "GET" && url === "/api/tools") {
    return send(res, 200, {
      ok: true,
      tools: Object.keys(HANDLERS).sort(),
      docs: "POST /api/<tool> with body {args: {...}}",
    });
  }

  // Tool dispatch
  if (method === "POST" && url.startsWith("/api/")) {
    const toolName = url.slice(5);
    const handler = HANDLERS[toolName];
    if (!handler) {
      return send(res, 404, { ok: false, error: `unknown tool: ${toolName}` });
    }
    let args: Record<string, unknown> = {};
    try {
      const raw = await readBody(req);
      if (raw) {
        const parsed = JSON.parse(raw) as { args?: Record<string, unknown> };
        args = parsed.args ?? {};
      }
    } catch (err) {
      return send(res, 400, { ok: false, error: `bad json: ${(err as Error).message}` });
    }
    try {
      const result = await handler(args);
      return send(res, 200, { ok: true, tool: toolName, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const safeMsg = safeTruncate(safeForOutput(msg), 800);
      return send(res, 500, { ok: false, tool: toolName, error: safeMsg });
    }
  }

  return send(res, 404, { ok: false, error: "not found" });
}

// ─── Start ───────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    try { send(res, 500, { ok: false, error: safeForOutput(String(err)) }); }
    catch { /* socket already closed */ }
  });
});

server.listen(PORT, HOST, () => {
  console.error(`Perch API on http://${HOST}:${PORT} (${Object.keys(HANDLERS).length} tools)`);
  if (HOST !== "127.0.0.1") {
    console.error(`WARNING: binding to ${HOST} — ensure firewall blocks port ${PORT} from public access.`);
  }
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT",  () => server.close(() => process.exit(0)));
