import fs from "node:fs";
import path from "node:path";
import { FOREMAN_HOME, ensureDirs } from "./paths.js";
import type { ReviewStatus } from "./types.js";

const FILE = () => path.join(FOREMAN_HOME, "reviews.json");

interface ReviewEntry {
  status: ReviewStatus;
  ts: string;
}

export function loadReviews(): Record<string, ReviewEntry> {
  try {
    return JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    return {};
  }
}

export function setReview(session: string, status: ReviewStatus): void {
  ensureDirs();
  const all = loadReviews();
  if (status === "pending") delete all[session];
  else all[session] = { status, ts: new Date().toISOString() };
  fs.writeFileSync(FILE(), JSON.stringify(all, null, 2), "utf8");
}
