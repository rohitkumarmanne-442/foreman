import fs from "node:fs";
import path from "node:path";
import { FOREMAN_HOME, ensureDirs } from "./paths.js";

/** One registered MCP server that `foreman track` fronts. */
export interface TrackedServer {
  name: string;
  url: string; // remote streamable-HTTP / SSE endpoint
  added_at: string;
}

const FILE = () => path.join(FOREMAN_HOME, "servers.json");

export function loadServers(): TrackedServer[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    if (Array.isArray(raw)) return raw.filter((s) => s && s.name && s.url);
  } catch { /* no file yet */ }
  return [];
}

function saveServers(list: TrackedServer[]): void {
  ensureDirs();
  fs.writeFileSync(FILE(), JSON.stringify(list, null, 2) + "\n", "utf8");
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Register (or update) a server. Returns the normalized entry or throws on bad input. */
export function addServer(name: string, url: string): TrackedServer {
  if (!NAME_RE.test(name)) throw new Error(`server name must be [a-zA-Z0-9_-]; got '${name}'`);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`invalid URL: ${url}`); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`URL must be http(s); got ${parsed.protocol}`);
  const list = loadServers().filter((s) => s.name !== name);
  const entry: TrackedServer = { name, url, added_at: new Date().toISOString() };
  list.push(entry);
  list.sort((a, b) => a.name.localeCompare(b.name));
  saveServers(list);
  return entry;
}

/** Remove a server by name. Returns true if it existed. */
export function removeServer(name: string): boolean {
  const list = loadServers();
  const next = list.filter((s) => s.name !== name);
  if (next.length === list.length) return false;
  saveServers(next);
  return true;
}
