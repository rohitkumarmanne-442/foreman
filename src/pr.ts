import { execFileSync } from "node:child_process";
import { buildCards } from "./cards.js";
import { sameRepo } from "./feedback.js";
import { lineCountText } from "./lines.js";
import type { ReviewCard } from "./types.js";

function fmtSpan(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

// local machine time, matching what the reviewer sees in the inbox UI
const fmtTs = (ts?: string) => {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Each finding becomes something the reviewer can actually DO before merging. */
function checklistItem(rule: string, detail: string): string {
  switch (rule) {
    case "destructive_command":
      return `Confirm this destructive command targeted exactly what was intended: ${detail.includes("`") ? detail.slice(detail.indexOf("`")) : `\`${detail}\``}`;
    case "mass_rewrite":
      return `Large rewrite — ${detail}. Diff the file and confirm nothing working was deleted.`;
    case "secret_in_code":
      return `Rotate the leaked credential (${detail}) and move it to env/secret storage before merging.`;
    case "unverified_claims":
      return `The agent claimed success without proof — run the tests/build yourself before trusting it.`;
    case "failed_verification":
      return `The agent's own checks FAILED yet it claimed success — re-run locally and read the output.`;
    case "sensitive_path":
      return `Security-sensitive change (${detail}) — review with extra care.`;
    case "untested_change":
      return `This code was never compiled or executed in the session — build & test locally.`;
    case "mcp_tool_drift":
      return `An MCP server changed its tool definitions mid-flight — re-inspect and \`foreman trust\` it again.`;
    default:
      return `${rule}: ${detail}`;
  }
}

/**
 * PR write-back: turn a review card into a markdown comment a reviewer would
 * actually trust — verdict, what-to-check-first list, claims-vs-evidence,
 * files with recency, full command log, and an actionable checklist.
 * `foreman pr` posts it via the GitHub CLI; the inbox has a copy button for
 * everything else (GitLab, Bitbucket, email, carrier pigeon).
 */
export function buildPrComment(card: ReviewCard): string {
  const emoji = { critical: "🟥", high: "🟧", medium: "🟨", low: "🟩" }[card.level];
  const sevIcon = (s: number) => (s >= 4 ? "🟥" : s >= 3 ? "🟧" : s >= 2 ? "🟨" : "▫️");
  const verdict =
    card.review === "approved"
      ? "✅ **Human-approved** in the Foreman inbox"
      : card.review === "flagged"
        ? `⚑ **Flagged by reviewer**${card.review_note ? ` — “${card.review_note}”` : ""}`
        : "⏳ **Pending human review** — no one has signed this off yet";
  const verifs = card.commands.filter((c) => c.verification);
  const verifsOk = verifs.filter((c) => c.ok).length;

  const lines: string[] = [
    `## 🧑‍🏭 Foreman session evidence`,
    "",
    `${emoji} **Risk: ${card.level.toUpperCase()} (${card.score}/100)** · agent \`${card.agent}\`${card.origin ? ` (👥 ${card.origin})` : ""} · session \`${card.session.slice(0, 12)}\``,
    `**Span:** ${fmtTs(card.started)} → ${fmtTs(card.last_activity)} (${fmtSpan(card.started, card.last_activity)}) · **${card.files.length}** files · **${card.commands.length}** commands${card.mcp_calls ? ` · **${card.mcp_calls}** attested MCP calls` : ""}`,
    "",
    verdict,
    "",
  ];

  if (card.findings.length) {
    const sorted = [...card.findings].sort((a, b) => b.severity - a.severity);
    lines.push(`### ⚠️ What needs eyes first`, "", "| | Rule | Detail |", "|---|---|---|");
    for (const f of sorted) lines.push(`| ${sevIcon(f.severity)} | \`${f.rule}\` | ${f.detail} |`);
    lines.push("");
  }

  if (card.claims.length) {
    lines.push(`### Claims vs evidence`);
    for (const c of card.claims.slice(0, 5)) lines.push(`> “${c}”`);
    lines.push(
      "",
      card.verified_claims
        ? `✅ Backed by evidence — **${verifsOk}/${verifs.length}** verification command(s) passed.`
        : `❓ **UNVERIFIED** — the agent claimed success but **zero** verification commands passed in this session.`,
      ""
    );
    if (verifs.length) {
      for (const c of verifs.slice(0, 8)) lines.push(`- ${c.ok ? "✅" : "❌"} \`${c.command.slice(0, 140)}\``);
      lines.push("");
    }
  }

  if (card.files.length) {
    const rows = card.files.map((f) => {
      const cut =
        f.lines_before !== undefined &&
        f.lines_after !== undefined &&
        f.lines_before >= 50 &&
        f.lines_after < f.lines_before * 0.4;
      return `| \`${f.path}\` | ${f.action}${(f.touches ?? 1) > 1 ? ` ×${f.touches}` : ""} | ${lineCountText(f)}${cut ? " ⚠️" : ""} | ${fmtTs(f.last_ts)} |`;
    });
    const header = ["| File | Action | Lines (before → after) | Last edited |", "|---|---|---|---|"];
    lines.push(`### Files touched (${card.files.length}) — most recent first`, "");
    if (rows.length <= 12) lines.push(...header, ...rows, "");
    else {
      lines.push(...header, ...rows.slice(0, 8), "");
      lines.push(`<details><summary>… and ${rows.length - 8} more files</summary>`, "", ...header, ...rows.slice(8), "", `</details>`, "");
    }
  }

  if (card.commands.length) {
    lines.push(
      `<details><summary><b>Command log</b> — ${card.commands.length} run, ${verifs.length} verification (${verifsOk} passing)</summary>`,
      ""
    );
    for (const c of card.commands.slice(0, 40)) lines.push(`- ${c.ok ? "✓" : "✗"} \`${c.command.slice(0, 140)}\`${c.verification ? " **[verify]**" : ""}`);
    if (card.commands.length > 40) lines.push(`- … ${card.commands.length - 40} more`);
    lines.push("", `</details>`, "");
  }

  const checklist: string[] = [];
  const seen = new Set<string>();
  for (const f of [...card.findings].sort((a, b) => b.severity - a.severity)) {
    const item = checklistItem(f.rule, f.detail);
    if (!seen.has(item)) { seen.add(item); checklist.push(item); }
  }
  if (!card.verified_claims && card.claims.length && !card.findings.some((f) => f.rule === "unverified_claims"))
    checklist.push("Run the tests/build yourself — the agent's success claims are unverified.");
  if (checklist.length) {
    lines.push(`### Reviewer checklist`);
    for (const item of checklist) lines.push(`- [ ] ${item}`);
    lines.push("");
  }

  if (card.mcp_calls > 0) {
    lines.push(`_${card.mcp_calls} MCP call(s) carry ed25519-signed, hash-chained receipts — audit anytime with \`foreman verify\`._`, "");
  }
  lines.push(
    `---`,
    `_Generated by [Foreman](https://github.com/rohitkumarmanne-442/foreman) — your agents say “done.” Foreman says “prove it.”_`
  );
  return lines.join("\n");
}

export function findCard(repo: string, sessionId?: string): ReviewCard | undefined {
  const cards = buildCards().filter((c) => !c.session.startsWith("demo-"));
  if (sessionId) return cards.find((c) => c.session === sessionId || c.session.startsWith(sessionId));
  return cards.filter((c) => sameRepo(c.cwd, repo)).sort((a, b) => b.started.localeCompare(a.started))[0];
}

/** Post the comment with the GitHub CLI. Returns the gh output. */
export function postToGitHub(repo: string, comment: string, prNumber?: string): string {
  const args = ["pr", "comment"];
  if (prNumber) args.push(prNumber);
  args.push("--body-file", "-");
  return execFileSync("gh", args, {
    cwd: repo,
    input: comment,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}
