import { readEvents } from "./journal.js";
import { assessRisk } from "./risk.js";
import { isVerificationCommand } from "./claims.js";
import { loadReviews, loadDismissed } from "./reviews.js";
import { isIgnored } from "./config.js";
import { fillEditLineCounts } from "./lines.js";
import type {
  ForemanEvent,
  ReviewCard,
  FileTouch,
  CommandRun,
  SessionEndData,
  ToolData,
  PreToolData,
} from "./types.js";

/** Fold the raw event journal into one review card per agent session. */
export function buildCards(events?: ForemanEvent[]): ReviewCard[] {
  const all = events ?? readEvents();
  const bySession = new Map<string, ForemanEvent[]>();
  const drifts = all.filter((e) => e.kind === "mcp_drift");

  for (const e of all) {
    if (e.agent === "mcp-proxy") continue; // receipts render in their own view
    const list = bySession.get(e.session) ?? [];
    list.push(e);
    bySession.set(e.session, list);
  }

  const cards: ReviewCard[] = [];
  const dismissed = loadDismissed();
  const WEIGHT = { 4: 40, 3: 25, 2: 10, 1: 5 } as const;
  for (const [session, list] of bySession) {
    list.sort((a, b) => a.ts.localeCompare(b.ts));
    const first = list[0];
    const end = [...list].reverse().find((e) => e.kind === "session_end");

    // pre_tool snapshots give us lines_before + the before-image for Writes
    const preLines = new Map<string, number>();
    const preContent = new Map<string, string>();
    for (const e of list) {
      if (e.kind !== "pre_tool") continue;
      const d = e.data as unknown as PreToolData;
      if (d.file && d.exists) {
        preLines.set(d.file, d.lines ?? 0);
        // keep the FIRST before-image — that's the state the human last saw
        if (d.content_sample && !preContent.has(d.file)) preContent.set(d.file, d.content_sample);
      }
    }

    const filesMap = new Map<string, FileTouch>();
    const commands: CommandRun[] = [];
    const contentSamples: Array<{ file: string; sample: string }> = [];

    for (const e of list) {
      if (e.kind !== "tool") continue;
      const d = e.data as unknown as ToolData & { content_sample?: string };
      if (d.tool === "Write" || d.tool === "Edit" || d.tool === "MultiEdit") {
        const path = d.file || "";
        if (!path || isIgnored(path)) continue;
        const existing = filesMap.get(path);
        const touch: FileTouch = existing ?? {
          path,
          action: d.tool === "Write" ? "write" : "edit",
          first_ts: e.ts,
          lines_before: preLines.get(path),
        };
        touch.last_ts = e.ts;
        touch.touches = (touch.touches ?? 0) + 1;
        if (d.tool === "Write") {
          touch.action = "write";
          touch.lines_after = d.lines_after;
          if (touch.lines_before === undefined) touch.lines_before = preLines.get(path);
          touch.before_sample = preContent.get(path);
          touch.after_sample = d.content_sample;
        } else if (d.edits?.length) {
          touch.edits = [...(touch.edits ?? []), ...d.edits];
        }
        filesMap.set(path, touch);
        if (d.content_sample) contentSamples.push({ file: path, sample: d.content_sample });
      } else if (d.command) {
        commands.push({
          command: d.command,
          ok: d.ok,
          verification: isVerificationCommand(d.command),
        });
      }
    }

    // edits never gave us a post-edit file size; derive an exact before→after
    // from the edit pairs so the UI always shows a clear line count
    for (const t of filesMap.values()) fillEditLineCounts(t);

    const endData = (end?.data ?? { claims: [] }) as unknown as SessionEndData;
    const sessionDrifts = drifts.filter(
      (dr) => dr.ts >= first.ts && (!end || dr.ts <= end.ts)
    ).length;

    // most recently edited first — "what just changed" is the question reviewers ask
    const files = [...filesMap.values()].sort((a, b) =>
      (b.last_ts ?? "").localeCompare(a.last_ts ?? "")
    );
    const risk = assessRisk({
      files,
      commands,
      claims: endData.claims ?? [],
      contentSamples,
      mcpDrifts: sessionDrifts,
    });

    cards.push({
      session,
      review: "pending",
      ...(first.origin ? { origin: first.origin } : {}),
      agent: first.agent,
      cwd: first.cwd,
      started: first.ts,
      ended: end?.ts,
      // Claude Code fires a session_end at every turn — the session is only
      // truly closed when nothing has happened since the last one
      open: list[list.length - 1].kind !== "session_end",
      last_activity: list[list.length - 1].ts,
      files,
      commands,
      claims: endData.claims ?? [],
      verified_claims: risk.verifiedClaims,
      // dismissed false positives drop out and the score re-derives
      ...(() => {
        const kept = risk.findings.filter((f) => !dismissed[`${session}|${f.rule}`]);
        if (kept.length === risk.findings.length)
          return { findings: risk.findings, score: risk.score, level: risk.level };
        const score = Math.min(100, kept.reduce((n, f) => n + WEIGHT[f.severity], 0));
        return {
          findings: kept, score,
          level: (score >= 70 ? "critical" : score >= 40 ? "high" : score >= 15 ? "medium" : "low") as ReviewCard["level"],
        };
      })(),
      mcp_calls: all.filter((e) => e.kind === "mcp_call" && e.session === session).length,
      mcp_drifts: sessionDrifts,
      last_message: endData.last_message,
    });
  }

  const reviews = loadReviews();
  for (const c of cards) {
    const r = reviews[c.session];
    c.review = r?.status ?? "pending";
    if (r?.note) c.review_note = r.note;
    if (r?.autopilot) c.autopilot = true;
    // an approval is a watermark: it covers the work up to its ts, nothing after
    if (c.review === "approved" && r?.ts && c.last_activity > r.ts) {
      c.review = "pending";
      c.reopened = true;
      c.reviewed_until = r.ts;
      c.new_changes = (bySession.get(c.session) ?? []).filter(
        (e) => e.ts > r.ts && e.kind === "tool"
      ).length;
    }
  }

  // Needs-review first, then risk, then recency — the whole point of the inbox
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const rOrder = { flagged: 0, pending: 0, approved: 1 };
  cards.sort(
    (a, b) =>
      rOrder[a.review] - rOrder[b.review] ||
      order[a.level] - order[b.level] ||
      b.started.localeCompare(a.started)
  );
  return cards;
}
