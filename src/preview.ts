/**
 * Human-readable, secret-redacted preview of an MCP call's arguments — so the
 * inbox can show "which site / what data" (fetch_url → https://example.com)
 * instead of only an opaque hash. The signed receipt still commits to the hash
 * of the FULL params; this preview is UI-only metadata and never leaves the
 * machine.
 */

// Redact by argument NAME (the value is a secret regardless of its shape).
const SECRET_KEY =
  /(pass(word|wd)?|secret|token|api[-_]?key|apikey|authorization|auth|bearer|credential|priv(ate)?[-_]?key|access[-_]?key|client[-_]?secret|session|cookie)/i;

// Redact by VALUE shape (a secret leaked into a non-obvious field).
const SECRET_VAL = new RegExp(
  [
    "sk-[A-Za-z0-9]{12,}", // OpenAI-style
    "gh[pousr]_[A-Za-z0-9]{20,}", // GitHub tokens
    "xox[baprs]-[A-Za-z0-9-]{10,}", // Slack
    "AKIA[0-9A-Z]{12,}", // AWS access key id
    "AIza[0-9A-Za-z_-]{30,}", // Google API key
    "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]+", // JWT
    "-----BEGIN [A-Z ]*PRIVATE KEY-----", // PEM
  ].join("|")
);

const MASK = "••••redacted••••";

export function redactValue(key: string, val: unknown): string {
  if (SECRET_KEY.test(key)) return MASK;
  let s = typeof val === "string" ? val : JSON.stringify(val);
  if (s === undefined) s = String(val);
  if (typeof val === "string" && SECRET_VAL.test(val)) return MASK;
  return s;
}

/**
 * Compact one-line preview like `url=https://example.com  method=GET`.
 * Returns undefined when there's nothing meaningful to show.
 */
export function previewCall(method: string, params: unknown): string | undefined {
  const p = params as Record<string, unknown> | null | undefined;
  const args: unknown =
    p && typeof p === "object" && p.arguments && typeof p.arguments === "object" ? p.arguments : p;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;

  const entries = Object.entries(args as Record<string, unknown>);
  if (!entries.length) return undefined;

  // Surface the most "where/what" fields first so the target is obvious.
  const PRIORITY = ["url", "uri", "href", "endpoint", "path", "query", "q", "repo", "repository", "owner", "file", "name"];
  entries.sort((a, b) => {
    const ai = PRIORITY.indexOf(a[0].toLowerCase());
    const bi = PRIORITY.indexOf(b[0].toLowerCase());
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });

  const parts: string[] = [];
  for (const [k, v] of entries.slice(0, 4)) {
    let val = redactValue(k, v);
    if (val.length > 90) val = val.slice(0, 90) + "…";
    parts.push(`${k}=${val}`);
  }
  let s = parts.join("  ");
  if (s.length > 220) s = s.slice(0, 220) + "…";
  return s || undefined;
}
