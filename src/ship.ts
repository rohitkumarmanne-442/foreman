import { readEvents } from "./journal.js";
import { buildCards } from "./cards.js";

/**
 * "Shipped to Prod" — what agents actually pushed live.
 *
 * Scans the journal for commands that ship code to production (deploys,
 * publishes, releases, pushes to main), and joins each to its review card so
 * you can see, at a glance, what went live — and flag anything that reached
 * prod WITHOUT being reviewed. Deterministic pattern match, zero LLM.
 */

export interface ShipKind {
  kind: "deployed" | "published" | "released" | "merged" | "pushed" | "force-pushed";
  detail: string; // "Vercel", "npm", "git → main", …
  prod: boolean;  // strong production signal (deploy/publish/release/force-push/push-to-main)
}

const PLATFORM: Array<{ re: RegExp; kind: ShipKind["kind"]; detail: string }> = [
  { re: /\bvercel\b(?=.*(--prod|deploy)|\s*$)/i, kind: "deployed", detail: "Vercel" },
  { re: /\bnetlify\s+deploy\b.*--prod/i, kind: "deployed", detail: "Netlify" },
  { re: /\b(fly|flyctl)\s+deploy\b/i, kind: "deployed", detail: "Fly.io" },
  { re: /\brender\b.*\bdeploy/i, kind: "deployed", detail: "Render" },
  { re: /\bwrangler\b.*\b(deploy|publish)\b/i, kind: "deployed", detail: "Cloudflare" },
  { re: /\bfirebase\b.*\bdeploy\b/i, kind: "deployed", detail: "Firebase" },
  { re: /\b(sls|serverless)\s+deploy\b/i, kind: "deployed", detail: "Serverless" },
  { re: /\bheroku\b.*(deploy|releases:|git\s+push\s+heroku)/i, kind: "deployed", detail: "Heroku" },
  { re: /\bkubectl\s+(apply|rollout)\b|\bhelm\s+(upgrade|install)\b/i, kind: "deployed", detail: "Kubernetes" },
  { re: /\bterraform\s+apply\b|\bpulumi\s+up\b/i, kind: "deployed", detail: "Infra (IaC)" },
  { re: /\bdocker\s+push\b/i, kind: "deployed", detail: "Docker registry" },
  { re: /\beas\s+(submit|update)\b/i, kind: "deployed", detail: "Expo" },
  { re: /\b(npm|yarn|pnpm)\s+publish\b/i, kind: "published", detail: "npm" },
  { re: /\bcargo\s+publish\b/i, kind: "published", detail: "crates.io" },
  { re: /\b(gem\s+push|twine\s+upload)\b/i, kind: "published", detail: "package registry" },
  { re: /\bgh\s+release\s+create\b|\bgoreleaser\b/i, kind: "released", detail: "GitHub release" },
  { re: /\bgh\s+pr\s+merge\b/i, kind: "merged", detail: "GitHub PR" },
];

const PROD_BRANCH = /\b(main|master|prod|production|release)\b/;

/** Classify a command as a ship-to-prod action, or null if it isn't one. */
export function classifyShip(command: string): ShipKind | null {
  const c = command.trim();
  for (const p of PLATFORM) {
    if (p.re.test(c)) return { kind: p.kind, detail: p.detail, prod: true };
  }
  if (/\bgit\s+push\b/i.test(c)) {
    const force = /(--force\b|--force-with-lease\b|\s-f\b)/.test(c);
    const toProd = PROD_BRANCH.test(c.replace(/\bgit\s+push\b/i, ""));
    return {
      kind: force ? "force-pushed" : "pushed",
      detail: toProd ? "git → main/prod" : "git remote",
      prod: force || toProd,
    };
  }
  return null;
}

export interface ShipEvent {
  ts: string;
  agent: string;
  repo: string;
  cwd: string;
  command: string;
  kind: ShipKind["kind"];
  detail: string;
  prod: boolean;
  ok: boolean;
  session: string;
  level?: string;    // risk level of the session it came from
  review?: string;   // approved / flagged / pending
  verified?: boolean;
  /** reached prod without ever being approved by a human/autopilot */
  unreviewed: boolean;
}

const base = (p: string) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || p;

/** Every ship-to-prod action in the journal, newest first, joined to its card. */
export function buildShipped(): ShipEvent[] {
  const cardBy = new Map(buildCards().map((c) => [c.session, c]));
  const out: ShipEvent[] = [];
  for (const e of readEvents()) {
    if (e.kind !== "tool") continue;
    const d = e.data as { command?: string; ok?: boolean };
    if (!d?.command) continue;
    const s = classifyShip(String(d.command));
    if (!s) continue;
    const card = cardBy.get(e.session);
    out.push({
      ts: e.ts, agent: e.agent, cwd: e.cwd, repo: base(e.cwd),
      command: String(d.command), kind: s.kind, detail: s.detail, prod: s.prod,
      ok: d.ok !== false, session: e.session,
      level: card?.level, review: card?.review, verified: card?.verified_claims,
      unreviewed: !card || card.review !== "approved",
    });
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
}
