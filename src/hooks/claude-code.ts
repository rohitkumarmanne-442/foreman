import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendEvent } from "../journal.js";
import { extractClaims } from "../claims.js";

/** Payload Claude Code pipes to hook commands on stdin. */
interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

const SAMPLE_MAX = 20000; // bounded full-file samples (before/after a Write)
const EDIT_MAX = 4000; // bounded per-edit old/new strings

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function responseLooksFailed(resp: unknown): boolean {
  if (resp == null) return false;
  if (typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    if (r.is_error === true || r.success === false) return true;
    if (typeof r.error === "string" && r.error.length > 0) return true;
  }
  return false;
}

function lastAssistantText(transcriptPath: string): string {
  try {
    const text = fs.readFileSync(transcriptPath, "utf8");
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        const msg = row.message ?? row;
        if ((row.type === "assistant" || msg.role === "assistant") && msg.content) {
          const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
          const texts = parts
            .filter((p: any) => p && (p.type === "text" || typeof p === "string"))
            .map((p: any) => (typeof p === "string" ? p : p.text))
            .filter(Boolean);
          if (texts.length) return texts.join("\n");
        }
      } catch {
        // skip unparsable row
      }
    }
  } catch {
    // transcript unreadable — fine, claims stay empty
  }
  return "";
}

/** Entry point for `foreman hook claude-code`. Reads one JSON payload from
 * stdin, journals a compact event, always exits 0 — a hook must never block
 * or fail the agent. */
export async function handleClaudeCodeHook(): Promise<void> {
  let raw = "";
  try {
    for await (const chunk of process.stdin) raw += chunk;
    const p: HookPayload = JSON.parse(raw);
    const session = p.session_id || "unknown-session";
    const cwd = p.cwd || process.cwd();
    const event = p.hook_event_name || "";
    const tool = p.tool_name || "";
    const input = p.tool_input || {};

    if (event === "PreToolUse" && (tool === "Write" || tool === "Edit" || tool === "MultiEdit")) {
      const file = String(input.file_path || "");
      let exists = false;
      let lines = 0;
      let content_sample = "";
      if (file) {
        try {
          const content = fs.readFileSync(file, "utf8");
          exists = true;
          lines = countLines(content);
          // keep the before-image so the inbox can render a real diff
          if (tool === "Write") content_sample = content.slice(0, SAMPLE_MAX);
        } catch {
          exists = false;
        }
      }
      appendEvent({
        agent: "claude-code",
        session,
        cwd,
        kind: "pre_tool",
        data: { tool, file, exists, lines, ...(content_sample ? { content_sample } : {}) },
      });
    } else if (event === "PostToolUse") {
      const ok = !responseLooksFailed(p.tool_response);
      const data: Record<string, unknown> = { tool, ok };
      if (tool === "Write") {
        data.file = String(input.file_path || "");
        data.lines_after = countLines(String(input.content ?? ""));
        // bounded sample of written content — secret scanning + diff view
        data.content_sample = String(input.content ?? "").slice(0, SAMPLE_MAX);
      } else if (tool === "Edit") {
        data.file = String(input.file_path || "");
        data.content_sample = String(input.new_string ?? "").slice(0, SAMPLE_MAX);
        data.edits = [
          {
            old: String(input.old_string ?? "").slice(0, EDIT_MAX),
            new: String(input.new_string ?? "").slice(0, EDIT_MAX),
          },
        ];
      } else if (tool === "MultiEdit") {
        data.file = String(input.file_path || "");
        const edits = Array.isArray(input.edits) ? input.edits : [];
        data.edits = edits.slice(0, 20).map((e: any) => ({
          old: String(e?.old_string ?? "").slice(0, EDIT_MAX),
          new: String(e?.new_string ?? "").slice(0, EDIT_MAX),
        }));
        data.content_sample = (data.edits as Array<{ new: string }>).map((e) => e.new).join("\n");
      } else if (tool === "Bash" || tool === "PowerShell") {
        data.command = String(input.command ?? "").slice(0, 2000);
        data.description = String(input.description ?? "").slice(0, 300);
      } else {
        return; // other tools are read-only noise for a reviewer
      }
      appendEvent({ agent: "claude-code", session, cwd, kind: "tool", data });
    } else if (event === "Stop") {
      const lastMsg = p.transcript_path ? lastAssistantText(p.transcript_path) : "";
      appendEvent({
        agent: "claude-code",
        session,
        cwd,
        kind: "session_end",
        data: {
          transcript: p.transcript_path || "",
          last_message: lastMsg.slice(0, 4000),
          claims: extractClaims(lastMsg),
        },
      });
    }
  } catch {
    // never propagate — a broken hook must not break the agent
  }
}

/** Install Foreman hooks into Claude Code settings (project or global). */
export function installClaudeCodeHooks(opts: { global: boolean }): string {
  const settingsPath = opts.global
    ? path.join(os.homedir(), ".claude", "settings.json")
    : path.join(process.cwd(), ".claude", "settings.json");

  const hookCmd = `"${process.execPath}" "${cliPath()}" hook claude-code`;

  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      throw new Error(`Could not parse ${settingsPath} — fix it first.`);
    }
  }
  settings.hooks = settings.hooks || {};

  const entries: Array<[string, string]> = [
    ["PreToolUse", "Write|Edit|MultiEdit"],
    ["PostToolUse", "*"],
    ["Stop", "*"],
  ];
  for (const [eventName, matcher] of entries) {
    const list: any[] = (settings.hooks[eventName] = settings.hooks[eventName] || []);
    const already = list.some((m: any) =>
      (m.hooks || []).some((h: any) => typeof h.command === "string" && h.command.includes("hook claude-code"))
    );
    if (!already) {
      list.push({ matcher, hooks: [{ type: "command", command: hookCmd, timeout: 15 }] });
    }
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return settingsPath;
}

function cliPath(): string {
  // dist/hooks/claude-code.js -> dist/cli.js
  const here = new URL(import.meta.url).pathname;
  const decoded = decodeURIComponent(here.replace(/^\/([A-Za-z]:)/, "$1"));
  return path.join(path.dirname(path.dirname(decoded)), "cli.js");
}
