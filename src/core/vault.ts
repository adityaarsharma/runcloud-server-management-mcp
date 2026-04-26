/**
 * vault.ts — Encrypted credential storage at rest
 *
 * AES-256-GCM encryption for SSH passwords, API keys, and any other secret
 * Perch needs to store. Master key sourced from PERCH_MASTER_KEY env var.
 *
 * Threat model:
 * - Disk theft / image leak → vault.json contents are encrypted, useless without master key
 * - Compromised SQLite brain.db → no credentials live in brain.db, only metadata
 * - Memory dump while running → out of scope (any in-memory secret tool has this)
 *
 * NOT a substitute for proper secret management at scale. For solo / agency use.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;        // GCM standard
const TAG_LEN = 16;       // GCM auth tag
const KEY_LEN = 32;       // 256 bits

export interface VaultEntry {
  id: string;             // human-readable key, e.g. "ssh:production-1" or "runcloud:apikey"
  value: string;          // the secret
  label?: string;
  created_at: number;
  updated_at: number;
}

interface EncryptedBlob {
  v: 1;                   // schema version
  iv: string;             // base64
  tag: string;            // base64
  ct: string;             // base64 ciphertext
}

interface VaultFile {
  schema: 1;
  entries: Record<string, EncryptedBlob>;  // id → encrypted blob
}

// ─── Master key handling ─────────────────────────────────────────────────────

function deriveKey(): Buffer {
  const masterKey = process.env.PERCH_MASTER_KEY;
  if (!masterKey) {
    throw new Error(
      "PERCH_MASTER_KEY environment variable is required for credential vault. " +
      "Set it to a strong random string (e.g., openssl rand -base64 32) and store it safely."
    );
  }
  if (masterKey.length < 16) {
    throw new Error("PERCH_MASTER_KEY must be at least 16 characters.");
  }
  // Derive 32-byte key from master via SHA-256
  return createHash("sha256").update(masterKey).digest();
}

// ─── Encrypt / Decrypt primitives ────────────────────────────────────────────

function encrypt(plaintext: string): EncryptedBlob {
  const key = deriveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

function decrypt(blob: EncryptedBlob): string {
  if (blob.v !== 1) throw new Error(`Unsupported vault schema version: ${blob.v}`);
  const key = deriveKey();
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const ct = Buffer.from(blob.ct, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

// ─── Vault file management ───────────────────────────────────────────────────

function vaultPath(): string {
  const dir = process.env.PERCH_VAULT_DIR ?? join(homedir(), ".perch");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, "vault.json");
}

function loadVault(): VaultFile {
  const path = vaultPath();
  if (!existsSync(path)) {
    return { schema: 1, entries: {} };
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as VaultFile;
  if (parsed.schema !== 1) throw new Error(`Unsupported vault schema: ${parsed.schema}`);
  return parsed;
}

function saveVault(v: VaultFile): void {
  const path = vaultPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 0600 — only owner can read
  writeFileSync(path, JSON.stringify(v, null, 2), { mode: 0o600 });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function vaultPut(id: string, value: string, label?: string): void {
  if (!id || !value) throw new Error("vaultPut: id and value are required");
  const v = loadVault();
  v.entries[id] = encrypt(value);
  saveVault(v);
  // Note: label and timestamps stored separately as plain metadata if needed.
  // Keeping vault.json minimal — just encrypted blobs by ID.
  void label; // suppress unused warning, label is for future metadata file
}

export function vaultGet(id: string): string | null {
  const v = loadVault();
  const blob = v.entries[id];
  if (!blob) return null;
  return decrypt(blob);
}

export function vaultDelete(id: string): boolean {
  const v = loadVault();
  if (!(id in v.entries)) return false;
  delete v.entries[id];
  saveVault(v);
  return true;
}

export function vaultList(): string[] {
  return Object.keys(loadVault().entries).sort();
}

export function vaultExists(): boolean {
  return existsSync(vaultPath());
}

/**
 * Re-encrypt all entries with a new master key.
 * Call after rotating PERCH_MASTER_KEY.
 *
 * Pass the OLD key as oldMasterKey, then set process.env.PERCH_MASTER_KEY to the new value
 * before calling this function.
 */
export function vaultRotate(oldMasterKey: string): { rotated: number } {
  const oldKey = createHash("sha256").update(oldMasterKey).digest();
  const v = loadVault();
  let rotated = 0;
  for (const [id, blob] of Object.entries(v.entries)) {
    // Decrypt with old key
    const iv = Buffer.from(blob.iv, "base64");
    const tag = Buffer.from(blob.tag, "base64");
    const ct = Buffer.from(blob.ct, "base64");
    const decipher = createDecipheriv(ALGO, oldKey, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    // Re-encrypt with current PERCH_MASTER_KEY (already loaded via deriveKey)
    v.entries[id] = encrypt(pt);
    rotated++;
  }
  saveVault(v);
  return { rotated };
}
