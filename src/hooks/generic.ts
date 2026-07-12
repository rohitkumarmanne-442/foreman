import { appendEvent } from "../journal.js";
import { extractClaims } from "../claims.js";

/**
 * The generic adapter — `foreman hook generic` (alias: `foreman ingest`).
 *
 * Any tool that can emit JSON can be a first-class Foreman adapter in a few
 * lines: pipe one event object (or one per line) to stdin. As agents ship
 * hook APIs, a native adapter is just a translation to this schema.
 *
 *   { "agent": "windsurf", "session": "s1", "cwd": "C:/repo",
 *     "kind": "command",     "command": "npm test", "ok": true }
 *   { "kind": "file",        "file": "src/a.ts", "lines_after": 40,
 *     "content": "...", "edits": [{"old":"a","new":"b"}] }
 *   { "kind": "end",         "message": "All tests pass." }
 *
 * kinds: "command" | "file" | "end" — everything else Foreman derives.
 */

const MAX_INPUT = 10 * 1024 * 1024;
const SAMPLE_MAX = 20000;

export function ingestOne(raw: Record<string, unknown>): boolean {
  const agent = String(raw.agent ?? "generic").slice(0, 40) || "generic";
  const session = String(raw.session ?? `generic-${new Date().toISOString().slice(0, 10)}`).slice(0, 120);
  const cwd = String(raw.cwd ?? process.cwd());
  const kind = String(raw.kind ?? "");

  if (kind === "command") {
    appendEvent({
      agent, session, cwd, kind: "tool",
      data: {
        tool: "Shell",
        ok: raw.ok !== false,
        command: String(raw.command ?? "").slice(0, 2000),
      },
    });
    return true;
  }
  if (kind === "file") {
    const edits = Array.isArray(raw.edits)
      ? (raw.edits as any[]).slice(0, 20).map((e) => ({
          old: String(e?.old ?? "").slice(0, 4000),
          new: String(e?.new ?? "").slice(0, 4000),
        }))
      : undefined;
    if (raw.lines_before !== undefined) {
      appendEvent({
        agent, session, cwd, kind: "pre_tool",
        data: {
          tool: "Write", file: String(raw.file ?? ""), exists: true,
          lines: Number(raw.lines_before) || 0,
          ...(raw.content_before !== undefined
            ? { content_sample: String(raw.content_before).slice(0, SAMPLE_MAX) }
            : {}),
        },
      });
    }
    appendEvent({
      agent, session, cwd, kind: "tool",
      data: {
        tool: edits?.length ? "Edit" : "Write",
        ok: raw.ok !== false,
        file: String(raw.file ?? ""),
        ...(raw.lines_after !== undefined ? { lines_after: Number(raw.lines_after) || 0 } : {}),
        ...(raw.content !== undefined ? { content_sample: String(raw.content).slice(0, SAMPLE_MAX) } : {}),
        ...(edits?.length ? { edits } : {}),
      },
    });
    return true;
  }
  if (kind === "end") {
    const message = String(raw.message ?? "").slice(0, 4000);
    appendEvent({
      agent, session, cwd, kind: "session_end",
      data: { transcript: "", last_message: message, claims: extractClaims(message) },
    });
    return true;
  }
  return false;
}

export async function handleGenericHook(): Promise<void> {
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      if (raw.length < MAX_INPUT) raw += chunk;
    }
    const text = raw.trim();
    if (!text) return;
    // accept one object, an array, or JSONL
    let accepted = 0;
    const tryIngest = (s: string) => {
      try {
        const parsed = JSON.parse(s);
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
          if (item && typeof item === "object" && ingestOne(item)) accepted++;
        }
      } catch { /* skip unparsable line */ }
    };
    if (text.startsWith("[") || !text.includes("\n")) tryIngest(text);
    else for (const line of text.split("\n")) if (line.trim()) tryIngest(line.trim());
    if (process.stdout.isTTY) console.log(`✅ ingested ${accepted} event(s)`);
  } catch {
    // adapters must never crash the caller
  }
}
