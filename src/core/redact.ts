/**
 * redact.ts — Privacy guards
 *
 * Centralized redaction for outbound messages (Telegram, Slack, error logs).
 * Anything that goes to a user-facing surface MUST pass through `redact()` first.
 *
 * Catches:
 * - Bearer tokens, API keys
 * - Password fields in URLs/JSON
 * - SSH private keys (PEM blocks)
 * - Long absolute paths in /home/{user}/... (shorten to ~)
 * - DB content (SQL result rows are never echoed verbatim — only summaries)
 * - WordPress wp-config.php content
 * - .env file content
 */

const RULES: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  // Bearer tokens
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, replacement: "Bearer [REDACTED]" },

  // Authorization header values (Basic, Token, etc.)
  { name: "auth-header", pattern: /Authorization:\s*\S+/gi, replacement: "Authorization: [REDACTED]" },

  // API keys in URLs (?api_key=, ?token=, &key=, ?apikey=)
  { name: "url-key", pattern: /([?&](?:api[_-]?key|token|apikey|secret|password)=)[^&\s]+/gi, replacement: "$1[REDACTED]" },

  // password=... in any context
  { name: "password-field", pattern: /password["']?\s*[:=]\s*["']?[^"'\s,}]+/gi, replacement: "password=[REDACTED]" },

  // PEM private key blocks
  { name: "pem-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[PRIVATE KEY REDACTED]" },

  // SSH known_hosts entries (could leak server fingerprints)
  { name: "ssh-fingerprint", pattern: /ssh-(?:rsa|ed25519|ecdsa)\s+[A-Za-z0-9+/=]{20,}/g, replacement: "[SSH KEY REDACTED]" },

  // wp-config.php DB credentials
  { name: "wp-db-password", pattern: /define\s*\(\s*['"]DB_PASSWORD['"]\s*,\s*['"][^'"]+['"]\s*\)/gi, replacement: "define('DB_PASSWORD', '[REDACTED]')" },
  { name: "wp-secrets",     pattern: /define\s*\(\s*['"](AUTH_KEY|SECURE_AUTH_KEY|LOGGED_IN_KEY|NONCE_KEY|AUTH_SALT|SECURE_AUTH_SALT|LOGGED_IN_SALT|NONCE_SALT)['"]\s*,\s*['"][^'"]+['"]\s*\)/gi, replacement: "define('$1', '[REDACTED]')" },

  // .env style KEY=value where KEY looks secret
  { name: "env-secret", pattern: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|API|AUTH|CREDENTIAL)[A-Z0-9_]*)\s*=\s*\S+/gi, replacement: "$1=[REDACTED]" },

  // RunCloud API keys (start with specific prefixes — pattern as observed)
  { name: "runcloud-key", pattern: /\brc[a-z]?_[a-zA-Z0-9]{20,}/g, replacement: "rc_[REDACTED]" },

  // Telegram bot tokens (format: digits:alphanum)
  { name: "telegram-token", pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}/g, replacement: "[TELEGRAM TOKEN REDACTED]" },

  // Slack tokens (xoxb-, xoxa-, xoxp-, xoxs-, xoxe-)
  { name: "slack-token", pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, replacement: "[SLACK TOKEN REDACTED]" },

  // AWS access keys
  { name: "aws-access", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[AWS KEY REDACTED]" },

  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, replacement: "[GITHUB TOKEN REDACTED]" },

  // Generic long hex/base64 that looks token-shaped (40+ char)
  // Only apply if surrounded by quotes or "=" to reduce false positives
  { name: "long-token-quoted", pattern: /(["'=])([A-Za-z0-9+/=_-]{40,})(["'\s])/g, replacement: "$1[POSSIBLE SECRET REDACTED]$3" },
];

/**
 * Redact secrets from a string before sending to user-facing surfaces.
 */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/**
 * Shorten /home/{user}/long/path/to/thing to ~/path/to/thing for readability + privacy.
 * Specifically hides system usernames in paths.
 */
export function shortenPaths(text: string): string {
  if (!text) return text;
  return text
    .replace(/\/home\/[^/\s]+\/webapps\/([^/\s]+)/g, "~/webapps/$1")
    .replace(/\/home\/[^/\s]+/g, "~");
}

/**
 * Combined: redact + shorten paths. Use this for everything that leaves Perch.
 */
export function safeForOutput(text: string): string {
  return shortenPaths(redact(text));
}

/**
 * Truncate raw log output to a safe length for chat surfaces.
 * Telegram: 4096 char limit per message. Use this before sending raw output.
 */
export function safeTruncate(text: string, maxLen = 3500): string {
  if (!text) return text;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n…(truncated, ${text.length - maxLen} chars hidden)`;
}

/**
 * Summarize a SQL result row count for output.
 * Never echoes raw row contents — only counts and column names.
 */
export function safeSqlSummary(
  rowCount: number,
  columnNames: string[],
  context?: string
): string {
  const cols = columnNames.length > 0 ? ` columns: ${columnNames.slice(0, 8).join(", ")}` : "";
  return `${context ? context + ": " : ""}${rowCount} row${rowCount === 1 ? "" : "s"}${cols}`;
}
