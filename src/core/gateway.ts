// ─── INTERFACES ───────────────────────────────────────────────────────────────

export interface AlertOptions {
  title: string;
  body: string;
  alreadyDone?: string;
  suggestion?: string;
  severity: "info" | "warning" | "critical";
  buttons?: Array<{ text: string; callbackData: string }>;
}

// ─── SEVERITY HELPERS ─────────────────────────────────────────────────────────

export function severityEmoji(s: AlertOptions["severity"]): string {
  switch (s) {
    case "info":     return "ℹ️";
    case "warning":  return "⚠️";
    case "critical": return "🔴";
  }
}

export function buildButtons(
  buttons: AlertOptions["buttons"]
): object {
  if (!buttons || buttons.length === 0) return {};
  return {
    inline_keyboard: [
      buttons.map((b) => ({
        text: b.text,
        callback_data: b.callbackData,
      })),
    ],
  };
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────

/**
 * Returns Markdown-formatted string ready to send to Telegram.
 *
 * Structure:
 *   {emoji} *{title}*
 *
 *   {body}
 *
 *   ✅ Already done: {alreadyDone}   (if present)
 *   👉 Next step: {suggestion}        (if present)
 */
export function formatTelegramAlert(opts: AlertOptions): string {
  const emoji = severityEmoji(opts.severity);
  const lines: string[] = [];

  lines.push(`${emoji} *${escapeTelegramMarkdown(opts.title)}*`);
  lines.push("");
  lines.push(escapeTelegramMarkdown(opts.body));

  if (opts.alreadyDone) {
    lines.push("");
    lines.push(`✅ *Already done:* ${escapeTelegramMarkdown(opts.alreadyDone)}`);
  }

  if (opts.suggestion) {
    lines.push("");
    lines.push(`👉 *Next step:* ${escapeTelegramMarkdown(opts.suggestion)}`);
  }

  return lines.join("\n");
}

/** Escapes special characters for Telegram MarkdownV2 */
function escapeTelegramMarkdown(text: string): string {
  // Characters that need escaping in MarkdownV2 (excluding * and _ used intentionally)
  return text.replace(/([[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// ─── SLACK ────────────────────────────────────────────────────────────────────

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string }>;
  accessory?: object;
}

/**
 * Returns Slack Block Kit JSON object.
 *
 * Uses section + context blocks to follow the
 * what happened → what Perch did → what you should do flow.
 */
export function formatSlackAlert(opts: AlertOptions): object {
  const emoji = severityEmoji(opts.severity);
  const blocks: SlackBlock[] = [];

  // Header
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `${emoji} *${opts.title}*`,
    },
  });

  // Body
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: opts.body,
    },
  });

  // Already done
  if (opts.alreadyDone) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ *Already done:* ${opts.alreadyDone}`,
      },
    });
  }

  // Suggestion
  if (opts.suggestion) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `👉 *Next step:* ${opts.suggestion}`,
      },
    });
  }

  // Divider
  blocks.push({ type: "divider" });

  return { blocks };
}

// ─── PERCH COMMAND RESPONSE ───────────────────────────────────────────────────

/**
 * Formats any data as a clean, human-readable response for /perch commands.
 * Avoids raw JSON dumps — presents structured data as readable text.
 */
export function formatPerchResponse(data: unknown, label?: string): string {
  const lines: string[] = [];

  if (label) {
    lines.push(`📋 *${label}*`);
    lines.push("");
  }

  lines.push(renderValue(data, 0));
  return lines.join("\n");
}

function renderValue(val: unknown, depth: number): string {
  const indent = "  ".repeat(depth);

  if (val === null || val === undefined) {
    return `${indent}—`;
  }

  if (typeof val === "boolean") {
    return `${indent}${val ? "yes" : "no"}`;
  }

  if (typeof val === "number") {
    return `${indent}${val.toLocaleString()}`;
  }

  if (typeof val === "string") {
    return `${indent}${val}`;
  }

  if (Array.isArray(val)) {
    if (val.length === 0) return `${indent}(none)`;
    return val
      .map((item, i) => {
        if (typeof item === "object" && item !== null) {
          return `${indent}${i + 1}.\n${renderValue(item, depth + 1)}`;
        }
        return `${indent}• ${renderValue(item, 0)}`;
      })
      .join("\n");
  }

  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    return Object.entries(obj)
      .map(([k, v]) => {
        const key = k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        const primitive = typeof v !== "object" || v === null;
        if (primitive || Array.isArray(v)) {
          return `${indent}*${key}:* ${renderValue(v, 0)}`;
        }
        return `${indent}*${key}:*\n${renderValue(v, depth + 1)}`;
      })
      .join("\n");
  }

  return `${indent}${String(val)}`;
}
