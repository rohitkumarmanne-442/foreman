import http from "node:http";
import crypto from "node:crypto";
import { appendEvent } from "../journal.js";
import { recordExchange } from "./proxy.js";

/**
 * Forward ONE HTTP request to a remote MCP server and attest the exchange.
 *
 * Shared by `foreman wrap --http` (single upstream) and `foreman track`
 * (many upstreams multiplexed on one relay). JSON responses are attested
 * per-call; SSE responses stream through unbuffered and the terminal event
 * carrying the request id is attested once the stream completes. Receipts are
 * signed and hash-chained exactly like stdio wraps, including tools/list
 * fingerprinting for rug-pull detection.
 */
export async function relayOnce(
  name: string,
  target: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runId: string,
  surface: "local" | "web" = "web"
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const bodyBuf = Buffer.concat(chunks);
  let parsed: { id?: unknown; method?: string; params?: unknown } | null = null;
  if (req.method === "POST" && bodyBuf.length) {
    try { const j = JSON.parse(bodyBuf.toString("utf8")); if (j && !Array.isArray(j)) parsed = j; } catch { /* opaque body */ }
  }
  const t0 = Date.now();

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "content-length", "connection"].includes(k)) continue;
    if (typeof v === "string") headers[k] = v;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" || req.method === "DELETE" ? undefined : bodyBuf,
    });
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `foreman: upstream '${name}' unreachable — ${e instanceof Error ? e.message : e}` }));
    return;
  }

  const outHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    if (!["content-length", "transfer-encoding", "content-encoding", "connection"].includes(k)) outHeaders[k] = v;
  });
  res.writeHead(upstream.status, outHeaders);

  const ct = upstream.headers.get("content-type") ?? "";
  const attest = (obj: { result?: unknown; error?: unknown } | null) => {
    if (parsed?.method) recordExchange(name, runId, { method: parsed.method, params: parsed.params, t0 }, obj ?? {}, appendEvent, surface);
  };

  if (ct.includes("text/event-stream") && upstream.body) {
    // stream through untouched; attest the event answering this request's id
    const reader = upstream.body.getReader();
    let buf = "";
    let answer: { result?: unknown; error?: unknown } | null = null;
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const event = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (parsed && j && j.id === parsed.id && ("result" in j || "error" in j)) answer = j;
          } catch { /* keep streaming */ }
        }
      }
    }
    res.end();
    if (parsed?.method) attest(answer);
    return;
  }

  const text = await upstream.text();
  res.end(text);
  if (parsed?.method) {
    let obj: { result?: unknown; error?: unknown } | null = null;
    try { obj = JSON.parse(text); } catch { /* 202/empty is fine for notifications */ }
    if (obj && ("result" in obj || "error" in obj)) attest(obj);
  }
}

/**
 * foreman wrap --http — attestation for a single REMOTE MCP server.
 * Runs a local relay; point your agent at the printed 127.0.0.1 URL.
 */
export function runHttpProxy(name: string, target: string, listenPort = 0): Promise<{ port: number; server: http.Server }> {
  const runId = `http-${name}-${crypto.randomUUID().slice(0, 8)}`;
  const server = http.createServer((req, res) => {
    void relayOnce(name, target, req, res, runId, "web");
  });

  return new Promise((resolve) => {
    server.listen(listenPort, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, server });
    });
  });
}
