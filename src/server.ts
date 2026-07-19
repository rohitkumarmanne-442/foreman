import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildCards } from "./cards.js";
import { runAutopilot } from "./autopilot.js";
import { buildShipped } from "./ship.js";
import { buildManifest } from "./manifest.js";
import { detectCollisions } from "./collisions.js";
import { buildTimeline } from "./timeline.js";
import { readEvents, appendEvent } from "./journal.js";
import { setReview, setDismissed } from "./reviews.js";
import { verifyReceipt, type ReceiptBody } from "./mcp/receipts.js";
import { toReceiptBody } from "./verifyall.js";
import { buildPrComment } from "./pr.js";
import { DEFAULT_PORT, FOREMAN_HOME } from "./paths.js";
import { loadConfig, saveConfig, CONFIG_PATH } from "./config.js";
import { createJiraIssue } from "./jira.js";
import type { McpCallData } from "./types.js";

function readBody(req: http.IncomingMessage, cb: (err: string | null, body: string) => void): void {
  let body = "";
  let overflow = false;
  req.on("data", (c) => {
    body += c;
    if (body.length > 100_000) { overflow = true; req.destroy(); }
  });
  req.on("end", () => cb(overflow ? "overflow" : null, body));
}

function uiPath(): string {
  const here = new URL(import.meta.url).pathname;
  const decoded = decodeURIComponent(here.replace(/^\/([A-Za-z]:)/, "$1"));
  // dist/server.js -> <pkg root>/ui/index.html
  return path.join(path.dirname(path.dirname(decoded)), "ui", "index.html");
}

function receiptRows() {
  const events = readEvents().filter((e) => e.kind === "mcp_call");
  return events.map((e) => {
    const d = e.data as unknown as McpCallData & { receipt_id: string };
    const body: ReceiptBody = toReceiptBody({ ts: e.ts, ...e.data });
    return {
      ...body,
      journaled_at: e.ts,
      chained: body.prev !== undefined,
      signature_valid: verifyReceipt(body, d.sig, d.pk),
      surface: (e.data as { surface?: string }).surface === "web" ? "web" : "local",
      preview: (e.data as { preview?: string }).preview,
    };
  });
}

