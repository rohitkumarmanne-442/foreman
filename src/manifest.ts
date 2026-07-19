import { buildCards } from "./cards.js";
import { buildShipped } from "./ship.js";
import { readEvents } from "./journal.js";
import { loadReviews } from "./reviews.js";
import {
  canonical,
  sha256,
  signPayload,
  verifyPayload,
  keyFingerprint,
  readChainHead,
} from "./mcp/receipts.js";
import type { McpCallData } from "./types.js";

/**
 * Signed provenance manifest — a portable, tamper-evident record of exactly
 * what an agent session did, signed with the same ed25519 key that signs MCP
 * receipts. Attach `foreman.manifest.json` to a PR or a GitHub release and
 * anyone can run `foreman verify-manifest` to prove, offline:
 *   • which agent did the work, in which repo, over what span;
 *   • every file it touched (with exact line deltas) and command it ran;
 *   • whether the claims were verified and whether a human/autopilot approved it;
 *   • what it shipped to prod;
 *   • the attested MCP receipt chain head at the time.
 *
 * Nothing here is trusted to the client: the payload is rebuilt from the local
 * journal server-side, hashed, and signed. Change one byte of the payload and
 * both the content hash and the signature stop matching. Zero LLM, zero network.
 */

const MANIFEST_VERSION = "1" as const;

export interface ManifestFile {
  path: string;
  action: "write" | "edit";
  touches: number;
  lines_before?: number;
  lines_after?: number;
  lines_delta?: number;
}

export interface ManifestShip {
  kind: string;
  detail: string;
  prod: boolean;
  command: string;
  ok: boolean;
  ts: string;
}

export interface ManifestReceipt {
  receipt_id: string;
  ts: string;
  server: string;
  tool?: string;
  ok: boolean;
  ms: number;
  params_hash: string;
  result_hash: string;
  prev?: string;
}

export interface ManifestPayload {
  generated_at: string;
  session: string;
  agent: string;
  origin?: string;
  repo: string;
  cwd: string;
  span: { started: string; ended?: string; last_activity: string };
  risk: { level: string; score: number };
  review: {
    status: string;
    decided_by: "human" | "autopilot" | "none";
    at?: string;
    note?: string;
    reopened?: boolean;
  };
  verification: {
    claims_verified: boolean;
    commands_run: number;
    verification_commands: number;
    verification_passing: number;
  };
  files: ManifestFile[];
  commands: Array<{ command: string; ok: boolean; verification: boolean }>;
  claims: string[];
  findings: Array<{ rule: string; severity: number; detail: string }>;
  shipped: ManifestShip[];
  mcp: {
    calls: number;
    drifts: number;
    chain_head: string;
    receipts: ManifestReceipt[];
  };
}

export interface ProvenanceManifest {
  foreman_manifest: typeof MANIFEST_VERSION;
  payload: ManifestPayload;
  /** sha256 of the canonical payload — a human-checkable digest of what was signed */
  content_hash: string;
  signature: {
    alg: "ed25519";
    sig: string; // base64 signature over the canonical payload
    pk: string; // base64 SPKI public key
    key_fingerprint: string; // ed25519:<16 hex>
  };
}

const base = (p: string) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || p;

