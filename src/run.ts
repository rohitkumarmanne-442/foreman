import { spawn } from "node:child_process";
import { createWatchState, pollOnce, endWatchSession } from "./watch.js";

/**
 * `foreman run [--name codex] -- <agent command...>`
 *
 * The universal CLI adapter: launches ANY terminal agent (Codex, Gemini CLI,
 * Copilot CLI, aider, …) with its TTY untouched, watches the repo while it
 * runs, and closes the review card the moment it exits. No hooks, no
 * integration, no way for the wrapped tool to know it's being observed.
 */
export function runAgent(label: string, command: string[], intervalMs = 1500): void {
  const state = createWatchState(process.cwd(), label);

  console.log(`🧑‍🏭 Foreman is supervising "${command.join(" ")}" as ${label}`);
  console.log(`   Session ${state.session} — the card closes when the command exits.\n`);

  // stdio: "inherit" keeps interactive TUIs (Codex, Gemini) fully functional.
  const child =
    process.platform === "win32"
      ? spawn(
          command
            .map((c) => (/[\s"^&|<>]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
            .join(" "),
          { stdio: "inherit", shell: true }
        )
      : spawn(command[0], command.slice(1), { stdio: "inherit" });

  const timer = setInterval(() => pollOnce(state), intervalMs);

  let closed = false;
  const finish = (code: number) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    pollOnce(state); // catch changes from the final moments
    endWatchSession(state);
    console.log(`\n🧑‍🏭 Session ${state.session} closed — review it:  foreman ui`);
    process.exit(code);
  };

  child.on("exit", (code) => finish(code ?? 0));
  child.on("error", () => finish(127));
  process.on("SIGINT", () => { /* let the child handle Ctrl+C; we exit with it */ });
}
