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
import { lineCountText } from "./lines.js";
import { readEvents } from "./journal.js";
import { verifyReceipt, type ReceiptBody } from "./mcp/receipts.js";
import { FOREMAN_HOME } from "./paths.js";
import { loadConfig, CONFIG_PATH, DEFAULTS } from "./config.js";
import type { McpCallData } from "./types.js";

const HELP = `
  🧑‍🏭 foreman — the review inbox for your AI workforce

  GET STARTED
    foreman start                ⭐ the one command — turns on change tracking + MCP
                                 tracking + the inbox, for every agent. Run this first.
    foreman init [--agent claude|cursor|gemini|opencode|all] [--global]
                                 install just the change-tracking hooks (start does this)
    foreman ui [--port 4517]     open the review inbox (reuses a running server;
                                 always opens your browser)
    foreman shortcut             Start Menu + Desktop shortcut (Win) / launcher (Linux)
    foreman run [--name codex] -- <agent command...>
                                 supervise ANY terminal agent (Codex, Gemini, Copilot, aider…)
    foreman watch [path]         watch a repo continuously — works with any IDE/agent
    foreman demo [--clear]       seed (or remove) showcase data to explore the inbox
    foreman backfill [--days N]  import your EXISTING Claude Code history as review cards
    foreman wrapped [--days N]   shareable report card of your AI workforce (PNG)
    foreman badge                README badge markdown

  THE FEEDBACK LOOP
    foreman brief [path]         print outstanding human flags for a repo (agents read this;
                                 injected automatically into Claude Code sessions)
    foreman gate [--level high]  exit 1 if unapproved risky sessions exist — for CI/pre-push
    foreman pr [--session id] [--pr N] [--print]
                                 post a session-evidence comment on the PR (gh), or --print it
    foreman manifest [--session id] [-o foreman.manifest.json]
                                 signed provenance manifest for a PR/release (ed25519) —
                                 who did it, what changed, was it verified + approved
    foreman verify-manifest <file>
                                 verify a manifest offline — tamper-evident, no network
    foreman tray                 system-tray inbox with critical-card balloons (Windows)
    foreman ingest               journal normalized JSON events from ANY tool (stdin)

  MCP ATTESTATION
    foreman track add <name> <mcp-url>
                                 register an MCP server to track (local or web)
    foreman track                ONE relay in front of EVERY registered server —
                                 point any agent at http://127.0.0.1:4599/<name>
    foreman track ls | rm <name> list or remove tracked servers
    foreman wire [--dry-run]     auto-attest EVERY MCP server in your agents'
                                 configs (Claude/Cursor/Windsurf) — no URL-pasting
    foreman unwire               restore the original configs
    foreman wrap --name <srv> -- <command...>
                                 run a single stdio MCP server behind the proxy
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

  if (cmd === "start") {
    // ── The one command. Turns on everything important, no per-piece setup. ──
    // 1) CHANGE TRACKING — global agent hooks (idempotent). These fire on every
    //    agent action and persist even after this process stops.
    const agents: string[] = [];
    const tryInstall = (label: string, fn: () => string) => {
      try { fn(); agents.push(label); } catch { /* agent not present — skip */ }
    };
    tryInstall("Claude Code", () => installClaudeCodeHooks({ global: true }));
    tryInstall("Cursor", () => installCursorHooks({ global: true }));
    const { installGeminiHooks } = await import("./hooks/gemini.js");
    tryInstall("Gemini CLI", () => installGeminiHooks({ global: true }));
    const { installOpenCodeAdapter } = await import("./hooks/opencode.js");
    tryInstall("OpenCode", () => installOpenCodeAdapter({ global: true }));

    // 1b) UNIVERSAL coverage — quietly watch THIS repo so ANY other IDE/agent
    //     (Windsurf, JetBrains, Copilot-in-editor, a web agent editing local
    //     files…) is tracked here too, not just the four with native hooks.
    let watchLabel = "";
    try {
      const { createWatchState, pollOnce, endWatchSession } = await import("./watch.js");
      const ws = createWatchState(process.cwd(), "watch");
      // prime: record current file hashes WITHOUT journaling, so only edits
      // made AFTER start become review cards
      pollOnce(ws, (() => undefined) as unknown as Parameters<typeof pollOnce>[1]);
      const timer = setInterval(() => { try { pollOnce(ws); } catch { /* transient git */ } }, 3000);
      const stopWatch = () => { clearInterval(timer); try { endWatchSession(ws); } catch { /* nothing to close */ } };
      process.on("SIGINT", () => { stopWatch(); process.exit(0); });
      process.on("SIGTERM", stopWatch);
      watchLabel = path.basename(process.cwd());
    } catch { /* cwd isn't a git repo — native hooks still cover the 4 agents everywhere */ }

    // 2) MCP TRACKING — one relay in front of every registered server.
    const { loadServers } = await import("./servers.js");
    const { runTrackRelay, connectorUrl } = await import("./track.js");
    const servers = loadServers();
    let relayPort = 0;
    if (servers.length) {
      const r = await runTrackRelay(servers, Number(arg("--track-port") ?? 4599));
      relayPort = r.port;
    }

    // 3) INBOX — serve + open it.
    const uiPort = Number(arg("--port") ?? process.env.FOREMAN_PORT ?? loadConfig().port);
    startServer(uiPort);
    const uiUrl = `http://127.0.0.1:${uiPort}`;

    // ── one clean status ──
    console.log(`\n  🧑‍🏭  Foreman is on.\n`);
    console.log(`  ✓ Change tracking   native hooks: ${agents.length ? agents.join(", ") : "none detected"} — every edit journaled (persists)`);
    if (watchLabel) console.log(`  ✓ Universal watch   ${watchLabel}/ — ANY other IDE or agent editing here is tracked too`);
    else console.log(`  • Universal watch   run inside a git repo to also track non-native agents (or: foreman watch <path>)`);
    if (servers.length) {
      console.log(`  ✓ MCP tracking      relaying ${servers.length} server${servers.length === 1 ? "" : "s"} on 127.0.0.1:${relayPort}`);
      for (const s of servers) console.log(`      • ${s.name.padEnd(14)} point your agent at →  ${connectorUrl(relayPort, s.name)}`);
    } else {
      console.log(`  • MCP tracking      no servers yet — add one:  foreman track add <name> <mcp-url>`);
    }
    const { countUnwired } = await import("./wire.js");
    const unwired = countUnwired();
    if (unwired) console.log(`  • Attest MCP        ${unwired} MCP server(s) in your agents aren't attested yet — run:  foreman wire`);
    console.log(`  ✓ Inbox             ${uiUrl}\n`);
    console.log(`  Change tracking keeps running in the background. This window hosts the inbox + MCP relay — Ctrl+C to stop those.\n`);

    const opener =
      process.platform === "win32" ? ["cmd", ["/c", "start", "", uiUrl]] :
      process.platform === "darwin" ? ["open", [uiUrl]] : ["xdg-open", [uiUrl]];
    try { spawn(opener[0] as string, opener[1] as string[], { stdio: "ignore", detached: true }).unref(); } catch { /* headless */ }
    return; // keeps running (inbox + relay)
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

  if (cmd === "scan") {
    const { scanDiff, scanAsCard } = await import("./scan.js");
    const base = arg("--base") ?? "HEAD^";
    let scan;
    try { scan = scanDiff(base); }
    catch (e) { console.error(`scan failed — is this a git repo with '${base}' resolvable? ${e instanceof Error ? e.message : e}`); process.exit(1); }
    console.log(`🧑‍🏭 Diff scan vs ${base}: ${scan.files.length} file(s) · ${scan.level.toUpperCase()} ${scan.score}/100`);
    for (const f of scan.findings) console.log(`   ⚠ [sev ${f.severity}] ${f.rule}: ${f.detail}`);
    if (!scan.findings.length) console.log(`   ✓ nothing risky in this diff`);
    const sarifOut = arg("--sarif");
    if (sarifOut) {
      const { buildSarif } = await import("./sarif.js");
      fs.writeFileSync(sarifOut, JSON.stringify(buildSarif([scanAsCard(scan)]), null, 2), "utf8");
      console.log(`   SARIF → ${sarifOut}`);
    }
    const level = (arg("--level") ?? "high").toLowerCase();
    const rank = { low: 0, medium: 1, high: 2, critical: 3 } as Record<string, number>;
    if (rank[scan.level] >= (rank[level] ?? 2)) {
      console.error(`\n❌ Diff is ${scan.level.toUpperCase()} — blocking (threshold: ${level}).`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "backfill") {
    const { backfill, transcriptRoot } = await import("./backfill.js");
    const days = arg("--days") ? Number(arg("--days")) : undefined;
    const root = arg("--dir") ?? transcriptRoot();
    console.log(`🧑‍🏭 Mining your existing agent history…\n   ${root}\n`);
    const res = await backfill({ root, days, onFile: (f) => console.log(`   scanning ${path.basename(f)}`) });
    console.log(`\n✅ Backfill complete:`);
    console.log(`   ${res.sessions_imported} historical session(s) imported (${res.events} events)`);
    console.log(`   ${res.sessions_skipped_existing} already tracked · ${res.sessions_skipped_empty} skipped (no code changes${days ? " in range" : ""})`);
    if (res.sessions_imported) {
      console.log(`\n   Your history is now risk-ranked. See what your agents have been up to:`);
      console.log(`     foreman ui        (Insights tab for the full picture)`);
      console.log(`     foreman wrapped   (shareable report card)`);
    }
    return;
  }

  if (cmd === "wrapped") {
    const { renderWrapped } = await import("./wrapped.js");
    const days = arg("--days") ? Number(arg("--days")) : undefined;
    const r = renderWrapped(days, arg("--out"));
    console.log(r.png
      ? `✅ Your report card → ${r.file}\n   Post it. Every stat is from your real journal.`
      : `✅ Report card (HTML) → ${r.file} — opened in your browser; screenshot to share.\n   (Install Chrome/Edge for automatic PNG export.)`);
    return;
  }

  if (cmd === "badge") {
    const { BADGE_MD } = await import("./wrapped.js");
    console.log(`Add to your README — tell people a human reviews the AI's work here:\n`);
    console.log(BADGE_MD);
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
    const httpTarget = arg("--http");
    if (httpTarget) {
      const { runHttpProxy } = await import("./mcp/httpwrap.js");
      const { port } = await runHttpProxy(name, httpTarget, Number(arg("--listen-port") ?? 0));
      console.log(`🧑‍🏭 Attesting remote MCP server "${name}"`);
      console.log(`   upstream : ${httpTarget}`);
      console.log(`   point your agent at →  http://127.0.0.1:${port}/`);
      console.log(`   Every tool call gets a signed, chained receipt (foreman verify). Ctrl+C to stop.`);
      return; // keeps running
    }
    const sep = process.argv.indexOf("--");
    const command = sep >= 0 ? process.argv.slice(sep + 1) : [];
    if (!command.length) {
      console.error("usage: foreman wrap --name <server> -- <command...>   (or: foreman wrap --name <server> --http <url>)");
      process.exit(1);
    }
    runProxy(name, command);
    return; // keeps running until the wrapped server exits
  }

  if (cmd === "track") {
    const { loadServers, addServer, removeServer } = await import("./servers.js");
    const sub = process.argv[3];
    if (sub === "add") {
      const name = process.argv[4], url = process.argv[5];
      if (!name || !url) { console.error("usage: foreman track add <name> <mcp-url>"); process.exit(1); }
      try { addServer(name, url); console.log(`✅ tracking "${name}" → ${url}`); }
      catch (e) { console.error(`✗ ${e instanceof Error ? e.message : e}`); process.exit(1); }
      console.log(`   start the relay:  foreman track`);
      return;
    }
    if (sub === "rm" || sub === "remove") {
      const name = process.argv[4];
      if (!name) { console.error("usage: foreman track rm <name>"); process.exit(1); }
      console.log(removeServer(name) ? `✅ stopped tracking "${name}"` : `no server named "${name}"`);
      return;
    }
    if (sub === "ls" || sub === "list") {
      const list = loadServers();
      if (!list.length) { console.log("No MCP servers registered yet.  Add one:  foreman track add <name> <mcp-url>"); return; }
      for (const s of list) console.log(`  ${s.name.padEnd(16)} ${s.url}`);
      return;
    }
    // no sub-command → run the relay for every registered server
    const { runTrackRelay, trackBanner } = await import("./track.js");
    const servers = loadServers();
    if (!servers.length) {
      console.log("No MCP servers registered yet — nothing to track.\n");
      console.log("  Register your servers, then run `foreman track`:");
      console.log("    foreman track add github https://api.githubcopilot.com/mcp/");
      console.log("    foreman track add jira   https://mcp.atlassian.com/v1/sse");
      return;
    }
    const publicBase = arg("--public-url"); // set when fronted by a tunnel
    const { port } = await runTrackRelay(servers, Number(arg("--port") ?? 4599));
    console.log(trackBanner(port, servers, publicBase));
    console.log("\n  Ctrl+C to stop.");
    return; // keeps running
  }

  if (cmd === "wire" || cmd === "unwire") {
    const { discoverConfigs, wireConfig, unwireConfig } = await import("./wire.js");
    const { fileURLToPath } = await import("node:url");
    const cliPath = fileURLToPath(import.meta.url);
    const targets = discoverConfigs();
    if (!targets.length) {
      console.log("No agent MCP configs found (Claude Desktop / Claude Code / Cursor / Windsurf).");
      console.log("Add an MCP server to your agent first, then re-run  foreman wire.");
      return;
    }
    if (cmd === "unwire") {
      let total = 0;
      for (const t of targets) {
        const r = unwireConfig(t.path);
        if (r.restored.length) { console.log(`  ${t.agent}: restored ${r.restored.join(", ")}`); total += r.restored.length; }
      }
      console.log(total ? `\n✅ Un-wired ${total} MCP server(s) — back to their originals.` : "Nothing was wired.");
      return;
    }
    const dry = process.argv.includes("--dry-run");
    console.log(dry
      ? "🧑‍🏭 foreman wire — DRY RUN (no files changed)\n"
      : "🧑‍🏭 foreman wire — routing your agents' MCP servers through Foreman\n");
    let wired = 0;
    for (const t of targets) {
      const r = wireConfig(t.path, process.execPath, cliPath, dry);
      const parts: string[] = [];
      if (r.wired.length) parts.push(`wired ${r.wired.join(", ")}`);
      if (r.already.length) parts.push(`already ${r.already.length}`);
      if (r.skipped.length) parts.push(`skipped ${r.skipped.join(", ")}`);
      if (parts.length) console.log(`  ${t.agent.padEnd(18)} ${parts.join(" · ")}`);
      wired += r.wired.length;
    }
    console.log(wired
      ? `\n✅ ${wired} MCP server(s) now attested. Restart your agent, then watch:  foreman ui → MCP Receipts\n   Backups saved as *.foreman-bak · undo any time:  foreman unwire`
      : "\n✓ Nothing to wire — already done, or only remote servers (those use `foreman track`).");
    return;
  }

  if (cmd === "shipped") {
    const { buildShipped } = await import("./ship.js");
    const ships = buildShipped();
    if (!ships.length) { console.log("Nothing shipped to prod yet — no deploys, publishes, releases, or pushes to main seen."); return; }
    console.log(`🚀 Shipped to prod — ${ships.length} action(s), newest first:\n`);
    for (const s of ships.slice(0, 40)) {
      const flag = s.unreviewed ? "  ⚠ UNREVIEWED" : "";
      console.log(`  ${s.kind.padEnd(13)} ${s.detail.padEnd(16)} ${s.repo.padEnd(20)} ${s.agent}${flag}`);
      console.log(`     ${s.command}`);
    }
    const unrev = ships.filter((s) => s.unreviewed).length;
    if (unrev) console.log(`\n⚠ ${unrev} of these reached prod without being approved. Review them:  foreman ui`);
    return;
  }

  if (cmd === "manifest") {
    const { buildManifest } = await import("./manifest.js");
    const sessionArg = arg("--session") ?? (process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined);
    let session: string;
    if (sessionArg) {
      const c = buildCards().find((x) => x.session === sessionArg || x.session.startsWith(sessionArg));
      if (!c) { console.error(`No session matching "${sessionArg}". List them:  foreman status`); process.exit(1); }
      session = c.session;
    } else {
      const { sameRepo } = await import("./feedback.js");
      const repo = arg("--repo") ?? process.cwd();
      const c = buildCards()
        .filter((x) => !x.session.startsWith("demo-") && sameRepo(x.cwd, repo))
        .sort((a, b) => b.started.localeCompare(a.started))[0];
      if (!c) { console.error(`No session found for ${repo}. Run your agent first, or pass --session <id>.`); process.exit(1); }
      session = c.session;
    }
    const man = buildManifest(session);
    const json = JSON.stringify(man, null, 2);
    const out = arg("--out") ?? arg("-o");
    if (out) {
      fs.writeFileSync(out, json + "\n", "utf8");
      console.log(`✅ Signed provenance manifest → ${out}`);
      console.log(`   session ${man.payload.session.slice(0, 12)} · ${man.payload.risk.level.toUpperCase()} ${man.payload.risk.score} · review: ${man.payload.review.status} · ${man.signature.key_fingerprint}`);
      console.log(`   Attach it to your PR or release. Anyone can verify it offline:`);
      console.log(`     foreman verify-manifest ${out}`);
    } else {
      console.log(json);
    }
    return;
  }

  if (cmd === "verify-manifest") {
    const { verifyManifest } = await import("./manifest.js");
    const file = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : arg("--file");
    if (!file) { console.error("usage: foreman verify-manifest <foreman.manifest.json>"); process.exit(1); }
    let man: unknown;
    try { man = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { console.error(`Could not read/parse ${file}: ${e instanceof Error ? e.message : e}`); process.exit(1); }
    const v = verifyManifest(man);
    const p = (man as { payload?: Record<string, any> })?.payload ?? {};
    console.log(v.ok
      ? `✅ VALID — signature, content hash, and key fingerprint all check out.`
      : `❌ INVALID manifest:${v.reasons.map((r) => `\n   · ${r}`).join("")}`);
    console.log(`   signature ${v.signature_valid ? "✓" : "✗"}   content-hash ${v.content_hash_valid ? "✓" : "✗"}   fingerprint ${v.fingerprint_valid ? "✓" : "✗"}`);
    if (p.session) {
      console.log(`\n   Signed by      ${v.key_fingerprint}`);
      console.log(`   Agent          ${p.agent} · ${p.repo}`);
      console.log(`   Session        ${String(p.session).slice(0, 12)} · generated ${p.generated_at}`);
      console.log(`   Risk / review  ${String(p.risk?.level).toUpperCase()} ${p.risk?.score} · ${p.review?.status} (${p.review?.decided_by})`);
      console.log(`   Claims         ${p.verification?.claims_verified ? "verified" : "UNVERIFIED"} · ${p.verification?.verification_passing}/${p.verification?.verification_commands} checks passing`);
      if (Array.isArray(p.shipped) && p.shipped.length) console.log(`   Shipped        ${p.shipped.map((s: any) => `${s.kind}→${s.detail}`).join(", ")}`);
    }
    if (!v.ok) process.exit(1);
    return;
  }

  if (cmd === "prove") {
    const { detectVerifyCommand, runProve } = await import("./prove.js");
    const session = arg("--session");
    let repo = process.cwd();
    let sess: string | undefined;
    if (session) {
      const c = buildCards().find((x) => x.session === session);
      if (!c) { console.error(`No session "${session}" found.`); process.exit(1); }
      repo = c.cwd; sess = session;
    } else if (process.argv[3] && !process.argv[3].startsWith("--")) {
      repo = path.resolve(process.argv[3]);
    }
    const vc = detectVerifyCommand(repo);
    if (!vc) {
      console.log(`No verification command found in ${repo}`);
      console.log(`   (looked for package.json test/build, Makefile, pytest, cargo, go)`);
      return;
    }
    console.log(`🧑‍🏭 Prove it — running  ${vc.command}   [${vc.source}]\n`);
    const r = runProve(repo, vc);
    console.log(r.output.split("\n").slice(-20).join("\n"));
    console.log(r.ok
      ? `\n✅ PASSED in ${r.ms}ms — the claim now has evidence.`
      : `\n❌ FAILED (exit ${r.code}) in ${r.ms}ms — the agent's claim did not hold up.`);
    if (sess) {
      const { appendEvent } = await import("./journal.js");
      appendEvent({ agent: "foreman-prove", session: sess, cwd: repo, kind: "tool",
        data: { command: vc.command, ok: r.ok, description: "foreman prove — verification run" } });
      console.log(`   Attached to session ${sess} — refresh the inbox.`);
    }
    if (!r.ok) process.exit(1);
    return;
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
      if (c.files.length) lines.push(`- files: ${c.files.map((f) => `\`${f.path}\` (${lineCountText(f)})`).join(", ")}`);
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