/** Build and sign a provenance manifest for one session. Throws if unknown. */
export function buildManifest(session: string): ProvenanceManifest {
  const card = buildCards().find((c) => c.session === session);
  if (!card) throw new Error(`No session "${session}" — run \`foreman status\` to list sessions.`);

  const r = loadReviews()[session];
  const verifs = card.commands.filter((c) => c.verification);

  const shipped: ManifestShip[] = buildShipped()
    .filter((s) => s.session === session)
    .map((s) => ({ kind: s.kind, detail: s.detail, prod: s.prod, command: s.command, ok: s.ok, ts: s.ts }));

  const receipts: ManifestReceipt[] = readEvents()
    .filter((e) => e.kind === "mcp_call" && e.session === session)
    .map((e) => {
      const d = e.data as unknown as McpCallData & { receipt_id: string; prev?: string };
      return {
        receipt_id: d.receipt_id,
        ts: e.ts,
        server: d.server,
        ...(d.tool ? { tool: d.tool } : {}),
        ok: d.ok,
        ms: d.ms,
        params_hash: d.params_hash,
        result_hash: d.result_hash,
        ...(d.prev ? { prev: d.prev } : {}),
      };
    });

  const payload: ManifestPayload = {
    generated_at: new Date().toISOString(),
    session: card.session,
    agent: card.agent,
    ...(card.origin ? { origin: card.origin } : {}),
    repo: base(card.cwd),
    cwd: card.cwd,
    span: {
      started: card.started,
      ...(card.ended ? { ended: card.ended } : {}),
      last_activity: card.last_activity,
    },
    risk: { level: card.level, score: card.score },
    review: {
      status: card.review,
      decided_by: r?.autopilot ? "autopilot" : r ? "human" : "none",
      ...(r?.ts ? { at: r.ts } : {}),
      ...(r?.note ? { note: r.note } : {}),
      ...(card.reopened ? { reopened: true } : {}),
    },
    verification: {
      claims_verified: card.verified_claims,
      commands_run: card.commands.length,
      verification_commands: verifs.length,
      verification_passing: verifs.filter((c) => c.ok).length,
    },
    files: card.files.map((f) => ({
      path: f.path,
      action: f.action,
      touches: f.touches ?? 1,
      ...(f.lines_before !== undefined ? { lines_before: f.lines_before } : {}),
      ...(f.lines_after !== undefined ? { lines_after: f.lines_after } : {}),
      ...(f.lines_delta !== undefined ? { lines_delta: f.lines_delta } : {}),
    })),
    commands: card.commands.map((c) => ({ command: c.command, ok: c.ok, verification: c.verification })),
    claims: card.claims,
    findings: card.findings.map((f) => ({ rule: f.rule, severity: f.severity, detail: f.detail })),
    shipped,
    mcp: {
      calls: card.mcp_calls,
      drifts: card.mcp_drifts,
      chain_head: readChainHead(),
      receipts,
    },
  };

  const content_hash = sha256(canonical(payload));
  const { sig, pk } = signPayload(payload);
  return {
    foreman_manifest: MANIFEST_VERSION,
    payload,
    content_hash,
    signature: { alg: "ed25519", sig, pk, key_fingerprint: keyFingerprint(pk) },
  };
}

export interface ManifestCheck {
  ok: boolean;
  signature_valid: boolean;
  content_hash_valid: boolean;
  fingerprint_valid: boolean;
  key_fingerprint: string;
  reasons: string[];
}

/** Verify a manifest offline: content hash, ed25519 signature, key fingerprint. */
export function verifyManifest(m: unknown): ManifestCheck {
  const fail = (reason: string): ManifestCheck => ({
    ok: false,
    signature_valid: false,
    content_hash_valid: false,
    fingerprint_valid: false,
    key_fingerprint: "",
    reasons: [reason],
  });

  const man = m as ProvenanceManifest;
  if (!man || typeof man !== "object") return fail("Not a JSON object.");
  if (man.foreman_manifest !== MANIFEST_VERSION) return fail("Not a Foreman manifest (or unsupported version).");
  if (!man.payload || !man.signature?.sig || !man.signature?.pk) return fail("Manifest is missing its payload or signature.");

  const reasons: string[] = [];
  const content_hash_valid = man.content_hash === sha256(canonical(man.payload));
  if (!content_hash_valid) reasons.push("content_hash does not match the payload — the payload was altered after signing.");

  const signature_valid = verifyPayload(man.payload, man.signature.sig, man.signature.pk);
  if (!signature_valid) reasons.push("ed25519 signature is invalid — tampered, or signed by a different key.");

  const fingerprint_valid = man.signature.key_fingerprint === keyFingerprint(man.signature.pk);
  if (!fingerprint_valid) reasons.push("key_fingerprint does not match the embedded public key.");

  return {
    ok: content_hash_valid && signature_valid && fingerprint_valid,
    signature_valid,
    content_hash_valid,
    fingerprint_valid,
    key_fingerprint: keyFingerprint(man.signature.pk),
    reasons,
  };
}
