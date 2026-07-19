import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * `foreman wire` — auto-attest the MCP servers your agents already use.
 *
 * Finds each agent's MCP config and rewrites every stdio server so it launches
 * behind Foreman's attestation proxy:
 *
 *   "github": { "command": "npx", "args": ["-y","server-github"] }
 *      ->
 *   "github": { "command": "<node>", "args": ["<foreman-cli>","wrap","--name","github","--","npx","-y","server-github"], "_foreman_wrapped": true }
 *
 * Every tool call the agent makes now gets an ed25519 receipt — with zero
 * manual URL-pasting. Reversible (`foreman unwire`) and idempotent. Remote
 * (url-based) servers are left alone; those route through `foreman track`.
 */

export interface McpConfigTarget {
  agent: string;
  path: string;
}

/** Known agent MCP config locations, per platform. Only existing files returned. */
export function discoverConfigs(cwd = process.cwd(), home = os.homedir()): McpConfigTarget[] {
  const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const out: McpConfigTarget[] = [];
  const add = (agent: string, p: string) => out.push({ agent, path: p });

  if (process.platform === "win32") add("Claude Desktop", path.join(appdata, "Claude", "claude_desktop_config.json"));
  else if (process.platform === "darwin") add("Claude Desktop", path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"));
  else add("Claude Desktop", path.join(home, ".config", "Claude", "claude_desktop_config.json"));

  add("Claude Code", path.join(home, ".claude.json"));
  add("Cursor", path.join(home, ".cursor", "mcp.json"));
  add("Windsurf", path.join(home, ".codeium", "windsurf", "mcp_config.json"));
  add("project .mcp.json", path.join(cwd, ".mcp.json"));
  add("project .cursor", path.join(cwd, ".cursor", "mcp.json"));

  return out.filter((c) => fs.existsSync(c.path));
}

interface Server {
  command?: string;
  args?: string[];
  url?: string;
  _foreman_wrapped?: boolean;
  _foreman_orig?: { command?: string; args?: string[] };
  [k: string]: unknown;
}

export function wrapServer(name: string, s: Server, node: string, cli: string): Server {
  return {
    ...s,
    command: node,
    args: [cli, "wrap", "--name", name, "--", s.command as string, ...(s.args ?? [])],
    _foreman_wrapped: true,
    _foreman_orig: { command: s.command, args: s.args ?? [] },
  };
}

export function unwrapServer(s: Server): Server {
  if (!s._foreman_wrapped || !s._foreman_orig) return s;
  const { _foreman_wrapped, _foreman_orig, ...rest } = s;
  return { ...rest, command: _foreman_orig.command, args: _foreman_orig.args };
}

export interface WireResult {
  wired: string[];
  already: string[];
  skipped: string[];
}

/** Wire one config file. Returns which servers changed. */
export function wireConfig(file: string, node: string, cli: string, dryRun = false): WireResult {
  const res: WireResult = { wired: [], already: [], skipped: [] };
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return res; }
  let json: { mcpServers?: Record<string, Server> };
  try { json = JSON.parse(raw); } catch { res.skipped.push("(config has comments / invalid JSON — left untouched)"); return res; }

  const servers = json.mcpServers;
  if (!servers || typeof servers !== "object") return res;

  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== "object") { res.skipped.push(name); continue; }
    if (s._foreman_wrapped) { res.already.push(name); continue; }
    if (s.url && !s.command) { res.skipped.push(`${name} (remote — use \`foreman track\`)`); continue; }
    if (!s.command) { res.skipped.push(name); continue; }
    servers[name] = wrapServer(name, s, node, cli);
    res.wired.push(name);
  }

  if (!dryRun && res.wired.length) {
    const bak = file + ".foreman-bak";
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, raw, "utf8");
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
  }
  return res;
}

/** Restore one config file — un-prefix every wrapped server. */
export function unwireConfig(file: string): { restored: string[] } {
  const restored: string[] = [];
  let json: { mcpServers?: Record<string, Server> };
  try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { restored }; }
  const servers = json.mcpServers;
  if (!servers) return { restored };
  for (const [name, s] of Object.entries(servers)) {
    if (s && typeof s === "object" && s._foreman_wrapped) {
      servers[name] = unwrapServer(s);
      restored.push(name);
    }
  }
  if (restored.length) fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
  return { restored };
}

/** How many stdio MCP servers across all detected configs are not yet wired. */
export function countUnwired(cwd?: string, home?: string): number {
  let n = 0;
  for (const t of discoverConfigs(cwd, home)) {
    try {
      const json = JSON.parse(fs.readFileSync(t.path, "utf8")) as { mcpServers?: Record<string, Server> };
      for (const s of Object.values(json.mcpServers ?? {})) {
        if (s && typeof s === "object" && s.command && !s._foreman_wrapped) n++;
      }
    } catch { /* skip */ }
  }
  return n;
}
