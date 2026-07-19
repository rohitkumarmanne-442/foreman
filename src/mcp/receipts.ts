import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { KEYS_DIR, ensureDirs } from "../paths.js";

const PRIV = () => path.join(KEYS_DIR(), "ed25519-private.pem");
const PUB = () => path.join(KEYS_DIR(), "ed25519-public.pem");

export function loadOrCreateKeys(): { privateKey: crypto.KeyObject; publicKeyB64: string } {
  ensureDirs();
  if (!fs.existsSync(PRIV())) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(PRIV(), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(PUB(), publicKey.export({ type: "spki", format: "pem" }));
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIV(), "utf8"));
  const publicKey = crypto.createPublicKey(privateKey);
  const publicKeyB64 = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  return { privateKey, publicKeyB64 };
}

export function sha256(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

/** Stable stringify — sorted keys so hashes/signatures are canonical. */
export function canonical(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export interface ReceiptBody {
  receipt_id: string;
  ts: string;
  server: string;
  method: string;
  tool?: string;
  params_hash: string;
  result_hash: string;
  ms: number;
  ok: boolean;
  /** hash of the previous chained receipt — links receipts into a
   * tamper-evident chain (absent on legacy/demo receipts) */
  prev?: string;
}

/** Sign any JSON-serialisable payload with the local ed25519 key (canonical form). */
export function signPayload(payload: unknown): { sig: string; pk: string } {
  const { privateKey, publicKeyB64 } = loadOrCreateKeys();
  const sig = crypto.sign(null, Buffer.from(canonical(payload), "utf8"), privateKey).toString("base64");
  return { sig, pk: publicKeyB64 };
}

/** Verify an ed25519 signature over any canonical payload against an SPKI-DER public key. */
export function verifyPayload(payload: unknown, sigB64: string, pkB64: string): boolean {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(pkB64, "base64"),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(canonical(payload), "utf8"),
      publicKey,
      Buffer.from(sigB64, "base64")
    );
  } catch {
    return false;
  }
}

/** A short, stable identity for a public key — shown as "signed by ed25519:…". */
export function keyFingerprint(pkB64: string): string {
  return "ed25519:" + sha256(pkB64).slice(0, 16);
}

export function signReceipt(body: ReceiptBody): { sig: string; pk: string } {
  return signPayload(body);
}

/** The chain hash of a signed receipt: covers body AND signature. */
export function receiptHash(body: ReceiptBody, sig: string): string {
  return sha256(canonical(body) + "|" + sig);
}

const CHAIN_FILE = () => path.join(KEYS_DIR(), "..", "chain.json");
const CHAIN_LOCK = () => path.join(KEYS_DIR(), "..", "chain.lock");

/** Take an exclusive lock, run fn with the current chain head, persist the new
 * head fn returns. Concurrent proxies serialize here so the chain never forks. */
export function withChain<T>(fn: (head: string) => { result: T; newHead: string }): T {
  ensureDirs();
  const deadline = Date.now() + 2000;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = fs.openSync(CHAIN_LOCK(), "wx");
      break;
    } catch {
      if (Date.now() > deadline) {
        // stale lock (crashed process) — steal it rather than dropping receipts
        try { fs.rmSync(CHAIN_LOCK(), { force: true }); } catch { /* raced */ }
      }
      const t = Date.now();
      while (Date.now() - t < 20) { /* brief spin before retry */ }
    }
  }
  try {
    let head = "";
    try {
      head = JSON.parse(fs.readFileSync(CHAIN_FILE(), "utf8")).head ?? "";
    } catch {
      head = "";
    }
    const { result, newHead } = fn(head);
    fs.writeFileSync(CHAIN_FILE(), JSON.stringify({ head: newHead, updated: new Date().toISOString() }), "utf8");
    return result;
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try { fs.rmSync(CHAIN_LOCK(), { force: true }); } catch { /* already gone */ }
  }
}

export function readChainHead(): string {
  try {
    return JSON.parse(fs.readFileSync(CHAIN_FILE(), "utf8")).head ?? "";
  } catch {
    return "";
  }
}

export function verifyReceipt(body: ReceiptBody, sigB64: string, pkB64: string): boolean {
  return verifyPayload(body, sigB64, pkB64);
}
