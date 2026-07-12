import { appendEvent } from "../journal.js";
import { extractClaims } from "../claims.js";

/**
 * OpenAI Codex CLI adapter via its `notify` setting. In ~/.codex/config.toml:
 *
 *   notify = ["foreman", "hook", "codex"]
 *
 * Codex invokes the program with one JSON argument per event, e.g.
 * {"type":"agent-turn-complete","turn-id":"…","last-assistant-message":"…"}.
 * We journal the agent's final message so claims-vs-evidence works; pair with
 * `foreman run --name codex -- codex` (or `foreman watch`) for file/command
 * coverage.
 */
export async function handleCodexNotify(): Promise<void> {
  try {
    let raw = process.argv[4] ?? "";
    if (!raw) {
      // some versions pipe instead of passing an argument — accept both
      for await (const chunk of process.stdin) {
        if (raw.length < 1024 * 1024) raw += chunk;
      }
    }
    if (!raw.trim()) return;
    const p = JSON.parse(raw);
    const type = String(p.type ?? "");
    if (!type.includes("turn-complete")) return;

    const lastMsg = String(p["last-assistant-message"] ?? p.last_assistant_message ?? "");
    appendEvent({
      agent: "codex",
      session: `codex-${String(p["turn-id"] ?? p.turn_id ?? Date.now())}`,
      cwd: String(p.cwd ?? process.cwd()),
      kind: "session_end",
      data: {
        transcript: "",
        last_message: lastMsg.slice(0, 4000),
        claims: extractClaims(lastMsg),
      },
    });
  } catch {
    // notify handlers must never disturb the agent
  }
}