export function startServer(port = DEFAULT_PORT): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const send = (code: number, body: string, type = "application/json") => {
      res.writeHead(code, {
        "content-type": type,
        "cache-control": "no-store",
        "access-control-allow-origin": "http://127.0.0.1:" + port,
      });
      res.end(body);
    };

    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        send(200, fs.readFileSync(uiPath(), "utf8"), "text/html; charset=utf-8");
      } else if (url.pathname === "/mascot.png") {
        const png = fs.readFileSync(path.join(path.dirname(uiPath()), "mascot.png"));
        res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
        res.end(png);
      } else if (url.pathname === "/api/cards") {
        // Adaptive Autopilot: auto-approve earned low-risk sessions, then
        // rebuild so the response reflects the approvals (no-op unless enabled).
        runAutopilot(buildCards());
        send(200, JSON.stringify(buildCards()));
      } else if (url.pathname === "/api/shipped") {
        send(200, JSON.stringify(buildShipped()));
      } else if (url.pathname === "/api/collisions") {
        send(200, JSON.stringify(detectCollisions()));
      } else if (url.pathname === "/api/manifest") {
        const session = url.searchParams.get("session") ?? "";
        try {
          const man = buildManifest(session);
          const json = JSON.stringify(man, null, 2);
          const dl = url.searchParams.get("download") === "1";
          const repo = man.payload.repo.replace(/[^\w.-]+/g, "-") || "session";
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "access-control-allow-origin": "http://127.0.0.1:" + port,
            ...(dl ? { "content-disposition": `attachment; filename="foreman-${repo}.manifest.json"` } : {}),
          });
          res.end(json);
        } catch (e) {
          send(404, JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
        }
      } else if (url.pathname === "/api/receipts") {
        send(200, JSON.stringify(receiptRows()));
      } else if (url.pathname === "/api/timeline") {
        const session = url.searchParams.get("session") ?? "";
        send(200, JSON.stringify(buildTimeline(session)));
      } else if (url.pathname === "/api/pr-comment") {
        const session = url.searchParams.get("session") ?? "";
        const card = buildCards().find((c) => c.session === session);
        if (!card) { send(404, JSON.stringify({ error: "session not found" })); return; }
        send(200, buildPrComment(card), "text/markdown; charset=utf-8");
      } else if (url.pathname === "/api/review" && req.method === "POST") {
        let body = "";
        let overflow = false;
        req.on("data", (c) => {
          body += c;
          if (body.length > 100_000) { overflow = true; req.destroy(); }
        });
        req.on("end", () => {
          if (overflow) { send(413, JSON.stringify({ error: "body too large" })); return; }
          try {
            const { session, status, note } = JSON.parse(body);
            if (
              typeof session !== "string" ||
              !["pending", "approved", "flagged"].includes(status)
            ) {
              send(400, JSON.stringify({ error: "bad request" }));
              return;
            }
            setReview(session, status, typeof note === "string" ? note : undefined);
            send(200, JSON.stringify({ ok: true }));
          } catch (err) {
            send(400, JSON.stringify({ error: String(err) }));
          }
        });
        return;
      } else if (url.pathname === "/api/dismiss" && req.method === "POST") {
        readBody(req, (err, body) => {
          if (err) { send(err === "overflow" ? 413 : 400, JSON.stringify({ error: err })); return; }
          try {
            const { session, rule, undo } = JSON.parse(body);
            if (typeof session !== "string" || typeof rule !== "string") { send(400, JSON.stringify({ error: "bad request" })); return; }
            setDismissed(session, rule, undo === true);
            send(200, JSON.stringify({ ok: true }));
          } catch (e) { send(400, JSON.stringify({ error: String(e) })); }
        });
        return;
      } else if (url.pathname === "/api/prove" && req.method === "POST") {
        readBody(req, async (err, body) => {
          if (err) { send(err === "overflow" ? 413 : 400, JSON.stringify({ error: err })); return; }
          try {
            const { session } = JSON.parse(body);
            const card = buildCards().find((c) => c.session === session);
            if (!card) { send(404, JSON.stringify({ error: "no such session" })); return; }
            const { detectVerifyCommand, runProveAsync } = await import("./prove.js");
            // command is derived server-side from the repo's config — the client
            // cannot inject a command
            const vc = detectVerifyCommand(card.cwd);
            if (!vc) { send(200, JSON.stringify({ detected: false, message: "No verification command found for this repo (package.json test/build, Makefile, pytest, cargo, go)." })); return; }
            const r = await runProveAsync(card.cwd, vc);
            appendEvent({ agent: "foreman-prove", session, cwd: card.cwd, kind: "tool",
              data: { command: vc.command, ok: r.ok, description: "foreman prove — verification run" } });
            send(200, JSON.stringify({ detected: true, ok: r.ok, command: r.command, source: r.source, ms: r.ms, output: r.output.slice(-3000) }));
          } catch (e) { send(400, JSON.stringify({ error: String(e) })); }
        });
        return;
      } else if (url.pathname === "/api/config" && req.method === "GET") {
        send(200, JSON.stringify({
          config: loadConfig(true),
          path: CONFIG_PATH(),
          known_rules: ["destructive_command", "mass_rewrite", "secret_in_code", "sensitive_path", "unverified_claims", "failed_verification", "untested_change", "mcp_tool_drift"],
          jira_token_present: !!process.env[loadConfig().jira?.token_env ?? "JIRA_API_TOKEN"],
        }));
      } else if (url.pathname === "/api/config" && req.method === "POST") {
        readBody(req, (err, body) => {
          if (err) { send(err === "overflow" ? 413 : 400, JSON.stringify({ error: err })); return; }
          try {
            const cfg = saveConfig(JSON.parse(body));
            send(200, JSON.stringify({ ok: true, config: cfg }));
          } catch (e) { send(400, JSON.stringify({ error: String(e) })); }
        });
        return;
      } else if (url.pathname === "/api/jira" && req.method === "POST") {
        readBody(req, (err, body) => {
          if (err) { send(err === "overflow" ? 413 : 400, JSON.stringify({ error: err })); return; }
          (async () => {
            const { session, note } = JSON.parse(body);
            const card = buildCards().find((c) => c.session === session);
            if (!card) { send(404, JSON.stringify({ error: "session not found" })); return; }
            const issue = await createJiraIssue(card, typeof note === "string" ? note : undefined);
            send(200, JSON.stringify({ ok: true, ...issue }));
          })().catch((e) => send(502, JSON.stringify({ error: String(e instanceof Error ? e.message : e) })));
        });
        return;
      } else if (url.pathname === "/manifest.json") {
        send(200, JSON.stringify({
          name: "Foreman — Review Inbox", short_name: "Foreman", id: "foreman-inbox",
          start_url: "/", display: "standalone", background_color: "#070a12", theme_color: "#0d1220",
          icons: [{ src: "/mascot.png", sizes: "460x626", type: "image/png", purpose: "any" }],
          description: "The review inbox for your AI workforce.",
        }), "application/manifest+json");
      } else if (url.pathname === "/api/health") {
        send(200, JSON.stringify({ ok: true, name: "foreman" }));
      } else {
        send(404, JSON.stringify({ error: "not found" }));
      }
    } catch (err) {
      send(500, JSON.stringify({ error: String(err) }));
    }
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(`🧑‍🏭 Foreman is already running on http://127.0.0.1:${port} — opened it in your browser.`);
      process.exit(0);
    }
    throw err;
  });
  server.listen(port, "127.0.0.1");
  startNotifier();
  return server;
}

