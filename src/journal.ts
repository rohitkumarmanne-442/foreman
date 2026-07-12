import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EVENTS_DIR, ensureDirs } from "./paths.js";
import type { ForemanEvent } from "./types.js";

function todayFile(): string {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(EVENTS_DIR(), `${d}.jsonl`);
}

/** Append one event to today's journal file. Safe across processes (O_APPEND). */
export function appendEvent(
  e: Omit<ForemanEvent, "v" | "id" | "ts"> & { ts?: string }
): ForemanEvent {
  ensureDirs();
  const full: ForemanEvent = {
    v: 1,
    id: crypto.randomUUID(),
    ts: e.ts ?? new Date().toISOString(),
    agent: e.agent,
    session: e.session,
    cwd: e.cwd,
    kind: e.kind,
    data: e.data,
    ...(e.origin ? { origin: e.origin } : {}),
  };
  fs.appendFileSync(todayFile(), JSON.stringify(full) + "\n", "utf8");
  return full;
}

/** Read every event, oldest file first. Tolerates torn/corrupt lines. */
export function readEvents(): ForemanEvent[] {
  const dir = EVENTS_DIR();
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const out: ForemanEvent[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && parsed.v === 1 && parsed.kind) out.push(parsed);
      } catch {
        // torn write — skip
      }
    }
  }
  return out;
}
