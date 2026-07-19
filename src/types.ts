/** A single journaled event. One JSON object per line in ~/.foreman/events/*.jsonl */
export interface ForemanEvent {
  v: 1;
  id: string;
  ts: string; // ISO 8601
  agent: string; // "claude-code" | "cursor" | "watch" | "mcp-proxy" | run label…
  session: string; // agent session id, or proxy run id
  cwd: string;
  /** teammate name when the event arrived via a team pack import */
  origin?: string;
  kind:
    | "pre_tool" // snapshot before a mutating tool runs (Write)
    | "tool" // a tool the agent executed
    | "session_end" // agent finished its turn/session
    | "mcp_call" // one attested MCP tool call (receipt)
    | "mcp_drift"; // tool list / description changed vs trusted baseline
  data: Record<string, unknown>;
}

export interface PreToolData {
  tool: string;
  file?: string;
  exists?: boolean;
  lines?: number;
  content_sample?: string; // bounded snapshot of the file before a Write
}

export interface ToolData {
  tool: string;
  ok: boolean;
  file?: string;
  lines_after?: number;
  command?: string;
  description?: string;
  content_sample?: string;
  edits?: Array<{ old: string; new: string }>; // Edit / MultiEdit pairs, bounded
}

export interface SessionEndData {
  transcript?: string;
  last_message?: string;
  claims: string[];
}

export interface McpCallData {
  server: string;
  method: string;
  tool?: string;
  params_hash: string;
  result_hash: string;
  ms: number;
  ok: boolean;
  receipt_id: string;
  sig: string; // base64 ed25519 signature over canonical receipt body
  pk: string; // base64 SPKI public key
}

export interface McpDriftData {
  server: string;
  baseline_hash: string;
  current_hash: string;
  added: string[];
  removed: string[];
  changed: string[]; // tools whose description/schema changed
}

export interface Finding {
  rule: string;
  severity: 1 | 2 | 3 | 4; // 1 info, 2 medium, 3 high, 4 critical
  detail: string;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface FileTouch {
  path: string;
  action: "write" | "edit";
  /** when this file was first / most recently touched in the session */
  first_ts?: string;
  last_ts?: string;
  /** how many separate edit events hit this file */
  touches?: number;
  lines_before?: number;
  lines_after?: number;
  /** signed net whole-file line change (esp. for edits, where lines_after may
   *  be unknown because we never saw the full post-edit file) */
  lines_delta?: number;
  edits?: Array<{ old: string; new: string }>; // surgical changes, in order
  before_sample?: string; // full-file rewrite: content before
  after_sample?: string; // full-file rewrite: content after
}

export interface CommandRun {
  command: string;
  ok: boolean;
  verification: boolean; // looks like a test/build/run command
}

export type ReviewStatus = "pending" | "approved" | "flagged";

export interface ReviewCard {
  session: string;
  review: ReviewStatus;
  /** reviewer's note, set when flagging — fed back to the agent via `foreman brief` */
  review_note?: string;
  /** approved automatically by Adaptive Autopilot (trusted agent + low risk) */
  autopilot?: boolean;
  /** teammate name when this card was imported from a team pack */
  origin?: string;
  agent: string;
  cwd: string;
  started: string;
  ended?: string;
  open: boolean; // no session_end seen yet
  /** ts of the newest event folded into this card */
  last_activity: string;
  /** true when the agent kept working after the card was approved — approval no longer covers the new work */
  reopened?: boolean;
  /** the approval watermark: everything up to this ts has been reviewed (set when reopened) */
  reviewed_until?: string;
  /** how many tool events (edits + commands) landed after the watermark */
  new_changes?: number;
  files: FileTouch[];
  commands: CommandRun[];
  claims: string[];
  verified_claims: boolean; // claims backed by at least one passing verification
  findings: Finding[];
  score: number; // 0-100
  level: RiskLevel;
  mcp_calls: number;
  mcp_drifts: number;
  last_message?: string;
}
