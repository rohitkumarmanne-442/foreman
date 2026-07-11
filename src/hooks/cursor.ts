import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendEvent } from "../journal.js";
import { extractClaims } from "../claims.js";

/** Payloads per https://cursor.com/docs/hooks (v1). All events share
 * conversation_id, workspace_roots, hook_event_name. */
interface CursorPayload {
  hook_event_name?: string;
  conversation_id?: string;
  workspace_roots?: string[];
  cwd?: string;
  transcript_path?: string | null;
  // afterShellExecution
  command?: string;
  output?: string;
  duration?: number;
  // afterFileEdit
  file_path?: string;
  edits?: Array<{ old_string?: string; new_string?: string }>;
  // afterMCPExecution
  tool_name?: string;
  result_json?: string;
  // stop
  status?: string;
}

const SAMPLE_MAX = 20000;
const EDIT_MAX = 4000;

/** Shell output has no exit code in the payload — recognise obvious failure
 * markers so verification commands aren't wrongly counted as passing. */
const FAILURE_MARKERS =
  /(^|\n)\s*(error[:\s]|fatal:|npm ERR!|Traceback \(most recent call last\)|FAILED|AssertionError|CompileError|exit code [1-9]|command not found|is not recognized as)/i;

export async function handleCursorHook(): Promise<void> {
  let raw = "";
  try {
    for await (const chunk of process.stdin) raw += chunk;
    const p: CursorPayload = JSON.parse(raw);
    const session = p.conversation_id || "cursor-unknown";
    const cwd = p.workspace_roots?.[0] || p.cwd || process.cwd();
    const event = p.hook_event_name || "";

    if (event === "afterShellExecution") {
      appendEvent({
        agent: "cursor",
        session,
        cwd,
        kind: "tool",
        data: {
          tool: "Shell",
          ok: !FAILURE_MARKERS.test((p.output ?? "").slice(0, 8000)),
          command: String(p.command ?? "").slice(0, 2000),
        },
      });
    } else if (event === "afterFileEdit") {
      const file = String(p.file_path ?? "");
      let lines_after: number | undefined;
      try {
        lines_after = fs.readFileSync(file, "utf8").split("\n").length;
      } catch {
        lines_after = undefined;
      }
      const edits = (p.edits ?? []).slice(0, 20).map((e) => ({
        old: String(e.old_string ?? "").slice(0, EDIT_MAX),
        new: String(e.new_string ?? "").slice(0, EDIT_MAX),
      }));
      appendEvent({
        agent: "cursor",
        session,
        cwd,
        kind: "tool",
        data: {
          tool: "Edit",
          ok: true,
          file,
          ...(lines_after !== undefined ? { lines_after } : {}),
          edits,
          content_sample: edits.map((e) => e.new).join("\n").slice(0, SAMPLE_MAX),
        },
      });
    } else if (event === "afterMCPExecution") {
      appendEvent({
        agent: "cursor",
        session,
        cwd,
        kind: "tool",
        data: {
          tool: "MCP",
          ok: true,
          command: `[MCP] ${String(p.tool_name ?? "unknown-tool")}`,
        },
      });
    } else if (event === "stop") {
      let lastMsg = "";
      if (p.transcript_path) {
        try {
          // transcript format is agent-internal; harvest text fields defensively
          const text = fs.readFileSync(p.transcript_path, "utf8");
          const matches = [...text.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.){20,2000})"/g)];
          if (matches.length) {
            lastMsg = JSON.parse(`"${matches[matches.length - 1][1]}"`);
          }
        } catch {
          // transcript unreadable — claims stay empty
        }
      }
      appendEvent({
        agent: "cursor",
        session,
        cwd,
        kind: "session_end",
        data: {
          transcript: p.transcript_path || "",
          last_message: lastMsg.slice(0, 4000),
          claims: extractClaims(lastMsg),
          status: p.status || "",
        },
      });
    }
  } catch {
    // hooks must never break the agent
  }
}

/** Install Foreman into Cursor's hooks.json (project or user level). */
export function installCursorHooks(opts: { global: boolean }): string {
  const hooksPath = opts.global
    ? path.join(os.homedir(), ".cursor", "hooks.json")
    : path.join(process.cwd(), ".cursor", "hooks.json");

  const hookCmd = `"${process.execPath}" "${cliPath()}" hook cursor`;

  let config: any = { version: 1, hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      config = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    } catch {
      throw new Error(`Could not parse ${hooksPath} — fix it first.`);
    }
  }
  config.version = config.version ?? 1;
  config.hooks = config.hooks || {};

  for (const eventName of ["afterShellExecution", "afterFileEdit", "afterMCPExecution", "stop"]) {
    const list: any[] = (config.hooks[eventName] = config.hooks[eventName] || []);
    const already = list.some(
      (h: any) => typeof h.command === "string" && h.command.includes("hook cursor")
    );
    if (!already) list.push({ command: hookCmd, timeout: 15 });
  }

  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return hooksPath;
}

export function uninstallCursorHooks(opts: { global: boolean }): boolean {
  const hooksPath = opts.global
    ? path.join(os.homedir(), ".cursor", "hooks.json")
    : path.join(process.cwd(), ".cursor", "hooks.json");
  if (!fs.existsSync(hooksPath)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    let removed = false;
    for (const key of Object.keys(config.hooks || {})) {
      const before = config.hooks[key].length;
      config.hooks[key] = config.hooks[key].filter(
        (h: any) => !(typeof h.command === "string" && h.command.includes("hook cursor"))
      );
      if (config.hooks[key].length !== before) removed = true;
      if (config.hooks[key].length === 0) delete config.hooks[key];
    }
    fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    return removed;
  } catch {
    return false;
  }
}

function cliPath(): string {
  const here = new URL(import.meta.url).pathname;
  const decoded = decodeURIComponent(here.replace(/^\/([A-Za-z]:)/, "$1"));
  return path.join(path.dirname(path.dirname(decoded)), "cli.js");
}
