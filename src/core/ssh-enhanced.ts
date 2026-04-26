import { Client as SSHClient, ConnectConfig } from "ssh2";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB
const TRUNCATION_MSG = "\n[OUTPUT TRUNCATED AT 1MB]";

// ─── SECURITY [C2]: TOFU host fingerprint verification ──────────────────────

const HOST_KEYS_PATH = join(process.env.PERCH_VAULT_DIR ?? join(homedir(), ".perch"), "known_hosts.json");

function loadKnownHosts(): Record<string, string> {
  if (!existsSync(HOST_KEYS_PATH)) return {};
  try { return JSON.parse(readFileSync(HOST_KEYS_PATH, "utf8")) as Record<string, string>; }
  catch { return {}; }
}

function saveKnownHosts(map: Record<string, string>): void {
  const dir = join(homedir(), ".perch");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(HOST_KEYS_PATH, JSON.stringify(map, null, 2), { mode: 0o600 });
}

/**
 * Returns a host-key verifier that:
 * - On first connection: pins the fingerprint and accepts (TOFU)
 * - On later connections: rejects if the fingerprint changed (MITM detection)
 *
 * Set PERCH_SSH_TRUST_NEW_HOSTS=0 to require pre-pinned fingerprints (strict mode).
 */
function makeHostVerifier(host: string): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    const fp = createHash("sha256").update(key).digest("hex");
    const known = loadKnownHosts();
    if (process.env.PERCH_SSH_TRUST_NEW_HOSTS === "0" && !known[host]) {
      console.error(`[perch ssh] strict mode: host ${host} not pre-pinned, refusing`);
      return false;
    }
    if (known[host]) {
      if (known[host] !== fp) {
        console.error(`[perch ssh] FINGERPRINT MISMATCH for ${host} — possible MITM, refusing`);
        return false;
      }
      return true;
    }
    known[host] = fp;
    saveKnownHosts(known);
    return true;
  };
}

// ─── INTERFACES ───────────────────────────────────────────────────────────────

export interface SSHAuthPassword {
  type: "password";
  password: string;
}

export interface SSHAuthKey {
  type: "key";
  privateKey: string;
  passphrase?: string;
}

export type SSHAuth = SSHAuthPassword | SSHAuthKey;

export interface SSHOptions {
  host: string;
  port?: number;        // default 22
  username: string;
  auth: SSHAuth;
  timeoutMs?: number;   // default 30000
  hostVerification?: boolean; // default false (trust-on-first-use)
}

export interface SSHResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

// ─── INTERNAL HELPERS ─────────────────────────────────────────────────────────

function buildConnectConfig(opts: SSHOptions): ConnectConfig {
  const base: ConnectConfig = {
    host: opts.host,
    port: opts.port ?? 22,
    username: opts.username,
    readyTimeout: opts.timeoutMs ?? 30000,
    // SECURITY [C2]: real TOFU host verification
    hostVerifier: makeHostVerifier(opts.host),
  };

  if (opts.auth.type === "password") {
    base.password = opts.auth.password;
  } else {
    base.privateKey = opts.auth.privateKey;
    if (opts.auth.passphrase) {
      base.passphrase = opts.auth.passphrase;
    }
  }

  return base;
}

function appendTruncated(current: string, chunk: string): string {
  if (current.includes(TRUNCATION_MSG)) return current;
  const combined = current + chunk;
  if (combined.length > MAX_OUTPUT_BYTES) {
    return combined.slice(0, MAX_OUTPUT_BYTES) + TRUNCATION_MSG;
  }
  return combined;
}

// ─── CORE SSH EXEC ────────────────────────────────────────────────────────────

/**
 * Execute a single command over SSH and return stdout, stderr, exit code, and
 * whether the connection timed out.
 */
export async function sshExec(opts: SSHOptions, command: string): Promise<SSHResult> {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timeoutMs = opts.timeoutMs ?? 30000;
    const timer = setTimeout(() => {
      timedOut = true;
      conn.end();
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, code: -1, timedOut: true });
      }
    }, timeoutMs);

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          if (!settled) { settled = true; reject(err); }
          return;
        }

        stream.on("close", (code: number) => {
          clearTimeout(timer);
          conn.end();
          if (!settled) {
            settled = true;
            resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0, timedOut });
          }
        });

        stream.on("data", (chunk: Buffer) => {
          stdout = appendTruncated(stdout, chunk.toString());
          if (stdout.includes(TRUNCATION_MSG)) stream.close();
        });

        stream.stderr.on("data", (chunk: Buffer) => {
          stderr = appendTruncated(stderr, chunk.toString());
          if (stderr.includes(TRUNCATION_MSG)) stream.close();
        });
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });

    conn.connect(buildConnectConfig(opts));
  });
}

