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
import { initBrain, getBrain, getWebappHistory, incrementKnowledge, logProblem } from "../core/brain.js";
import { vaultGet, vaultList } from "../core/vault.js";
import { safeForOutput, safeTruncate } from "../core/redact.js";
import { sshExec, wpCli, detectWebappType } from "../core/ssh-enhanced.js";
import { auditDatabase, cleanTransients } from "../modules/wordpress/db.js";
import { auditPlugins } from "../modules/wordpress/plugins.js";
import { auditSecurity } from "../modules/wordpress/security.js";
import { checkBackupHealth } from "../modules/wordpress/backup.js";
import { scanImages } from "../modules/wordpress/images.js";
import { snapshotPerformance } from "../modules/wordpress/perf.js";
import { diagnoseErrors } from "../modules/wordpress/errors.js";

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

// Tool dispatcher — kept terse and verifiable.
const HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  // ── Brain
  "brain": async () => getBrain(brain),
  "brain.history": async (a) => getWebappHistory(brain, String(a.domain || "")),

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

  // ── WordPress mutations (require explicit confirm flag)
  "wp.db_clean": async (a) => {
    if (a.confirm !== true) throw new Error("wp.db_clean requires confirm:true to actually delete data");
    const opts = buildSshOpts(a as unknown as SshAuthArgs);
    return await cleanTransients(opts, String(a.wpPath), String(a.wpUser));
  },
};

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
