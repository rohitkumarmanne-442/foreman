import fs from "node:fs";
import path from "node:path";
import { FOREMAN_HOME, ensureDirs } from "./paths.js";
import type { ReviewStatus } from "./types.js";

const FILE = () => path.join(FOREMAN_HOME, "reviews.json");

export interface ReviewEntry {
  status: ReviewStatus;
  ts: string;
  note?: string;
  /** approved automatically by Adaptive Autopilot (trusted agent + low risk). */
  autopilot?: boolean;
}

export function loadReviews(): Record<string, ReviewEntry> {
  try {
    return JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    return {};
  }
}

const DISMISS_FILE = () => path.join(FOREMAN_HOME, "dismissed.json");

/** False-positive dismissals: "session|rule" → true. Heuristics misfire;
 * one click removes the finding and re-scores the card, so alerts stay
 * meaningful instead of training the user to ignore them. */
export function loadDismissed(): Record<string, true> {
  try { return JSON.parse(fs.readFileSync(DISMISS_FILE(), "utf8")); } catch { return {}; }
}

export function setDismissed(session: string, rule: string, undo = false): void {
  ensureDirs();
  const all = loadDismissed();
  const key = `${session}|${rule}`;
  if (undo) delete all[key]; else all[key] = true;
  fs.writeFileSync(DISMISS_FILE(), JSON.stringify(all, null, 2), "utf8");
}

export function setReview(session: string, status: ReviewStatus, note?: string): void {
  ensureDirs();
  const all = loadReviews();
  if (status === "pending") delete all[session];
  else {
    all[session] = { status, ts: new Date().toISOString() };
    const trimmed = (note ?? "").trim().slice(0, 2000);
    if (trimmed) all[session].note = trimmed;
  }
  fs.writeFileSync(FILE(), JSON.stringify(all, null, 2), "utf8");
}

/** Approve a session on behalf of Adaptive Autopilot (only if not already reviewed). */
export function setAutoApproved(session: string): boolean {
  ensureDirs();
  const all = loadReviews();
  if (all[session]) return false; // never override a human decision
  all[session] = { status: "approved", ts: new Date().toISOString(), autopilot: true };
  fs.writeFileSync(FILE(), JSON.stringify(all, null, 2), "utf8");
  return true;
}
