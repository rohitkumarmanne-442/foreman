import { readEvents } from "./journal.js";
import { isVerificationCommand } from "./claims.js";
import { isIgnored } from "./config.js";
import { editLineDelta } from "./lines.js";
import type { ForemanEvent, PreToolData, SessionEndData, ToolData } from "./types.js";

/** One entry in a session's chronological activity feed. */
export interface TimelineItem {
  ts: string;
  type: "file" | "command" | "end";
  // file
  path?: string;
  action?: "write" | "edit";
  edits?: Array<{ old: string; new: string }>;
  before_sample?: string;
  after_sample?: string;
  lines_before?: number;
  lines_after?: number;
  lines_delta?: number;
  // command
  command?: string;
  ok?: boolean;
  verification?: boolean;
  // end
  claims?: string[];
  last_message?: string;
}

/**
 * Every captured event of one session, oldest first — the "show me each edit
 * as it happened" view, as opposed to the card's per-file aggregation.
 */
export function buildTimeline(session: string, events?: ForemanEvent[]): TimelineItem[] {
  const list = (events ?? readEvents())
    .filter((e) => e.session === session && e.agent !== "mcp-proxy")
    .sort((a, b) => a.ts.localeCompare(b.ts));

  // most recent pre-write snapshot per file, so each Write shows its own before-image
  const lastPre = new Map<string, PreToolData>();
  const items: TimelineItem[] = [];

  for (const e of list) {
    if (e.kind === "pre_tool") {
      const d = e.data as unknown as PreToolData;
      if (d.file) lastPre.set(d.file, d);
    } else if (e.kind === "tool") {
      const d = e.data as unknown as ToolData;
      if (d.tool === "Write" || d.tool === "Edit" || d.tool === "MultiEdit") {
        const path = d.file || "";
        if (!path || isIgnored(path)) continue;
        const item: TimelineItem = {
          ts: e.ts,
          type: "file",
          path,
          action: d.tool === "Write" ? "write" : "edit",
        };
        if (d.edits?.length) item.edits = d.edits;
        if (d.tool === "Write") {
          const pre = lastPre.get(path);
          if (pre?.exists && pre.content_sample !== undefined) item.before_sample = pre.content_sample;
          if (pre?.exists) item.lines_before = pre.lines;
          if (d.content_sample !== undefined) item.after_sample = d.content_sample;
          if (d.lines_after !== undefined) item.lines_after = d.lines_after;
          lastPre.delete(path); // consumed — the next Write needs its own snapshot
        } else if (d.edits?.length) {
          // edits give no post-edit file size; derive an exact before→after
          const pre = lastPre.get(path);
          if (pre?.exists) item.lines_before = pre.lines;
          const net = editLineDelta(d.edits);
          item.lines_delta = net;
          if (item.lines_before !== undefined) item.lines_after = Math.max(0, item.lines_before + net);
        }
        items.push(item);
      } else if (d.command) {
        items.push({
          ts: e.ts,
          type: "command",
          command: d.command,
          ok: d.ok,
          verification: isVerificationCommand(d.command),
        });
      }
    } else if (e.kind === "session_end") {
      const d = e.data as unknown as SessionEndData;
      items.push({ ts: e.ts, type: "end", claims: d.claims ?? [], last_message: d.last_message });
    }
  }
  return items;
}
