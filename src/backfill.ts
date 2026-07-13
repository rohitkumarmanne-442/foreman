import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { appendEvent, readEvents } from "./journal.js";
import { extractClaims } from "./claims.js";

const SAMPLE_MAX = 20000;
const EDIT_MAX = 4000;

export interface BackfillResult {
  files_scanned: number;
  sessions_imported: number;
  sessions_skipped_existing: number;
  sessions_skipped_empty: number;
  events: number;
}

/** Default transcript home for Claude Code. */
export function transcriptRoot(): string {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? "~", ".claude", "projects");
}

interface Line {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: { role?: string; content?: Array<Record<string, unknown>> | string };
}

/**
 * foreman backfill — mine the agent history you ALREADY have.
 *
 * Claude Code journals every session as JSONL under ~/.claude/projects.
 * This streams those transcripts and turns each historical session into a
 * review card with its real timestamps: Write/Edit/MultiEdit → file events
 * (edit pairs preserved, so mass-rewrite detection works on edits),
 * Bash → command events (ok matched from the tool_result), and the final
 * assistant message → claims. Sessions already in the journal are skipped,
 * so live-hooked sessions never duplicate.
 */
export async function backfill(opts: { root?: string; days?: number; onFile?: (f: string) => void } = {}): Promise<BackfillResult> {
  const root = opts.root ?? transcriptRoot();
  const res: BackfillResult = { files_scanned: 0, sessions_imported: 0, sessions_skipped_existing: 0, sessions_skipped_empty: 0, events: 0 };
  if (!fs.existsSync(root)) return res;

  const known = new Set(readEvents().map((e) => e.session));
  const cutoff = opts.days ? Date.now() - opts.days * 86400000 : 0;

  const files: string[] = [];
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith(".jsonl")) files.push(path.join(full, f));
    }
  }

  for (const file of files) {
    res.files_scanned++;
    opts.onFile?.(file);
    const sessionFromName = path.basename(file, ".jsonl");
    if (known.has(sessionFromName)) { res.sessions_skipped_existing++; continue; }

    type Ev = { ts: string; kind: "pre_tool" | "tool" | "session_end"; data: Record<string, unknown> };
    const events: Ev[] = [];
    const pendingOk = new Map<string, Ev>(); // tool_use_id → command event awaiting its result
    let sessionId = sessionFromName;
    let cwd = "";
    let lastTs = "";
    let lastText = "";
    let sawRecentEnough = !opts.days;

    const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const raw of rl) {
      if (!raw.trim()) continue;
      let line: Line;
      try { line = JSON.parse(raw); } catch { continue; }
      if (line.sessionId) sessionId = line.sessionId;
      if (line.cwd) cwd = line.cwd;
      const ts = line.timestamp ?? lastTs;
      if (ts) lastTs = ts;
      if (cutoff && ts && new Date(ts).getTime() >= cutoff) sawRecentEnough = true;

      const content = Array.isArray(line.message?.content) ? line.message!.content! : [];
      for (const block of content) {
        const btype = block.type as string;
        if (btype === "text" && line.type === "assistant") {
          const t = String(block.text ?? "");
          if (t.trim()) lastText = t;
        } else if (btype === "tool_use") {
          const name = String(block.name ?? "");
          const input = (block.input ?? {}) as Record<string, unknown>;
          const id = String(block.id ?? "");
          if (name === "Write" && input.file_path) {
            const body = String(input.content ?? "");
            events.push({ ts, kind: "tool", data: {
              tool: "Write", ok: true, file: String(input.file_path),
              lines_after: body ? body.split("\n").length : 0,
              content_sample: body.slice(0, SAMPLE_MAX),
            }});
          } else if ((name === "Edit" || name === "MultiEdit") && input.file_path) {
            const edits = name === "Edit"
              ? [{ old: String(input.old_string ?? "").slice(0, EDIT_MAX), new: String(input.new_string ?? "").slice(0, EDIT_MAX) }]
              : (Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>).slice(0, 20).map((e) => ({
                  old: String(e.old_string ?? "").slice(0, EDIT_MAX), new: String(e.new_string ?? "").slice(0, EDIT_MAX),
                })) : []);
            events.push({ ts, kind: "tool", data: { tool: "Edit", ok: true, file: String(input.file_path), edits } });
          } else if (name === "Bash" && input.command) {
            const ev: Ev = { ts, kind: "tool", data: { tool: "Bash", ok: true, command: String(input.command).slice(0, 2000) } };
            events.push(ev);
            if (id) pendingOk.set(id, ev);
          }
        } else if (btype === "tool_result") {
          const id = String(block.tool_use_id ?? "");
          const ev = pendingOk.get(id);
          if (ev) { ev.data.ok = !(block.is_error === true); pendingOk.delete(id); }
        }
      }
    }

    if (known.has(sessionId)) { res.sessions_skipped_existing++; continue; }
    if (!events.length || !sawRecentEnough) { res.sessions_skipped_empty++; continue; }

    for (const e of events) {
      appendEvent({ agent: "claude-code", session: sessionId, cwd: cwd || root, kind: e.kind, data: e.data, ts: e.ts || undefined });
      res.events++;
    }
    appendEvent({
      agent: "claude-code", session: sessionId, cwd: cwd || root, kind: "session_end",
      data: { claims: extractClaims(lastText), last_message: lastText.slice(0, 2000) },
      ts: lastTs || undefined,
    });
    res.events++;
    known.add(sessionId);
    res.sessions_imported++;
  }
  return res;
}
