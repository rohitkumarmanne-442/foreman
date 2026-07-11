import type { Finding, ReviewCard, RiskLevel } from "./types.js";
import { loadConfig } from "./config.js";

const DESTRUCTIVE_SHELL: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, "recursive force delete (rm -rf)"],
  [/\bgit\s+push\s+[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/i, "git force push"],
  [/\bgit\s+reset\s+--hard\b/i, "git reset --hard"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "git clean -f"],
  [/\bgit\s+checkout\s+--\s/i, "git checkout -- (discards local changes)"],
  [/\bgit\s+branch\s+-D\b/i, "git branch -D (force-deletes a branch)"],
  [/\bgit\s+stash\s+(drop|clear)\b/i, "git stash drop/clear"],
  [/\bdrop\s+(table|database|schema)\b/i, "SQL DROP statement"],
  [/\btruncate\s+table\b/i, "SQL TRUNCATE statement"],
  [/\bdelete\s+from\s+\w+\s*(;|$)(?![\s\S]*\bwhere\b)/i, "SQL DELETE without WHERE"],
  [/\bRemove-Item\b[^\n]*-Recurse\b[^\n]*-Force\b/i, "recursive force delete (Remove-Item)"],
  [/\brmdir\s+\/s\b/i, "recursive directory delete"],
  [/\bdel\s+\/[fs]\b/i, "force delete (del /f|/s)"],
  [/\bmkfs\b|\bformat\s+[a-z]:|Format-Volume/i, "filesystem format"],
  [/\bkubectl\s+delete\b/i, "kubectl delete"],
  [/\bterraform\s+destroy\b/i, "terraform destroy"],
  [/\baws\s+s3\s+(rm|rb)\b[^\n]*(--recursive|--force)/i, "recursive S3 delete"],
  [/\bdocker\s+(system|volume|container)\s+prune\b[^\n]*-f/i, "docker prune -f"],
  [/\bchmod\s+-R\s+777\b/, "chmod -R 777 (world-writable tree)"],
  [/\bdd\s+if=/i, "raw disk write (dd)"],
];

const SENSITIVE_PATH = /(^|[\\/])(\.env[^\\/]*|.*secret[^\\/]*|.*credential[^\\/]*|auth[^\\/]*|.*password[^\\/]*|migrations?([\\/]|$)|\.github[\\/]workflows|\.ssh([\\/]|$)|id_rsa|\.npmrc|\.pypirc)/i;

const SECRET_CONTENT: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/-----BEGIN\s+(RSA|EC|OPENSSH|PGP)?\s*PRIVATE KEY-----/, "private key material"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/\bsk-(live|test|proj)?[_-]?[A-Za-z0-9_-]{20,}/, "API secret key (sk-...)"],
  [/\bpk_live_[A-Za-z0-9]{20,}/, "Stripe live key"],
  [/\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{36,}/, "GitHub personal access token"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, "GitLab personal access token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "npm token"],
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, "SendGrid API key"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/, "hardcoded JWT"],
  [/\b(password|passwd|db_pass(word)?)\s*[:=]\s*["'][^"'\n]{8,}["']/i, "hardcoded password"],
];

const CODE_FILE = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|cs|c|cpp|h|sql|sh|ps1|vue|svelte)$/i;

export interface RiskInput {
  files: ReviewCard["files"];
  commands: ReviewCard["commands"];
  claims: string[];
  contentSamples: Array<{ file: string; sample: string }>;
  mcpDrifts: number;
}

