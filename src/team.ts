import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { readEvents } from "./journal.js";
import { loadReviews, type ReviewEntry } from "./reviews.js";
import { EVENTS_DIR, ensureDirs } from "./paths.js";
import { loadOrCreateKeys, canonical, sha256 } from "./mcp/receipts.js";
import { sameRepo } from "./feedback.js";
import type { ForemanEvent } from "./types.js";

/**
 * Team mode — git is the sync layer, no server involved.
 *
 * `foreman team sync` in a repo:
 *   1. exports YOUR sessions for this repo into .foreman-team/<keyid>.json
 *      (ed25519-signed, so teammates can verify who produced it), and
 *   2. imports every teammate pack found in that folder into your inbox,
 *      rejecting packs whose signature doesn't verify.
 *
 * Commit the folder; teammates' cards travel through ordinary pushes/pulls.
 */

const TEAM_DIR = ".foreman-team";

interface TeamPack {
  v: 1;
  owner: string;
  key: string; // base64 SPKI ed25519 public key
  created: string;
  events: ForemanEvent[];
  reviews: Record<string, ReviewEntry>;
  sig: string; // over canonical({owner, created, events, reviews})
}

export function keyId(pkB64: string): string {
  return sha256(pkB64).slice(0, 12);
}

function packBodyToSign(p: Omit<TeamPack, "sig" | "v" | "key">): string {
  return canonical({ owner: p.owner, created: p.created, events: p.events, reviews: p.reviews });
}

export function exportPack(repo: string, ownerName?: string): { file: string; sessions: number } {
  const { privateKey, publicKeyB64 } = loadOrCreateKeys();
  const owner = (ownerName || os.userInfo().username || "unknown").slice(0, 60);

  // my events for this repo (imported teammate events stay out — no re-export loops)
  const events = readEvents().filter(
    (e) => !e.origin && e.agent !== "mcp-proxy" && sameRepo(e.cwd, repo) && !e.session.startsWith("demo-")
  );
  const sessions = new Set(events.map((e) => e.session));
  const reviews: Record<string, ReviewEntry> = {};
  const all = loadReviews();
  for (const s of sessions) if (all[s]) reviews[s] = all[s];

  const body = { owner, created: new Date().toISOString(), events, reviews };
  const sig = crypto
    .sign(null, Buffer.from(packBodyToSign(body), "utf8"), privateKey)
    .toString("base64");

  const dir = path.join(repo, TEAM_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${keyId(publicKeyB64)}.json`);
  const pack: TeamPack = { v: 1, key: publicKeyB64, ...body, sig };
  fs.writeFileSync(file, JSON.stringify(pack, null, 1), "utf8");
  return { file, sessions: sessions.size };
}

export interface ImportSummary {
  packs: number;
  imported_events: number;
  skipped_invalid: string[]; // filenames with bad signatures/shape
}

export function importPacks(repo: string): ImportSummary {
  ensureDirs();
  const dir = path.join(repo, TEAM_DIR);
  const summary: ImportSummary = { packs: 0, imported_events: 0, skipped_invalid: [] };
  if (!fs.existsSync(dir)) return summary;

  const { publicKeyB64 } = loadOrCreateKeys();
  const myId = keyId(publicKeyB64);
  const existingIds = new Set(readEvents().map((e) => e.id));

  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    if (f === `${myId}.json`) continue; // my own pack
    const full = path.join(dir, f);
    let pack: TeamPack;
    try {
      pack = JSON.parse(fs.readFileSync(full, "utf8"));
      if (pack.v !== 1 || !Array.isArray(pack.events) || typeof pack.key !== "string") {
        throw new Error("bad shape");
      }
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(pack.key, "base64"),
        format: "der",
        type: "spki",
      });
      const ok = crypto.verify(
        null,
        Buffer.from(packBodyToSign(pack), "utf8"),
        publicKey,
        Buffer.from(pack.sig, "base64")
      );
      if (!ok) throw new Error("signature verification failed");
    } catch {
      summary.skipped_invalid.push(f);
      continue;
    }

    summary.packs++;
    const lines: string[] = [];
    for (const e of pack.events.slice(0, 50000)) {
      if (!e || e.v !== 1 || !e.id || !e.kind || existingIds.has(e.id)) continue;
      existingIds.add(e.id);
      lines.push(JSON.stringify({ ...e, origin: pack.owner }));
      summary.imported_events++;
    }
    if (lines.length) {
      // separate file per teammate key — re-import stays idempotent via ids
      fs.appendFileSync(
        path.join(EVENTS_DIR(), `team-${keyId(pack.key)}.jsonl`),
        lines.join("\n") + "\n",
        "utf8"
      );
    }
  }
  return summary;
}
