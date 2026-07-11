#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
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
    foreman init [--agent claude|cursor|all] [--global]
                                 install hooks (default: all agents detected, this repo)
    foreman ui [--port 4517]     open the review inbox (127.0.0.1 only)
    foreman watch [path]         UNIVERSAL mode — watch any repo, works with any IDE/agent
    foreman demo [--clear]       seed (or remove) showcase data to explore the inbox

  MCP ATTESTATION
    foreman wrap --name <srv> -- <command...>
                                 run an MCP server behind the attestation proxy
    foreman trust <srv>          accept a server's current tools as the new baseline
    foreman verify               re-verify every signed receipt

  EVERYTHING ELSE
    foreman status               one-screen summary in the terminal
    foreman report [--out f.md]  markdown audit report of all sessions
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

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const isGlobal = process.argv.includes("--global");

  if (cmd === "hook") {
    const agent = process.argv[3];
    if (agent === "claude-code") await handleClaudeCodeHook();
    else if (agent === "cursor") await handleCursorHook();
    return; // always exit 0 — hooks must never break the agent
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
    if (!installed.length) {
      console.error(`Unknown agent "${agent}". Use: claude | cursor | all`);
      process.exit(1);
    }
    console.log(`✅ Foreman hooks installed for ${isGlobal ? "ALL repos" : "this repo"}:\n`);
    for (const line of installed) console.log(`   ${line}`);
    console.log(`\n   Using another IDE or agent? Universal mode works with everything:`);
    console.log(`     foreman watch`);
    console.log(`\n   Open the inbox:  foreman ui`);
    return;
  }

  if (cmd === "uninstall") {
    const a = uninstallClaudeCodeHooks({ global: isGlobal });
    const b = uninstallCursorHooks({ global: isGlobal });
    console.log(
      a || b
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
    const calls = readEvents().filter((e) => e.kind === "mcp_call");
    let ok = 0, bad = 0;
    for (const e of calls) {
      const d = e.data as unknown as McpCallData & ReceiptBody;
      const body: ReceiptBody = {
        receipt_id: d.receipt_id, ts: (d as any).ts, server: d.server, method: d.method,
        ...(d.tool ? { tool: d.tool } : {}),
        params_hash: d.params_hash, result_hash: d.result_hash, ms: d.ms, ok: d.ok,
      };
      verifyReceipt(body, d.sig, d.pk) ? ok++ : bad++;
    }
    console.log(`Receipts: ${calls.length} total — ${ok} valid, ${bad} broken`);
    if (bad > 0) process.exit(2);
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
