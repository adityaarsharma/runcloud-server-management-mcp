#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client as SSHClient } from "ssh2";

const BASE_URL = "https://manage.runcloud.io/api/v3";

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.RUNCLOUD_API_KEY;
  if (!key) throw new Error("RUNCLOUD_API_KEY environment variable is not set");
  return key;
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
  return text ? JSON.parse(text) : {};
}

// Auto-fetch all pages of a paginated list endpoint
async function paginateAll(path: string): Promise<unknown[]> {
  const results: unknown[] = [];
  let page = 1;
  while (true) {
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

// SSH into a server and run a command
async function sshExec(
  host: string,
  username: string,
  password: string,
  command: string,
  timeoutMs = 30000
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
        stream.on("data", (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      });
    });

    conn.on("error", (err) => { clearTimeout(timer); reject(err); });
    conn.connect({ host, port: 22, username, password, readyTimeout: 10000 });
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
];

// ─── SERVER SETUP ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "runcloud-mcp", version: "2.0.0" },
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
          result = await paginateAll("/servers" + (a.search ? `?search=${a.search}` : ""));
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
          const path = `/servers/${a.serverId}/webapps` + (a.search ? `?search=${a.search}` : "");
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
        const timeout = ((a.timeoutSeconds as number) ?? 30) * 1000;
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
        const cmd = `cd ${a.appPath} && wp ${a.wpcliCommand} --allow-root 2>&1`;
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
        const cmd = `cd ${a.appPath} && php artisan ${a.artisanCommand} 2>&1`;
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
        const lines = (a.lines as number) ?? 100;
        const cmd = `tail -n ${lines} ${a.logPath} 2>&1`;
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

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("RunCloud MCP Server v2.0 running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
