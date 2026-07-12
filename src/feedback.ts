import path from "node:path";
import { buildCards } from "./cards.js";

/** Is `cardCwd` the same repo as `repo` (either contains the other)? */
export function sameRepo(cardCwd: string, repo: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const a = norm(cardCwd);
  const b = norm(repo);
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

/**
 * The feedback loop: everything a human flagged in this repo, formatted for an
 * agent to read. Injected into Claude Code sessions via the SessionStart hook;
 * any other agent can get it with `foreman brief` (or a rules-file pointer).
 * Returns null when there is nothing outstanding — silence is the default.
 */
export function buildBrief(repo: string): string | null {
  const flagged = buildCards().filter(
    (c) => c.review === "flagged" && sameRepo(c.cwd, repo)
  );
  if (!flagged.length) return null;

  const lines: string[] = [
    `[FOREMAN REVIEW FEEDBACK] A human reviewer flagged ${flagged.length} previous AI session(s) in this repository. Read this before making changes:`,
    "",
  ];
  for (const c of flagged.slice(0, 5)) {
    lines.push(`— Flagged session from ${c.started.slice(0, 16).replace("T", " ")} (${c.agent}):`);
    if (c.review_note) lines.push(`  Reviewer's note: "${c.review_note}"`);
    for (const f of c.findings.slice(0, 4)) {
      lines.push(`  Finding [${f.rule}]: ${f.detail}`);
    }
    if (c.files.length) {
      lines.push(`  Files involved: ${c.files.slice(0, 6).map((f) => f.path).join(", ")}`);
    }
    lines.push("");
  }
  lines.push(
    "Do not repeat these mistakes. Do not re-apply flagged changes without explicit human approval. Prefer surgical edits over file rewrites, never run destructive commands without being asked, and verify your work (run the tests) before claiming success."
  );
  return lines.join("\n");
}
