import http from "node:http";
import crypto from "node:crypto";
import { relayOnce } from "./mcp/httpwrap.js";
import { loadServers, type TrackedServer } from "./servers.js";

/**
 * Join a registered server's base URL with any sub-path / query the agent
 * appended after `/<name>`. Most MCP clients POST straight to the base URL
 * (empty suffix → forward to the base unchanged).
 */
export function joinTarget(base: string, restSegments: string[], search: string): string {
  const rest = restSegments.filter(Boolean).join("/");
  if (!rest && !search) return base;
  const b = base.replace(/\/+$/, "");
  return b + (rest ? "/" + rest : "") + (search || "");
}

/**
 * `foreman track` — one relay in front of EVERY registered MCP server.
 *
 * Point any agent (local IDE, or a web agent via the printed URL) at
 * `http://127.0.0.1:<port>/<name>` and every JSON-RPC call to that server is
 * forwarded to the real endpoint, ed25519-attested, and tagged `web` in the
 * inbox — one command, any number of services, any client.
 */
export function runTrackRelay(
  servers: TrackedServer[],
  listenPort: number
): Promise<{ port: number; server: http.Server }> {
  const map = new Map(servers.map((s) => [s.name, s.url]));
  const runId = `track-${crypto.randomUUID().slice(0, 8)}`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const segs = url.pathname.split("/").filter(Boolean);
    const name = segs[0];
    const target = name ? map.get(name) : undefined;
    if (!target) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: name ? `foreman track: no server named '${name}'` : "foreman track: use /<server-name>",
        servers: [...map.keys()],
      }));
      return;
    }
    void relayOnce(name, joinTarget(target, segs.slice(1), url.search), req, res, runId, "web");
  });

  return new Promise((resolve) => {
    server.listen(listenPort, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, server });
    });
  });
}

/** The paste-ready connector URL for a server on the running relay. */
export function connectorUrl(port: number, name: string): string {
  return `http://127.0.0.1:${port}/${name}`;
}

/** Human-readable startup banner for `foreman track`. */
export function trackBanner(port: number, servers: TrackedServer[], publicBase?: string): string {
  const lines: string[] = [];
  lines.push(`🧑‍🏭  Foreman is tracking ${servers.length} MCP server${servers.length === 1 ? "" : "s"}  ·  127.0.0.1:${port}`);
  lines.push("");
  for (const s of servers) {
    lines.push(`  ${s.name}`);
    lines.push(`    local agents : ${connectorUrl(port, s.name)}`);
    if (publicBase) lines.push(`    web agents   : ${publicBase.replace(/\/+$/, "")}/${s.name}`);
  }
  lines.push("");
  lines.push(`  Every call is journaled + ed25519-attested. Watch them land:  foreman ui  →  MCP Receipts`);
  return lines.join("\n");
}

export function loadTrackServers(): TrackedServer[] {
  return loadServers();
}
