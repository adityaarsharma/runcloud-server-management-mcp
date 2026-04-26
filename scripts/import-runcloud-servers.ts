#!/usr/bin/env node
/**
 * import-runcloud-servers — Bulk import servers + SSH credentials into Perch's vault.
 *
 * TWO PATHS:
 *
 * (A) WITH RunCloud API key — auto-discovers all your servers from the panel.
 *     Just runs `npm run import-runcloud` and walks you through credentials per server.
 *
 * (B) WITHOUT RunCloud API key — you provide a server list manually.
 *     Useful if you don't have API access, or you manage non-RunCloud servers too.
 *     Run with --manual flag, or it auto-falls-back when RUNCLOUD_API_KEY is unset.
 *
 * Usage:
 *   npm run import-runcloud                                    # Path A (API)
 *   npm run import-runcloud -- --manual                        # Path B (manual)
 *   npm run import-runcloud -- --keys-dir=/home/me/.ssh/keys   # auto-discover keys
 *   npm run import-runcloud -- --user=runcloud                 # SSH username default
 *
 * Per-server input (interactive, Path A or B):
 *   - Type a key path             → encrypted as ssh:<slug>
 *   - Type 'pwd:<password>'        → encrypted as pwd:<slug>
 *   - Type 'skip'                  → moves on
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { vaultPut, vaultList } from "../src/core/vault.js";
import { initBrain, upsertServer } from "../src/core/brain.js";

interface RunCloudServer {
  id: number;
  name: string;
  ipAddress: string;
  online?: boolean;
  os?: string;
  webServerType?: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
}

// ─── Path A: RunCloud API ────────────────────────────────────────────────────

async function fetchServersFromRunCloud(apiKey: string): Promise<RunCloudServer[]> {
  const all: RunCloudServer[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(`https://manage.runcloud.io/api/v3/servers?page=${page}&perPage=40`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`RunCloud API ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      data: RunCloudServer[];
      meta?: { pagination?: { total_pages: number } };
    };
    all.push(...json.data);
    const totalPages = json.meta?.pagination?.total_pages ?? 1;
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

// ─── Path B: Manual list (no API key needed) ─────────────────────────────────

function rl(): ReturnType<typeof createInterface> {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(question: string): Promise<string> {
  const r = rl();
  return new Promise((resolve) => r.question(question, (a) => { r.close(); resolve(a.trim()); }));
}

async function gatherManualServerList(): Promise<RunCloudServer[]> {
  console.log("");
  console.log("=== Manual server list ===");
  console.log("Type each server you want Perch to manage. Empty name to finish.\n");

  const servers: RunCloudServer[] = [];
  let idx = 1;
  while (true) {
    console.log(`--- Server #${idx} ---`);
    const name = await ask("  Name (e.g., production-1, or empty to finish): ");
    if (!name) break;
    const ip = await ask("  IP or hostname: ");
    if (!ip) { console.log("  ✗ skipped (no IP)"); continue; }
    const osHint = await ask("  OS (optional, e.g. ubuntu-22.04): ");
    servers.push({
      id: -idx,                  // negative IDs for manually-added servers
      name,
      ipAddress: ip,
      os: osHint || undefined,
    });
    idx++;
    console.log("");
  }
  return servers;
}

// ─── Auto-discover SSH key files ─────────────────────────────────────────────

function findKeyInDir(dir: string, slug: string): string | null {
  const candidates = [
    `${slug}.pem`, `${slug}.key`, `${slug}_ed25519`, `${slug}_rsa`,
    `id_ed25519_${slug}`, `id_rsa_${slug}`,
  ];
  for (const name of candidates) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

// ─── Per-server credential prompt ────────────────────────────────────────────

interface CredResult {
  ok: boolean;
  type: "key" | "password" | "skipped";
  detail: string;
}

async function captureCredentials(server: RunCloudServer, slug: string, sshUser: string, keysDir?: string): Promise<CredResult> {
  // 1. Try keys-dir auto-discovery
  if (keysDir) {
    const keyPath = findKeyInDir(keysDir, slug);
    if (keyPath) {
      const keyContents = readFileSync(keyPath, "utf8").trimEnd();
      vaultPut(`ssh:${slug}`, keyContents);
      vaultPut(`meta:${slug}`, JSON.stringify({
        host: server.ipAddress, user: sshUser, name: server.name,
        runcloud_id: server.id > 0 ? server.id : undefined,
        auth: "key",
      }));
      return { ok: true, type: "key", detail: `key from ${keyPath} (${keyContents.length} bytes)` };
    }
  }

  // 2. Interactive prompt
  console.log(`\n--- ${server.name} (${server.ipAddress}) ---`);
  const answer = await ask("  SSH key path | 'pwd:<password>' | 'skip': ");

  if (!answer || answer.toLowerCase() === "skip") {
    return { ok: false, type: "skipped", detail: "" };
  }

  if (answer.startsWith("pwd:")) {
    const password = answer.slice(4);
    if (!password) return { ok: false, type: "skipped", detail: "empty password" };
    vaultPut(`pwd:${slug}`, password);
    vaultPut(`meta:${slug}`, JSON.stringify({
      host: server.ipAddress, user: sshUser, name: server.name,
      runcloud_id: server.id > 0 ? server.id : undefined,
      auth: "password",
    }));
    return { ok: true, type: "password", detail: "encrypted password" };
  }

  // Treat as key file path
  if (!existsSync(answer)) {
    return { ok: false, type: "skipped", detail: `file not found: ${answer}` };
  }
  const keyContents = readFileSync(answer, "utf8").trimEnd();
  if (!keyContents.includes("PRIVATE KEY")) {
    console.warn(`  ⚠ ${answer} doesn't look like a PEM private key — storing anyway`);
  }
  vaultPut(`ssh:${slug}`, keyContents);
  vaultPut(`meta:${slug}`, JSON.stringify({
    host: server.ipAddress, user: sshUser, name: server.name,
    runcloud_id: server.id > 0 ? server.id : undefined,
    auth: "key",
  }));
  return { ok: true, type: "key", detail: `key from ${answer} (${keyContents.length} bytes)` };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags: Record<string, string | true> = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else flags[arg.slice(2)] = true;
    }
  }

  if (!process.env.PERCH_MASTER_KEY) {
    console.error("✗ PERCH_MASTER_KEY env var not set.");
    console.error("  Source your env file: set -a && . ~/.perch/.env && set +a");
    process.exit(1);
  }

  const sshUser = (flags.user as string) ?? "runcloud";
  const keysDir = flags["keys-dir"] as string | undefined;
  const skipExisting = flags["skip-existing"] === true;
  const manualMode = flags.manual === true;

  let servers: RunCloudServer[] = [];

  // ─── Path A: API ───
  if (!manualMode && process.env.RUNCLOUD_API_KEY) {
    console.log("→ Path A: fetching servers from RunCloud API...");
    try {
      servers = await fetchServersFromRunCloud(process.env.RUNCLOUD_API_KEY);
      console.log(`✓ Found ${servers.length} server(s) in your RunCloud account`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ RunCloud API failed: ${msg}`);
      console.error("  Falling back to manual list mode...\n");
      servers = await gatherManualServerList();
    }
  }
  // ─── Path B: Manual ───
  else {
    if (manualMode) console.log("→ Path B: manual server list (forced via --manual)");
    else console.log("→ Path B: RUNCLOUD_API_KEY not set, falling back to manual list mode");
    servers = await gatherManualServerList();
  }

  if (servers.length === 0) {
    console.error("✗ No servers to import. Exiting.");
    process.exit(1);
  }

  console.log(`\nProceeding with ${servers.length} server(s) using SSH user '${sshUser}'`);
  if (keysDir) {
    if (!existsSync(keysDir)) {
      console.error(`✗ --keys-dir not found: ${keysDir}`); process.exit(1);
    }
    console.log(`→ Auto-discovering keys in ${keysDir}/`);
    console.log(`  Files there: ${readdirSync(keysDir).join(", ")}\n`);
  }

  const brain = initBrain();
  const existing = new Set(vaultList());
  const summary: Array<{ name: string; ip: string; status: string }> = [];

  for (const server of servers) {
    const slug = slugify(server.name);
    const sshKeyId = `ssh:${slug}`;
    const pwdKeyId = `pwd:${slug}`;

    // Register in brain (always, even if skipping cred capture)
    upsertServer(brain, {
      hostname: server.name,
      ip: server.ipAddress,
      os: server.os,
      runcloud_server_id: server.id > 0 ? server.id : undefined,
    });

    if (skipExisting && (existing.has(sshKeyId) || existing.has(pwdKeyId))) {
      console.log(`⊘ Skip ${server.name} — already in vault`);
      summary.push({ name: server.name, ip: server.ipAddress, status: "exists (skipped)" });
      continue;
    }

    const r = await captureCredentials(server, slug, sshUser, keysDir);
    if (r.ok) {
      console.log(`✓ ${server.name}: ${r.type} → ${r.detail}`);
      summary.push({ name: server.name, ip: server.ipAddress, status: r.type });
    } else {
      summary.push({ name: server.name, ip: server.ipAddress, status: `skipped (${r.detail})` });
    }
  }

  console.log("\n=== Summary ===");
  for (const row of summary) {
    console.log(`  ${row.name.padEnd(28)} ${row.ip.padEnd(18)} ${row.status}`);
  }
  console.log(`\n✓ ${servers.length} server(s) registered in brain.db`);
  console.log(`✓ Vault now has ${vaultList().length} entries`);
  console.log("\nNext: 'npm run vault list' to confirm everything is encrypted.");
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