export function assessRisk(input: RiskInput): {
  findings: Finding[];
  score: number;
  level: RiskLevel;
  verifiedClaims: boolean;
} {
  const cfg = loadConfig();
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (f: Finding) => {
    if (cfg.disable_rules.includes(f.rule)) return;
    const key = `${f.rule}|${f.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  // 1. Destructive shell commands
  for (const c of input.commands) {
    for (const [pattern, label] of DESTRUCTIVE_SHELL) {
      if (pattern.test(c.command)) {
        add({
          rule: "destructive_command",
          severity: 4,
          detail: `${label}: \`${c.command.slice(0, 160)}\``,
        });
        break;
      }
    }
  }

  // 2. Mass rewrite — a large existing file replaced by a much smaller one.
  //    Two detection paths: Write before/after line counts (Claude Code,
  //    watcher) and huge old→small new edit pairs (Cursor-style edits).
  const minLines = cfg.mass_rewrite_min_lines;
  const ratio = cfg.mass_rewrite_ratio;
  for (const f of input.files) {
    if (
      f.action === "write" &&
      (f.lines_before ?? 0) >= minLines &&
      f.lines_after !== undefined &&
      f.lines_after < (f.lines_before ?? 0) * ratio
    ) {
      add({
        rule: "mass_rewrite",
        severity: 4,
        detail: `${f.path} rewritten ${f.lines_before}→${f.lines_after} lines (${Math.round(
          (1 - f.lines_after / (f.lines_before || 1)) * 100
        )}% of the file deleted)`,
      });
    }
    for (const e of f.edits ?? []) {
      const oldLines = e.old ? e.old.split("\n").length : 0;
      const newLines = e.new ? e.new.split("\n").length : 0;
      if (oldLines >= minLines && newLines < oldLines * ratio) {
        add({
          rule: "mass_rewrite",
          severity: 4,
          detail: `${f.path}: a single edit replaced ${oldLines} lines with ${newLines}`,
        });
      }
    }
  }

  // 3. Sensitive paths touched
  for (const f of input.files) {
    if (SENSITIVE_PATH.test(f.path)) {
      add({ rule: "sensitive_path", severity: 3, detail: `touched sensitive path: ${f.path}` });
    }
  }

  // 4. Secret material written
  for (const { file, sample } of input.contentSamples) {
    for (const [pattern, label] of SECRET_CONTENT) {
      if (pattern.test(sample)) {
        add({ rule: "secret_in_code", severity: 4, detail: `${label} written into ${file}` });
        break;
      }
    }
  }

  // 5. Claims vs evidence
  const codeTouched = input.files.some((f) => CODE_FILE.test(f.path));
  const verifications = input.commands.filter((c) => c.verification);
  const passingVerifications = verifications.filter((c) => c.ok);
  const verifiedClaims = input.claims.length > 0 && passingVerifications.length > 0;
  if (input.claims.length > 0 && verifications.length === 0) {
    add({
      rule: "unverified_claims",
      // a claim with no code change behind it (Q&A, analysis) is much less risky
      severity: codeTouched ? 3 : 2,
      detail: `agent claimed success (“${input.claims[0].slice(0, 120)}”) but ran zero verification commands`,
    });
  } else if (input.claims.length > 0 && passingVerifications.length === 0 && verifications.length > 0) {
    add({
      rule: "failed_verification",
      severity: 4,
      detail: "agent claimed success but its verification commands failed",
    });
  }

  // 6. Code changed with no commands run at all
  if (codeTouched && input.commands.length === 0) {
    add({
      rule: "untested_change",
      severity: 2,
      detail: "code files changed but no command was ever executed (nothing compiled, nothing run)",
    });
  }

  // 7. MCP tool drift during this window
  if (input.mcpDrifts > 0) {
    add({
      rule: "mcp_tool_drift",
      severity: 3,
      detail: `${input.mcpDrifts} MCP server(s) changed their tool definitions vs the trusted baseline (possible rug pull)`,
    });
  }

  const weights: Record<number, number> = { 4: 40, 3: 25, 2: 10, 1: 5 };
  const score = Math.min(
    100,
    findings.reduce((acc, f) => acc + weights[f.severity], 0)
  );
  const level: RiskLevel =
    score >= 70 ? "critical" : score >= 40 ? "high" : score >= 15 ? "medium" : "low";

  return { findings, score, level, verifiedClaims };
}
