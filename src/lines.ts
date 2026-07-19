import type { FileTouch } from "./types.js";

/**
 * Net whole-file line change from a set of Edit / MultiEdit old→new pairs.
 *
 * When an agent replaces a substring, the file's total line count changes by
 * exactly (newlines in `new` − newlines in `old`). Summing that over every
 * edit gives the EXACT whole-file line delta — even though the replaced
 * strings are arbitrary substrings, not whole lines. Empty strings (new-file
 * MultiEdit, full deletions) count as zero lines.
 */
export function editLineDelta(edits: Array<{ old: string; new: string }>): number {
  let net = 0;
  for (const e of edits) {
    const before = e.old ? e.old.split("\n").length : 0;
    const after = e.new ? e.new.split("\n").length : 0;
    net += after - before;
  }
  return net;
}

/**
 * Fill `lines_delta` (and `lines_after`, when we know `lines_before`) for an
 * edit touch so the UI always has a clear before→after and never renders a
 * blank "— → —". Writes already carry exact counts from the hook, so they are
 * left untouched.
 */
export function fillEditLineCounts(t: FileTouch): void {
  if (t.action !== "edit" || !t.edits?.length) return;
  const net = editLineDelta(t.edits);
  t.lines_delta = net;
  if (t.lines_after === undefined && t.lines_before !== undefined) {
    t.lines_after = Math.max(0, t.lines_before + net);
  }
}

/** Plain-text "before → after" line count for markdown / CLI output. Never blank. */
export function lineCountText(f: FileTouch): string {
  if (f.lines_before !== undefined && f.lines_after !== undefined) {
    const d = f.lines_after - f.lines_before;
    return `${f.lines_before} → ${f.lines_after}${d ? ` (${d > 0 ? "+" : ""}${d})` : ""}`;
  }
  if (f.lines_after !== undefined) return `new → ${f.lines_after}`;
  if (f.lines_delta !== undefined && f.lines_delta !== 0)
    return `${f.lines_delta > 0 ? "+" : ""}${f.lines_delta} lines`;
  if (f.lines_before !== undefined) return `${f.lines_before}, edited`;
  return "edited";
}
