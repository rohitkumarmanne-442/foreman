import { readEvents } from "./journal.js";
import { verifyReceipt, receiptHash, readChainHead, type ReceiptBody } from "./mcp/receipts.js";
import type { McpCallData } from "./types.js";

export interface VerifyResult {
  total: number;
  sig_valid: number;
  sig_broken: string[]; // receipt ids
  chained: number;
  chain_breaks: Array<{ receipt_id: string; reason: string }>;
  head_matches: boolean | null; // null when nothing is chained
}

export function toReceiptBody(d: Record<string, unknown>): ReceiptBody {
  const body: ReceiptBody = {
    receipt_id: String(d.receipt_id),
    ts: String(d.ts),
    server: String(d.server),
    method: String(d.method),
    params_hash: String(d.params_hash),
    result_hash: String(d.result_hash),
    ms: Number(d.ms),
    ok: Boolean(d.ok),
  };
  if (d.tool !== undefined) body.tool = String(d.tool);
  if (d.prev !== undefined) body.prev = String(d.prev);
  return body;
}

/** Verify every receipt: ed25519 signatures on all, plus chain continuity on
 * chained receipts (those carrying `prev`). Detects edits (signature), and
 * deletion/reordering/insertion of history (chain). */
export function verifyAll(): VerifyResult {
  const calls = readEvents().filter((e) => e.kind === "mcp_call");
  const result: VerifyResult = {
    total: calls.length,
    sig_valid: 0,
    sig_broken: [],
    chained: 0,
    chain_breaks: [],
    head_matches: null,
  };

  let running: string | null = null; // chain hash of the previous chained receipt
  for (const e of calls) {
    const d = e.data as unknown as McpCallData & { prev?: string };
    const body = toReceiptBody(e.data);
    const sigOk = verifyReceipt(body, d.sig, d.pk);
    if (sigOk) result.sig_valid++;
    else result.sig_broken.push(body.receipt_id);

    if (body.prev === undefined) continue; // legacy / demo receipt — not chained
    result.chained++;
    if (running === null) {
      // first chained receipt in the journal — its prev may point at history
      // that was rotated away; accept it as the chain's starting point
      running = receiptHash(body, d.sig);
      continue;
    }
    if (body.prev !== running) {
      result.chain_breaks.push({
        receipt_id: body.receipt_id,
        reason: "prev does not match the preceding receipt — history was altered, reordered, or partially deleted",
      });
      // resynchronize so one break doesn't cascade into false positives
    }
    running = receiptHash(body, d.sig);
  }

  if (result.chained > 0) {
    const head = readChainHead();
    result.head_matches = running === head || head === "";
  }
  return result;
}
