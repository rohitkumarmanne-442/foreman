import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { buildCards } from "./cards.js";
import { readEvents } from "./journal.js";
import { setReview } from "./reviews.js";
import { verifyReceipt, type ReceiptBody } from "./mcp/receipts.js";
import { DEFAULT_PORT } from "./paths.js";
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
    const body: ReceiptBody = {
      receipt_id: d.receipt_id,
      ts: (d as any).ts ?? e.ts,
      server: d.server,
      method: d.method,
      ...(d.tool ? { tool: d.tool } : {}),
      params_hash: d.params_hash,
      result_hash: d.result_hash,
      ms: d.ms,
      ok: d.ok,
    };
    return {
      ...body,
      journaled_at: e.ts,
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
      } else if (url.pathname === "/api/cards") {
        send(200, JSON.stringify(buildCards()));
      } else if (url.pathname === "/api/receipts") {
        send(200, JSON.stringify(receiptRows()));
      } else if (url.pathname === "/api/review" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { session, status } = JSON.parse(body);
            if (
              typeof session !== "string" ||
              !["pending", "approved", "flagged"].includes(status)
            ) {
              send(400, JSON.stringify({ error: "bad request" }));
              return;
            }
            setReview(session, status);
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
  server.listen(port, "127.0.0.1");
  return server;
}
