import { readEvents } from "./journal.js";
import { assessRisk } from "./risk.js";
import { isVerificationCommand } from "./claims.js";
import { loadReviews } from "./reviews.js";
import { isIgnored } from "./config.js";
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
          lines_before: preLines.get(path),
        };
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

    const endData = (end?.data ?? { claims: [] }) as unknown as SessionEndData;
    const sessionDrifts = drifts.filter(
      (dr) => dr.ts >= first.ts && (!end || dr.ts <= end.ts)
    ).length;

    const files = [...filesMap.values()];
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
      open: !end,
      last_activity: list[list.length - 1].ts,
      files,
      commands,
      claims: endData.claims ?? [],
      verified_claims: risk.verifiedClaims,
      findings: risk.findings,
      score: risk.score,
      level: risk.level,
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
    // an approval only covers the work the human actually saw — new events void it
    if (c.review === "approved" && r?.ts && c.last_activity > r.ts) {
      c.review = "pending";
      c.reopened = true;
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
