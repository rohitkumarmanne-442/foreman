import fs from "node:fs";
import path from "node:path";
import { FOREMAN_HOME, ensureDirs } from "./paths.js";
import type { ReviewStatus } from "./types.js";

const FILE = () => path.join(FOREMAN_HOME, "reviews.json");

export interface ReviewEntry {
  status: ReviewStatus;
  ts: string;
  note?: string;
}

export function loadReviews(): Record<string, ReviewEntry> {
  try {
    return JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    return {};
  }
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