/** Optional: run the user's notify_command whenever a NEW critical-risk card
 * appears (config.notify_command, e.g. a toast script or ntfy/slack curl).
 * Session env vars: FOREMAN_SESSION, FOREMAN_LEVEL, FOREMAN_REPO, FOREMAN_SCORE. */
function startNotifier(): void {
  const notifiedPath = path.join(FOREMAN_HOME, "notified.json");
  let notified: Record<string, true> = {};
  try {
    notified = JSON.parse(fs.readFileSync(notifiedPath, "utf8"));
  } catch { /* first run */ }

  setInterval(() => {
    try {
      const cfg = loadConfig(true);
      if (!cfg.notify_command && !cfg.notify_webhook) return;
      for (const c of buildCards()) {
        if (c.level !== "critical" || c.review === "approved" || notified[c.session]) continue;
        if (c.session.startsWith("demo-")) continue;
        notified[c.session] = true;
        fs.writeFileSync(notifiedPath, JSON.stringify(notified), "utf8");
        if (cfg.notify_command) {
          spawn(cfg.notify_command, {
            shell: true,
            stdio: "ignore",
            detached: true,
            env: {
              ...process.env,
              FOREMAN_SESSION: c.session,
              FOREMAN_LEVEL: c.level,
              FOREMAN_SCORE: String(c.score),
              FOREMAN_REPO: c.cwd,
            },
          }).unref();
        }
        if (cfg.notify_webhook) {
          const repo = c.cwd.split(/[\\/]/).pop() || c.cwd;
          const top = c.findings.slice(0, 3).map((f) => `• ${f.rule}: ${f.detail.slice(0, 120)}`).join("\n");
          // {"text": ...} is the shape Slack and Teams incoming webhooks both accept
          fetch(cfg.notify_webhook, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text: `🧑‍🏭 Foreman: CRITICAL ${c.score}/100 agent session in *${repo}* (${c.agent})\n${top}\nReview: http://127.0.0.1:${loadConfig().port}/`,
              foreman: { session: c.session, level: c.level, score: c.score, repo: c.cwd, findings: c.findings },
            }),
          }).catch(() => { /* webhook down must never take the inbox down */ });
        }
      }
    } catch { /* notifier must never take the inbox down */ }
  }, 15000).unref();
}