// ─── CHAIN EXECUTION ─────────────────────────────────────────────────────────

/**
 * Execute multiple commands sequentially over individual SSH sessions.
 * Stops on the first non-zero exit code.
 */
export async function sshExecChain(
  opts: SSHOptions,
  commands: string[]
): Promise<SSHResult[]> {
  const results: SSHResult[] = [];

  for (const cmd of commands) {
    const result = await sshExec(opts, cmd);
    results.push(result);
    if (result.code !== 0 || result.timedOut) break;
  }

  return results;
}

// ─── WEBAPP TYPE DETECTION ────────────────────────────────────────────────────

/**
 * Detect what type of webapp is running on a given webroot path.
 *
 * Detection order:
 *   1. WordPress — looks for wp-config.php
 *   2. Laravel   — looks for artisan
 *   3. Node.js   — looks for package.json
 *   4. Static    — looks for index.html with no server-side markers
 *   5. Unknown
 */
export async function detectWebappType(
  opts: SSHOptions,
  webroot: string
): Promise<"wordpress" | "laravel" | "node" | "static" | "unknown"> {
  const checks: Array<{ marker: string; type: string }> = [
    { marker: "wp-config.php", type: "wordpress" },
    { marker: "artisan",       type: "laravel" },
    { marker: "package.json",  type: "node" },
    { marker: "index.html",    type: "static" },
  ];

  // Build a compound test command to minimise round-trips
  const testCmd = checks
    .map((c) => `[ -f "${webroot}/${c.marker}" ] && echo "${c.type}" && exit 0`)
    .join("; ");
  const finalCmd = `${testCmd}; echo "unknown"`;

  const result = await sshExec(opts, finalCmd);
  if (result.timedOut) return "unknown";

  const out = result.stdout.trim().split("\n")[0]?.trim() ?? "unknown";
  const valid = new Set(["wordpress", "laravel", "node", "static", "unknown"]);

  return valid.has(out)
    ? (out as "wordpress" | "laravel" | "node" | "static" | "unknown")
    : "unknown";
}

// ─── WP-CLI HELPERS ───────────────────────────────────────────────────────────

/**
 * Returns true if wp-cli is available on the remote server.
 */
export async function hasWpCli(opts: SSHOptions): Promise<boolean> {
  const result = await sshExec(opts, "command -v wp || which wp 2>/dev/null");
  return result.code === 0 && result.stdout.trim().length > 0;
}

/**
 * Run a wp-cli command as the correct system user.
 *
 * Internally runs:
 *   sudo -u {wpUser} wp --path={wpPath} --allow-root {command}
 *
 * @param timeoutMs  Optional per-command timeout in ms (overrides opts.timeoutMs)
 */
export async function wpCli(
  opts: SSHOptions,
  wpPath: string,
  wpUser: string,
  command: string,
  timeoutMs?: number
): Promise<SSHResult> {
  // Basic path sanitisation — reject traversal attempts
  if (/\.\./.test(wpPath)) {
    throw new Error("wpPath must not contain '..'");
  }

  const effectiveOpts: SSHOptions = timeoutMs ? { ...opts, timeoutMs } : opts;
  const fullCommand = `sudo -u ${shellEscape(wpUser)} wp --path=${shellEscape(wpPath)} --allow-root ${command}`;
  return sshExec(effectiveOpts, fullCommand);
}

/**
 * Run a WP-CLI db query and return the raw output.
 * Sugar over `wpCli` for SQL work.
 */
export async function wpDbQuery(
  opts: SSHOptions,
  wpPath: string,
  wpUser: string,
  sql: string,
  timeoutMs = 60_000
): Promise<SSHResult> {
  const escaped = sql.replace(/'/g, "'\\''");
  return wpCli(opts, wpPath, wpUser, `db query '${escaped}'`, timeoutMs);
}

// ─── UTILITY ─────────────────────────────────────────────────────────────────

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Perform a simple HTTP GET and return status + body text.
 * Used for security checks that need HTTP-level access.
 */
export async function httpGet(
  url: string,
  timeoutMs = 10_000
): Promise<{ status: number; body: string; ok: boolean }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Perch-Audit/1.0" },
    });
    clearTimeout(timer);
    const body = await res.text();
    return { status: res.status, body, ok: res.ok };
  } catch {
    return { status: 0, body: "", ok: false };
  }
}
