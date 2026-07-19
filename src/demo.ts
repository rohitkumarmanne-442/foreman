import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { appendEvent } from "./journal.js";
import { EVENTS_DIR } from "./paths.js";
import { sha256, canonical, signReceipt, type ReceiptBody } from "./mcp/receipts.js";

/** `foreman demo` — seed three showcase sessions + attested MCP traffic so a
 * first-time user sees a populated inbox. `foreman demo --clear` removes them. */
export function seedDemo(): void {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();

  // ── 1. The incident: mass rewrite + force push + unverified claims ──
  const s1 = "demo-incident";
  const cwd1 = path.join("C:", "demo", "checkout-service");
  const oldApp = Array.from({ length: 869 }, (_, i) => `# app.py line ${i + 1} — real production logic`).join("\n");
  const newApp = Array.from({ length: 97 }, (_, i) => `# rewritten line ${i + 1}`).join("\n");
  appendEvent({ agent: "claude-code", session: s1, cwd: cwd1, kind: "pre_tool", ts: minsAgo(18),
    data: { tool: "Write", file: "app.py", exists: true, lines: 869, content_sample: oldApp.slice(0, 20000) } });
  appendEvent({ agent: "claude-code", session: s1, cwd: cwd1, kind: "tool", ts: minsAgo(17),
    data: { tool: "Write", ok: true, file: "app.py", lines_after: 97, content_sample: newApp } });
  appendEvent({ agent: "claude-code", session: s1, cwd: cwd1, kind: "tool", ts: minsAgo(16),
    data: { tool: "Bash", ok: true, command: "git push --force origin main", description: "Push the cleanup" } });
  appendEvent({ agent: "claude-code", session: s1, cwd: cwd1, kind: "session_end", ts: minsAgo(15),
    data: { transcript: "", last_message:
      "I've simplified app.py significantly — removed all the legacy code and the app is much cleaner now. Everything works and the checkout flow is fully functional. Done!",
      claims: ["Everything works and the checkout flow is fully functional.", "Done!"] } });

  // ── 2. Sensitive path + secret written, some verification ──
  const s2 = "demo-auth-change";
  const cwd2 = path.join("C:", "demo", "billing-api");
  appendEvent({ agent: "claude-code", session: s2, cwd: cwd2, kind: "pre_tool", ts: minsAgo(55),
    data: { tool: "Edit", file: "src/auth/tokens.ts", exists: true, lines: 214 } });
  appendEvent({ agent: "claude-code", session: s2, cwd: cwd2, kind: "tool", ts: minsAgo(54),
    data: { tool: "Edit", ok: true, file: "src/auth/tokens.ts",
      content_sample: 'const FALLBACK_KEY = "sk-live-demo1234567890abcdefghij";',
      edits: [{ old: "const FALLBACK_KEY = process.env.STRIPE_KEY;", new: 'const FALLBACK_KEY = "sk-live-demo1234567890abcdefghij";' }] } });
  appendEvent({ agent: "claude-code", session: s2, cwd: cwd2, kind: "tool", ts: minsAgo(53),
    data: { tool: "Bash", ok: true, command: "npm test -- tokens", description: "Run token tests" } });
  appendEvent({ agent: "claude-code", session: s2, cwd: cwd2, kind: "session_end", ts: minsAgo(52),
    data: { transcript: "", last_message: "Token refresh is fixed and tests pass.", claims: ["Token refresh is fixed and tests pass."] } });

  // ── 3. The good citizen: surgical edit, verified ──
  const s3 = "demo-clean-fix";
  const cwd3 = path.join("C:", "demo", "docs-site");
  appendEvent({ agent: "claude-code", session: s3, cwd: cwd3, kind: "pre_tool", ts: minsAgo(120),
    data: { tool: "Edit", file: "src/components/Header.tsx", exists: true, lines: 88 } });
  appendEvent({ agent: "claude-code", session: s3, cwd: cwd3, kind: "tool", ts: minsAgo(119),
    data: { tool: "MultiEdit", ok: true, file: "src/components/Header.tsx",
      content_sample: '<nav aria-label="Main navigation">',
      edits: [
        { old: "<nav>", new: '<nav aria-label="Main navigation">' },
        { old: "      <Logo />", new: '      <a className="skip-link" href="#main">Skip to content</a>\n      <Logo />\n      <SearchButton />\n      <ThemeToggle />' },
      ] } });
  appendEvent({ agent: "claude-code", session: s3, cwd: cwd3, kind: "tool", ts: minsAgo(118),
    data: { tool: "Bash", ok: true, command: "npm run build && npm test", description: "Build and test" } });
  appendEvent({ agent: "claude-code", session: s3, cwd: cwd3, kind: "tool", ts: minsAgo(117.5),
    data: { tool: "Bash", ok: true, command: "vercel deploy --prod", description: "Ship the docs site" } });
  appendEvent({ agent: "claude-code", session: s3, cwd: cwd3, kind: "session_end", ts: minsAgo(117),
    data: { transcript: "", last_message: "Added the aria-label; build and tests pass.", claims: ["build and tests pass."] } });

  // ── 4. Attested MCP traffic + one rug pull ──
  const mcpSession = "demo-mcp-run";
  const mk = (tool: string, ok: boolean, ms: number, minutes: number): void => {
    const body: ReceiptBody = {
      receipt_id: crypto.randomUUID(), ts: minsAgo(minutes), server: "demo-github",
      method: "tools/call", tool, params_hash: sha256(canonical({ demo: tool })),
      result_hash: sha256(canonical({ ok })), ms, ok,
    };
    const { sig, pk } = signReceipt(body);
    appendEvent({ agent: "mcp-proxy", session: mcpSession, cwd: process.cwd(), kind: "mcp_call",
      ts: body.ts, data: { ...body, sig, pk } });
  };
  mk("create_issue", true, 420, 45);
  mk("list_pull_requests", true, 180, 44);
  mk("merge_pull_request", false, 950, 43);

  // ── 4b. Web-agent MCP traffic (via `foreman track`) — shows site/data ──
  const mkWeb = (server: string, tool: string, preview: string, ms: number, minutes: number): void => {
    const body: ReceiptBody = {
      receipt_id: crypto.randomUUID(), ts: minsAgo(minutes), server,
      method: "tools/call", tool, params_hash: sha256(canonical({ demo: preview })),
      result_hash: sha256(canonical({ ok: true })), ms, ok: true,
    };
    const { sig, pk } = signReceipt(body);
    appendEvent({ agent: "mcp-proxy", session: "demo-web-mcp", cwd: process.cwd(), kind: "mcp_call",
      ts: body.ts, data: { ...body, sig, pk, surface: "web", preview } });
  };
  mkWeb("web-fetch", "fetch_url", "url=https://docs.stripe.com/api/charges", 240, 8);
  mkWeb("web-search", "search", "query=production checkout latency spike", 180, 7);
  mkWeb("atlassian", "create_issue", "project=OPS  summary=Investigate checkout regression", 320, 6);
  appendEvent({ agent: "mcp-proxy", session: mcpSession, cwd: process.cwd(), kind: "mcp_drift", ts: minsAgo(42),
    data: { server: "demo-github", baseline_hash: "a".repeat(64), current_hash: "b".repeat(64),
      added: [], removed: [], changed: ["create_issue"] } });

  console.log("✅ Demo data seeded — open the inbox:  foreman ui");
  console.log("   Remove it any time:  foreman demo --clear");
}

export function clearDemo(): void {
  const dir = EVENTS_DIR();
  if (!fs.existsSync(dir)) return;
  let removed = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    const full = path.join(dir, f);
    const lines = fs.readFileSync(full, "utf8").split("\n");
    const kept = lines.filter((line) => {
      if (!line.trim()) return false;
      try {
        const e = JSON.parse(line);
        const isDemo = typeof e.session === "string" && e.session.startsWith("demo-");
        if (isDemo) removed++;
        return !isDemo;
      } catch {
        return true;
      }
    });
    if (kept.length) fs.writeFileSync(full, kept.join("\n") + "\n", "utf8");
    else fs.rmSync(full);
  }
  console.log(`✅ Removed ${removed} demo event(s).`);
}
