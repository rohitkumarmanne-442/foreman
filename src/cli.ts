#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  handleClaudeCodeHook,
  installClaudeCodeHooks,
  uninstallClaudeCodeHooks,
} from "./hooks/claude-code.js";
import { handleCursorHook, installCursorHooks, uninstallCursorHooks } from "./hooks/cursor.js";
import { runProxy, trustServer } from "./mcp/proxy.js";
import { startServer } from "./server.js";
import { buildCards } from "./cards.js";
import { readEvents } from "./journal.js";
import { verifyReceipt, type ReceiptBody } from "./mcp/receipts.js";
import { FOREMAN_HOME } from "./paths.js";
import { loadConfig, CONFIG_PATH, DEFAULTS } from "./config.js";
import type { McpCallData } from "./types.js";

const HELP = `
  🧑‍🏭 foreman — the review inbox for your AI workforce

  GET STARTED
    foreman init [--agent claude|cursor|gemini|opencode|all] [--global]
                                 install native hooks (default: all agents, this repo)
    foreman ui [--port 4517]     open the review inbox (reuses a running server;
                                 always opens your browser)
    foreman shortcut             Start Menu + Desktop shortcut (Win) / launcher (Linux)
    foreman run [--name codex] -- <agent command...>
                                 supervise ANY terminal agent (Codex, Gemini, Copilot, aider…)
    foreman watch [path]         watch a repo continuously — works with any IDE/agent
    foreman demo [--clear]       seed (or remove) showcase data to explore the inbox

  THE FEEDBACK LOOP
    foreman brief [path]         print outstanding human flags for a repo (agents read this;
                                 injected automatically into Claude Code sessions)
    foreman gate [--level high]  exit 1 if unapproved risky sessions exist — for CI/pre-push
    foreman pr [--session id] [--pr N] [--print]
                                 post a session-evidence comment on the PR (gh), or --print it
    foreman tray                 system-tray inbox with critical-card balloons (Windows)
    foreman ingest               journal normalized JSON events from ANY tool (stdin)

  MCP ATTESTATION
    foreman wrap --name <srv> -- <command...>
                                 run an MCP server behind the attestation proxy
    foreman trust <srv>          accept a server's current tools as the new baseline
    foreman verify               verify every receipt signature + chain continuity

  TEAM
    foreman team sync            export my cards for this repo + import teammates'
                                 (signed packs in .foreman-team/ — git is the sync)

  EVERYTHING ELSE
    foreman status               one-screen summary in the terminal
    foreman report [--out f.md]  markdown audit report of all sessions
    foreman report --sarif [--out f.sarif]
                                 findings as SARIF → native GitHub PR annotations
    foreman config               show config file path + active settings
    foreman uninstall [--global] remove Foreman hooks from this repo (or user level)
    foreman version              print version

  DATA
    everything lives in ${FOREMAN_HOME} — plain JSONL, greppable, yours.
`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pkgRoot(): string {
  const here = new URL(import.meta.url).pathname;
  const decoded = decodeURIComponent(here.replace(/^\/([A-Za-z]:)/, "$1"));
  return path.dirname(path.dirname(decoded)); // dist/cli.js -> package root
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const isGlobal = process.argv.includes("--global");

  if (cmd === "hook" || cmd === "ingest") {
    const agent = cmd === "ingest" ? "generic" : process.argv[3];
    if (agent === "claude-code") await handleClaudeCodeHook();
    else if (agent === "cursor") await handleCursorHook();
    else if (agent === "gemini") {
      const { handleGeminiHook } = await import("./hooks/gemini.js");
      await handleGeminiHook();
    } else if (agent === "codex") {
      const { handleCodexNotify } = await import("./hooks/codex.js");
      await handleCodexNotify();
    } else if (agent === "generic") {
      const { handleGenericHook } = await import("./hooks/generic.js");
      await handleGenericHook();
    }
    return; // always exit 0 — hooks must never break the agent
  }

  if (cmd === "pr") {
    const { buildPrComment, findCard, postToGitHub } = await import("./pr.js");
    const repo = arg("--repo") ?? process.cwd();
    const card = findCard(repo, arg("--session"));
    if (!card) {
      console.error("No session found for this repo. Run your agent first (or pass --session <id>).");
      process.exit(1);
    }
    const comment = buildPrComment(card);
    if (process.argv.includes("--print")) {
      console.log(comment);
      return;
    }
    try {
      const out = postToGitHub(repo, comment, arg("--pr"));
      console.log(`✅ Evidence comment posted${out ? ` → ${out}` : ""}`);
      console.log(`   Session ${card.session.slice(0, 12)} · ${card.level.toUpperCase()} ${card.score} · review: ${card.review}`);
    } catch (err) {
      console.error("Could not post via the GitHub CLI (`gh pr comment`).");
      console.error("Is gh installed + authenticated, and does this branch have an open PR?");
      console.error("Tip: `foreman pr --print` prints the comment so you can paste it anywhere.");
      process.exit(1);
    }
    return;
  }

  if (cmd === "tray") {
    const { runTray } = await import("./tray.js");
    const iconPng = path.join(pkgRoot(), "ui", "tray.png");
    runTray(
      Number(arg("--port") ?? process.env.FOREMAN_PORT ?? loadConfig().port),
      fs.existsSync(iconPng) ? iconPng : undefined
    );
    return;
  }

  if (cmd === "run") {
    const { runAgent } = await import("./run.js");
    const label = arg("--name") ?? "cli-agent";
    const sep = process.argv.indexOf("--");
    const command = sep >= 0 ? process.argv.slice(sep + 1) : [];
    if (!command.length) {
      console.error("usage: foreman run [--name codex] -- <agent command...>");
      process.exit(1);
    }
    try {
      runAgent(label, command, Number(arg("--interval") ?? 1500));
    } catch {
      console.error("foreman run needs a git repository (it diffs against HEAD). Run `git init` first.");
      process.exit(1);
    }
    return;
  }

  if (cmd === "brief") {
    const { buildBrief } = await import("./feedback.js");
    const target = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : process.cwd();
    const brief = buildBrief(target);
    console.log(brief ?? "No outstanding flags for this repo. 🧑‍🏭");
    return;
  }

  if (cmd === "gate") {
    const { sameRepo } = await import("./feedback.js");
    const levelArg = (arg("--level") ?? "high").toLowerCase();
    const rank: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    const threshold = rank[levelArg] ?? 2;
    const repo = arg("--repo") ?? process.cwd();
    const offenders = buildCards().filter(
      (c) =>
        c.review !== "approved" &&
        !c.session.startsWith("demo-") &&
        sameRepo(c.cwd, repo) &&
        rank[c.level] >= threshold
    );
    if (offenders.length) {
      console.error(`🧑‍🏭 GATE FAILED — ${offenders.length} unapproved session(s) at ${levelArg}+ risk in ${repo}:`);
      for (const c of offenders) {
        console.error(`   [${c.level} ${c.score}] ${c.session}  (${c.findings.length} findings)`);
        for (const f of c.findings.slice(0, 2)) console.error(`      · ${f.rule}: ${f.detail.slice(0, 90)}`);
      }
      console.error(`   Review them:  foreman ui`);
      process.exit(1);
    }
    console.log(`🧑‍🏭 Gate clear — no unapproved ${levelArg}+ sessions for ${repo}.`);
    return;
  }

  if (cmd === "team") {
    const sub = process.argv[3];
    if (sub !== "sync") {
      console.error("usage: foreman team sync   (run inside the shared repo)");
      process.exit(1);
    }
    const { exportPack, importPacks } = await import("./team.js");
    const repo = process.cwd();
    try {
      const exp = exportPack(repo);
      const imp = importPacks(repo);
      console.log(`✅ Exported ${exp.sessions} of your session(s) → ${exp.file}`);
      console.log(`✅ Imported ${imp.imported_events} new event(s) from ${imp.packs} teammate pack(s).`);
      for (const bad of imp.skipped_invalid) console.log(`   ⚠ skipped ${bad} — signature or format invalid`);
      console.log(`   Commit .foreman-team/ so teammates get your cards on their next sync.`);
    } catch (err) {
      console.error(`team sync failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "init") {
    const agent = (arg("--agent") ?? "all").toLowerCase();
    const installed: string[] = [];
    if (agent === "claude" || agent === "claude-code" || agent === "all") {
      installed.push(`Claude Code → ${installClaudeCodeHooks({ global: isGlobal })}`);
    }
    if (agent === "cursor" || agent === "all") {
      installed.push(`Cursor      → ${installCursorHooks({ global: isGlobal })}`);
    }
    if (agent === "gemini" || agent === "all") {
      const { installGeminiHooks } = await import("./hooks/gemini.js");
      installed.push(`Gemini CLI  → ${installGeminiHooks({ global: isGlobal })}`);
    }
    if (agent === "opencode" || agent === "all") {
      const { installOpenCodeAdapter } = await import("./hooks/opencode.js");
      installed.push(`OpenCode    → ${installOpenCodeAdapter({ global: isGlobal })}`);
    }
    if (!installed.length) {
      console.error(`Unknown agent "${agent}". Use: claude | cursor | gemini | opencode | all`);
      process.exit(1);
    }
    if (!isGlobal) {
      const { installVsCodeTask } = await import("./ide.js");
      const task = installVsCodeTask();
      if (task) installed.push(`VS Code/Cursor → "Foreman: Open Inbox" task (Terminal → Run Task)`);
    }
    console.log(`✅ Foreman hooks installed for ${isGlobal ? "ALL repos" : "this repo"}:\n`);
    for (const line of installed) console.log(`   ${line}`);
    console.log(`\n   Using another IDE or agent? Universal mode works with everything:`);
    console.log(`     foreman watch`);
    console.log(`\n   Open the inbox:  foreman ui`);
    return;
  }

  if (cmd === "shortcut") {
    const { createShortcuts } = await import("./ide.js");
    const made = createShortcuts();
    if (made.length) {
      console.log(`✅ One-click Foreman:`);
      for (const f of made) console.log(`   ${f}`);
    } else {
      console.log(`On macOS the menu bar is the native home: run \`foreman tray\` (xbar/SwiftBar).`);
      console.log(`You can also install the inbox as an app: open it in Chrome/Edge → menu → Install Foreman.`);
    }
    return;
  }

  if (cmd === "uninstall") {
    const { uninstallGeminiHooks } = await import("./hooks/gemini.js");
    const { uninstallOpenCodeAdapter } = await import("./hooks/opencode.js");
    const { uninstallVsCodeTask } = await import("./ide.js");
    if (!isGlobal) uninstallVsCodeTask();
    const removed = [
      uninstallClaudeCodeHooks({ global: isGlobal }),
      uninstallCursorHooks({ global: isGlobal }),
      uninstallGeminiHooks({ global: isGlobal }),
      uninstallOpenCodeAdapter({ global: isGlobal }),
    ].some(Boolean);
    console.log(
      removed
        ? `✅ Foreman hooks removed (${isGlobal ? "user level" : "this repo"}). Your journal in ${FOREMAN_HOME} is untouched.`
        : "No Foreman hooks found to remove."
    );
    return;
  }

  if (cmd === "ui") {
    const port = Number(arg("--port") ?? process.env.FOREMAN_PORT ?? loadConfig().port);
    startServer(port);
    const url = `http://127.0.0.1:${port}`;
    console.log(`🧑‍🏭 Foreman inbox → ${url}  (Ctrl+C to stop)`);
    const opener =
      process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
      process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    try {
      spawn(opener[0] as string, opener[1] as string[], { stdio: "ignore", detached: true }).unref();
    } catch { /* no browser available — URL printed above */ }
    return;
  }

  if (cmd === "watch") {
    const { runWatch } = await import("./watch.js");
    const target = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : process.cwd();
    const interval = Number(arg("--interval") ?? 3000);
    try {
      runWatch(target, interval);
    } catch {
      console.error(`"${target}" is not a git repository — universal mode diffs against git HEAD.`);
      console.error(`Run "git init && git add -A && git commit -m baseline" first.`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "wrap") {
    const name = arg("--name") ?? "unnamed-server";
    const sep = process.argv.indexOf("--");
    const command = sep >= 0 ? process.argv.slice(sep + 1) : [];
    if (!command.length) {
      console.error("usage: foreman wrap --name <server> -- <command...>");
      process.exit(1);
    }
    runProxy(name, command);
    return; // keeps running until the wrapped server exits
  }

  if (cmd === "trust") {
    const name = process.argv[3];
    if (!name) { console.error("usage: foreman trust <server>"); process.exit(1); }
    const found = trustServer(name);
    console.log(found
      ? `✅ Baseline cleared for "${name}" — next tools/list becomes the new trusted baseline.`
      : `No baseline found for "${name}" (nothing to trust yet).`);
    return;
  }

  if (cmd === "verify") {
    const { verifyAll } = await import("./verifyall.js");
    const r = verifyAll();
    console.log(`Receipts: ${r.total} total`);
    console.log(`  signatures : ${r.sig_valid} valid, ${r.sig_broken.length} broken${r.sig_broken.length ? "  ← " + r.sig_broken.slice(0, 3).join(", ") : ""}`);
    if (r.chained > 0) {
      console.log(`  chain      : ${r.chained} chained receipt(s), ${r.chain_breaks.length} break(s)${r.head_matches === false ? " — head mismatch (journal newer than chain head?)" : ""}`);
      for (const b of r.chain_breaks.slice(0, 5)) console.log(`     ✗ ${b.receipt_id}: ${b.reason}`);
    } else {
      console.log(`  chain      : no chained receipts yet (chains start with your next foreman wrap call)`);
    }
    if (r.sig_broken.length || r.chain_breaks.length) process.exit(2);
    console.log(`  ✅ history intact`);
    return;
  }

  if (cmd === "demo") {
    const { seedDemo, clearDemo } = await import("./demo.js");
    process.argv.includes("--clear") ? clearDemo() : seedDemo();
    return;
  }

  if (cmd === "config") {
    const cfg = loadConfig(true);
    console.log(`\n  Config file: ${CONFIG_PATH()}`);
    console.log(fs.existsSync(CONFIG_PATH()) ? "  (exists)" : "  (not created yet — defaults active; create it to customise)");
    console.log(`\n  Active settings:\n${JSON.stringify(cfg, null, 2)}`);
    console.log(`\n  Defaults for reference:\n${JSON.stringify(DEFAULTS, null, 2)}\n`);
    return;
  }

  if (cmd === "report") {
    const out = arg("--out");
    const cards = buildCards();
    if (process.argv.includes("--sarif")) {
      const { buildSarif } = await import("./sarif.js");
      const sarif = JSON.stringify(buildSarif(cards.filter((c) => !c.session.startsWith("demo-"))), null, 2);
      if (out) { fs.writeFileSync(out, sarif, "utf8"); console.log(`✅ SARIF written → ${out} (upload with github/codeql-action/upload-sarif)`); }
      else console.log(sarif);
      return;
    }
    const lines: string[] = [
      `# Foreman audit report — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      "",
      `${cards.length} session(s). ${cards.filter((c) => c.review === "approved").length} approved, ${cards.filter((c) => c.review === "flagged").length} flagged, ${cards.filter((c) => c.review === "pending").length} pending.`,
      "",
    ];
    for (const c of cards) {
      lines.push(`## ${c.cwd} — ${c.level.toUpperCase()} ${c.score} (${c.agent})`);
      lines.push(`- session \`${c.session}\` · ${c.started}${c.open ? " · still running" : ""} · review: **${c.review}**`);
      if (c.files.length) lines.push(`- files: ${c.files.map((f) => `\`${f.path}\` (${f.lines_before ?? "—"}→${f.lines_after ?? "—"})`).join(", ")}`);
      if (c.commands.length) lines.push(`- commands: ${c.commands.length} (${c.commands.filter((k) => k.verification).length} verification)`);
      for (const cl of c.claims) lines.push(`- claim ${c.verified_claims ? "✅" : "❓"} “${cl}”`);
      for (const f of c.findings) lines.push(`- ⚠ **${f.rule}** — ${f.detail}`);
      lines.push("");
    }
    const text = lines.join("\n");
    if (out) {
      fs.writeFileSync(out, text, "utf8");
      console.log(`✅ Report written → ${out}`);
    } else {
      console.log(text);
    }
    return;
  }

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
    );
    console.log(pkg.version);
    return;
  }

  if (cmd === "status") {
    const cards = buildCards();
    const open = cards.filter((c) => c.open).length;
    const byLevel = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const c of cards) byLevel[c.level]++;
    console.log(`\n  🧑‍🏭 Foreman — ${cards.length} session(s), ${open} running\n`);
    console.log(`     critical ${byLevel.critical}   high ${byLevel.high}   medium ${byLevel.medium}   low ${byLevel.low}\n`);
    for (const c of cards.slice(0, 10)) {
      const flag = { critical: "🟥", high: "🟧", medium: "🟨", low: "🟩" }[c.level];
      const claims = c.claims.length ? (c.verified_claims ? "claims ✅" : "claims ⚠️ UNVERIFIED") : "";
      console.log(`  ${flag} [${String(c.score).padStart(3)}] ${c.cwd}  files:${c.files.length} cmds:${c.commands.length} ${claims}`);
      for (const f of c.findings.slice(0, 3)) console.log(`       · ${f.rule}: ${f.detail.slice(0, 100)}`);
    }
    console.log(`\n  full detail: foreman ui\n`);
    return;
  }

  console.log(HELP);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
