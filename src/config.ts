import fs from "node:fs";
import path from "node:path";
import { FOREMAN_HOME } from "./paths.js";

/** User-tunable settings, stored at ~/.foreman/config.json. Every field is
 * optional; missing fields fall back to the defaults below. */
export interface ForemanConfig {
  port: number;
  /** Substring or simple glob (*) patterns — matching file paths are ignored entirely. */
  ignore: string[];
  /** Risk rules to disable, e.g. ["untested_change"]. */
  disable_rules: string[];
  /** A Write to an existing file with at least this many lines can count as a mass rewrite… */
  mass_rewrite_min_lines: number;
  /** …when the new content is below this fraction of the original. */
  mass_rewrite_ratio: number;
  /** Shell command run when a NEW critical card appears (env: FOREMAN_SESSION/LEVEL/SCORE/REPO). */
  notify_command?: string;
  /** Incoming-webhook URL (Slack / Teams / anything accepting {"text": ...}) — posted on NEW critical cards. */
  notify_webhook?: string;
  /** Create a Jira issue when flagging a card (token read from the env var named in token_env). */
  jira?: { base_url: string; email: string; project: string; token_env?: string };
  /** Adaptive Autopilot — auto-approve LOW-risk sessions from agents that have
   * earned trust, so review effort shrinks as agents keep proving themselves. */
  autopilot?: { enabled: boolean; min_sessions: number; min_verified_pct: number };
}

/** Fields the settings UI may write. Everything else is CLI/file-only. */
export const EDITABLE_FIELDS = [
  "ignore", "disable_rules", "mass_rewrite_min_lines", "mass_rewrite_ratio",
  "notify_command", "notify_webhook", "jira", "autopilot",
] as const;

export function saveConfig(patch: Partial<ForemanConfig>): ForemanConfig {
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(fs.readFileSync(CONFIG_PATH(), "utf8")); } catch { /* fresh file */ }
  for (const key of EDITABLE_FIELDS) {
    if (!(key in patch)) continue;
    const v = (patch as Record<string, unknown>)[key];
    if (v === undefined || v === null || v === "") delete current[key];
    else current[key] = v;
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(current, null, 2), "utf8");
  return loadConfig(true);
}

export const DEFAULTS: ForemanConfig = {
  port: 4517,
  ignore: ["node_modules/", "dist/", ".git/", "package-lock.json", "*.lock", "*.min.js"],
  disable_rules: [],
  mass_rewrite_min_lines: 50,
  mass_rewrite_ratio: 0.4,
  autopilot: { enabled: false, min_sessions: 5, min_verified_pct: 80 },
};

export const CONFIG_PATH = () => path.join(FOREMAN_HOME, "config.json");

let cached: ForemanConfig | null = null;

export function loadConfig(force = false): ForemanConfig {
  if (cached && !force) return cached;
  let user: Partial<ForemanConfig> = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH(), "utf8"));
  } catch {
    // no config file — defaults apply
  }
  cached = {
    ...DEFAULTS,
    ...user,
    ignore: user.ignore ?? DEFAULTS.ignore,
    disable_rules: user.disable_rules ?? DEFAULTS.disable_rules,
  };
  return cached;
}

/** Simple matcher: plain substrings match anywhere; '*' works as a wildcard. */
export function isIgnored(filePath: string, cfg = loadConfig()): boolean {
  const p = filePath.replace(/\\/g, "/");
  return cfg.ignore.some((pat) => {
    const norm = pat.replace(/\\/g, "/");
    if (norm.includes("*")) {
      const re = new RegExp(
        norm.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")
      );
      return re.test(p);
    }
    return p.includes(norm);
  });
}
