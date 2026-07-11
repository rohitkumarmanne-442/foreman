#!/usr/bin/env node
import { spawn } from "node:child_process";
import { handleClaudeCodeHook, installClaudeCodeHooks } from "./hooks/claude-code.js";
import { runProxy, trustServer } from "./mcp/proxy.js";
import { startServer } from "./server.js";
import { buildCards } from "./cards.js";
import { readEvents } from "./journal.js";
import { verifyReceipt, type ReceiptBody } from "./mcp/receipts.js";
import { DEFAULT_PORT, FOREMAN_HOME } from "./paths.js";
import type { McpCallData } from "./types.js";

const HELP = `
  🧑‍🏭 foreman — the review inbox for your AI workforce

  USAGE
    foreman init [--global]      install Claude Code hooks (project, or --global for all repos)
    foreman ui [--port ${DEFAULT_PORT}]      open the review inbox (127.0.0.1 only)
    foreman wrap --name <srv> -- <command...>
                                 run an MCP server behind the attestation proxy
    foreman trust <srv>          accept an MCP server's current tools as the new baseline
    foreman verify               re-verify every signed MCP receipt
    foreman status               one-screen summary in the terminal
    foreman demo [--clear]       seed (or remove) showcase data to explore the inbox
    foreman hook <agent>         (internal) hook entry point, reads stdin

  DATA
    everything lives in ${FOREMAN_HOME} — JSONL, greppable, yours.
`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (cmd === "hook") {
    const agent = process.argv[3];
    if (agent === "claude-code") await handleClaudeCodeHook();
    return; // always exit 0 — hooks must never break the agent
  }

  if (cmd === "init") {
    const isGlobal = process.argv.includes("--global");
    const file = installClaudeCodeHooks({ global: isGlobal });
    console.log(`✅ Foreman hooks installed → ${file}`);
    console.log(`   Every Claude Code session in ${isGlobal ? "every repo" : "this repo"} now files a review card.`);
    console.log(`   Open the inbox:  foreman ui`);
    return;
  }

  if (cmd === "ui") {
    const port = Number(arg("--port") ?? DEFAULT_PORT);
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

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
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
