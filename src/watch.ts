import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { appendEvent } from "./journal.js";
import { isIgnored } from "./config.js";

/**
 * `foreman watch` — the universal adapter.
 *
 * Works with ANY IDE or agent (Windsurf, Copilot, JetBrains AI, a human…)
 * because it observes the repo itself instead of hooking one tool: every few
 * seconds it diffs the working tree against git HEAD and journals what
 * changed. No commands or claims can be captured this way, but mass rewrites,
 * secrets, and sensitive-path touches are all caught.
 */

const SAMPLE_MAX = 20000;

export interface WatchState {
  repo: string;
  session: string;
  /** file -> sha256 of last journaled content, to avoid duplicate events */
  lastHash: Map<string, string>;
  /** files whose pre_tool baseline event was already journaled */
  baselined: Set<string>;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
}

export function createWatchState(repo: string): WatchState {
  git(repo, ["rev-parse", "--is-inside-work-tree"]); // throws if not a repo
  return {
    repo,
    session: `watch-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}-${crypto
      .randomUUID()
      .slice(0, 4)}`,
    lastHash: new Map(),
    baselined: new Set(),
  };
}

/** One poll: journal every file whose content changed since the last poll. */
export function pollOnce(state: WatchState, journal = appendEvent): string[] {
  const changed: string[] = [];
  let status = "";
  try {
    status = git(state.repo, ["status", "--porcelain"]);
  } catch {
    return changed; // transient git failure — try again next tick
  }

  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let file = line.slice(3).trim().replace(/^"|"$/g, "");
    if (code.includes("R")) file = file.split(" -> ").pop() ?? file; // renames
    if (isIgnored(file)) continue;
    if (code.includes("D")) continue; // deletions: no content to snapshot

    const full = path.join(state.repo, file);
    let content: string;
    try {
      content = fs.readFileSync(full, "utf8");
    } catch {
      continue; // binary/locked/vanished
    }
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    if (state.lastHash.get(file) === hash) continue;
    state.lastHash.set(file, hash);
    changed.push(file);

    // First sighting: journal the committed baseline as the before-image
    if (!state.baselined.has(file)) {
      state.baselined.add(file);
      let before = "";
      let exists = false;
      try {
        before = git(state.repo, ["show", `HEAD:${file.replace(/\\/g, "/")}`]);
        exists = true;
      } catch {
        exists = false; // new/untracked file
      }
      journal({
        agent: "watch",
        session: state.session,
        cwd: state.repo,
        kind: "pre_tool",
        data: {
          tool: "Write",
          file,
          exists,
          lines: exists ? before.split("\n").length : 0,
          ...(exists ? { content_sample: before.slice(0, SAMPLE_MAX) } : {}),
        },
      });
    }

    journal({
      agent: "watch",
      session: state.session,
      cwd: state.repo,
      kind: "tool",
      data: {
        tool: "Write",
        ok: true,
        file,
        lines_after: content.split("\n").length,
        content_sample: content.slice(0, SAMPLE_MAX),
      },
    });
  }
  return changed;
}

export function endWatchSession(state: WatchState, journal = appendEvent): void {
  journal({
    agent: "watch",
    session: state.session,
    cwd: state.repo,
    kind: "session_end",
    data: { transcript: "", last_message: "", claims: [] },
  });
}

/** Entry point for `foreman watch [--interval ms]`. Runs until Ctrl+C. */
export function runWatch(repo: string, intervalMs = 3000): void {
  const state = createWatchState(repo);
  console.log(`🧑‍🏭 Foreman is watching ${repo}`);
  console.log(`   Session ${state.session} — every file change becomes reviewable.`);
  console.log(`   Works with any IDE or agent. Ctrl+C to stop and close the card.`);

  const timer = setInterval(() => {
    const changed = pollOnce(state);
    for (const f of changed) console.log(`   ✏️  ${f}`);
  }, intervalMs);

  const stop = () => {
    clearInterval(timer);
    endWatchSession(state);
    console.log(`\n   Card closed. Review it:  foreman ui`);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
