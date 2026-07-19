import { readEvents } from "./journal.js";
import { buildCards } from "./cards.js";
import { isIgnored } from "./config.js";
import type { ForemanEvent, ToolData } from "./types.js";

/**
 * Collision guard — two agents editing the SAME file while both sessions were
 * live. When agents run concurrently (Claude in one window, Cursor in another,
 * two parallel runs…), last-writer-wins can silently drop the other's work: the
 * second agent never saw the first agent's unsaved changes. Foreman is the only
 * place that can see this, because it holds every file touch across every agent
 * and session in one journal.
 *
 * A collision is reported for a file when two+ distinct sessions touched it and
 * at least one session touched it WHILE another session was still active — i.e.
 * the edits genuinely overlapped in time, not one-after-the-other. Deterministic,
 * zero LLM.
 */

export interface CollisionParty {
  session: string;
  agent: string;
  first: string; // this session's first touch of the file
  last: string; // this session's last touch of the file
  touches: number;
  action: "write" | "edit";
  open: boolean; // session still running
  review: string; // pending / approved / flagged
}

export interface Collision {
  path: string;
  parties: CollisionParty[]; // >= 2 distinct sessions, earliest-first
  window: { start: string; end: string }; // first→last touch across all parties
  last_writer: { session: string; agent: string; ts: string };
  /** two or more of the colliding sessions are still running right now */
  concurrent_open: boolean;
  /** the colliding sessions are different agents (vs two runs of the same one) */
  cross_agent: boolean;
}

export function detectCollisions(events?: ForemanEvent[]): Collision[] {
  const all = events ?? readEvents();
  // session activity spans (started → last activity) + agent/open/review, reused
  const span = new Map(
    buildCards(all).map((c) => [
      c.session,
      { start: c.started, end: c.last_activity, agent: c.agent, open: c.open, review: c.review },
    ])
  );

  // file → session → { every touch time, action, count }
  const byFile = new Map<
    string,
    Map<string, { times: string[]; action: "write" | "edit"; touches: number; agent: string }>
  >();
  for (const e of all) {
    if (e.kind !== "tool" || e.agent === "mcp-proxy") continue;
    const d = e.data as unknown as ToolData;
    if (!d.file || !(d.tool === "Write" || d.tool === "Edit" || d.tool === "MultiEdit")) continue;
    if (isIgnored(d.file)) continue;
    let m = byFile.get(d.file);
    if (!m) { m = new Map(); byFile.set(d.file, m); }
    let r = m.get(e.session);
    if (!r) { r = { times: [], action: d.tool === "Write" ? "write" : "edit", touches: 0, agent: e.agent }; m.set(e.session, r); }
    r.times.push(e.ts);
    r.touches++;
    if (d.tool === "Write") r.action = "write";
  }

  const within = (t: string, s?: { start: string; end: string }) => !!s && t >= s.start && t <= s.end;

  const out: Collision[] = [];
  for (const [path, m] of byFile) {
    if (m.size < 2) continue;
    const sessions = [...m.keys()];

    // require a genuine overlap: one session touched the file while another
    // session was still active (not simply sequential edits hours apart)
    let overlaps = false;
    for (let i = 0; i < sessions.length && !overlaps; i++) {
      for (let j = i + 1; j < sessions.length && !overlaps; j++) {
        const A = m.get(sessions[i])!, B = m.get(sessions[j])!;
        const sA = span.get(sessions[i]), sB = span.get(sessions[j]);
        if (A.times.some((t) => within(t, sB)) || B.times.some((t) => within(t, sA))) overlaps = true;
      }
    }
    if (!overlaps) continue;

    const parties: CollisionParty[] = sessions
      .map((s) => {
        const r = m.get(s)!;
        const times = [...r.times].sort();
        const sp = span.get(s);
        return {
          session: s,
          agent: r.agent,
          first: times[0],
          last: times[times.length - 1],
          touches: r.touches,
          action: r.action,
          open: sp?.open ?? false,
          review: sp?.review ?? "pending",
        };
      })
      .sort((a, b) => a.first.localeCompare(b.first));

    const start = parties.reduce((mn, p) => (p.first < mn ? p.first : mn), parties[0].first);
    const end = parties.reduce((mx, p) => (p.last > mx ? p.last : mx), parties[0].last);
    const last_writer = parties.reduce(
      (w, p) => (p.last > w.ts ? { session: p.session, agent: p.agent, ts: p.last } : w),
      { session: parties[0].session, agent: parties[0].agent, ts: parties[0].last }
    );

    out.push({
      path,
      parties,
      window: { start, end },
      last_writer,
      concurrent_open: parties.filter((p) => p.open).length >= 2,
      cross_agent: new Set(parties.map((p) => p.agent)).size > 1,
    });
  }

  out.sort((a, b) => b.window.end.localeCompare(a.window.end));
  return out;
}
