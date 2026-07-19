import type { ReviewCard } from "./types.js";
import { setAutoApproved } from "./reviews.js";
import { loadConfig } from "./config.js";

/**
 * Adaptive Autopilot — the review burden shrinks as agents earn trust.
 *
 * Foreman watches each agent's track record (verified-claims rate, risk level,
 * whether it's ever been flagged). Once an agent clears the bar, Foreman
 * auto-approves its LOW-risk finished sessions so you only spend attention on
 * the risky ones. Opt-in, transparent (every auto-approval is marked and
 * reversible), and it never overrides a human decision or a still-running or
 * non-low-risk session.
 */

export interface AgentTrust {
  agent: string;
  sessions: number;
  approved: number;
  flagged: number;
  claimed: number;
  verified: number;
  verifiedPct: number;
  avgRisk: number;
  criticalCount: number;
  eligible: boolean;
}

type AutopilotCfg = { enabled: boolean; min_sessions: number; min_verified_pct: number };

export function computeAgentTrust(cards: ReviewCard[], cfg?: AutopilotCfg): Map<string, AgentTrust> {
  const minSessions = cfg?.min_sessions ?? 5;
  const minVerified = cfg?.min_verified_pct ?? 80;
  const by = new Map<string, AgentTrust>();
  for (const c of cards) {
    const a = c.agent || "unknown";
    let t = by.get(a);
    if (!t) { t = { agent: a, sessions: 0, approved: 0, flagged: 0, claimed: 0, verified: 0, verifiedPct: 0, avgRisk: 0, criticalCount: 0, eligible: false }; by.set(a, t); }
    t.sessions++;
    t.avgRisk += c.score || 0;
    if (c.level === "critical") t.criticalCount++;
    if (c.review === "approved") t.approved++;
    if (c.review === "flagged") t.flagged++;
    if (c.claims && c.claims.length) { t.claimed++; if (c.verified_claims) t.verified++; }
  }
  for (const t of by.values()) {
    t.avgRisk = t.sessions ? Math.round(t.avgRisk / t.sessions) : 0;
    // no claims made → nothing was left unproven
    t.verifiedPct = t.claimed ? Math.round((t.verified / t.claimed) * 100) : 100;
    t.eligible = t.sessions >= minSessions && t.verifiedPct >= minVerified && t.criticalCount === 0 && t.flagged === 0;
  }
  return by;
}

/**
 * One Autopilot pass. Auto-approves pending, finished, LOW-risk sessions from
 * trusted agents. Returns the sessions it approved. No-op unless enabled.
 */
export function runAutopilot(cards: ReviewCard[], cfg = loadConfig().autopilot): string[] {
  if (!cfg?.enabled) return [];
  const trust = computeAgentTrust(cards, cfg);
  const approved: string[] = [];
  for (const c of cards) {
    if (c.review !== "pending") continue;
    if (c.open) continue;            // still running — let it finish
    if (c.level !== "low") continue; // only the demonstrably safe ones
    const t = trust.get(c.agent || "unknown");
    if (!t?.eligible) continue;
    if (setAutoApproved(c.session)) approved.push(c.session);
  }
  return approved;
}
