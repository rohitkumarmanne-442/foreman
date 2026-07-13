import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildCards } from "./cards.js";
import { buildTimeline } from "./timeline.js";
import { readEvents } from "./journal.js";
import { setReview } from "./reviews.js";
import { verifyReceipt, type ReceiptBody } from "./mcp/receipts.js";
import { toReceiptBody } from "./verifyall.js";
import { buildPrComment } from "./pr.js";
import { DEFAULT_PORT, FOREMAN_HOME } from "./paths.js";
import { loadConfig } from "./config.js";
import type { McpCallData } from "./types.js";

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
        send(200, JSON.stringify(buildCards()));
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
      console.log(`🧑‍🏭 Foreman is already running on http://127.0.0.1:${port} — using that one.`);
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
      const cmd = loadConfig(true).notify_command;
      if (!cmd) return;
      for (const c of buildCards()) {
        if (c.level !== "critical" || c.review === "approved" || notified[c.session]) continue;
        if (c.session.startsWith("demo-")) continue;
        notified[c.session] = true;
        fs.writeFileSync(notifiedPath, JSON.stringify(notified), "utf8");
        spawn(cmd, {
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
    } catch { /* notifier must never take the inbox down */ }
  }, 15000).unref();
}
