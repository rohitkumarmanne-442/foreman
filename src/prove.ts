import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";

/**
 * "Prove it" — turn claims-vs-evidence from detection into resolution.
 *
 * When an agent claims success but ran no verification, Foreman runs the
 * repo's OWN test/build command and staples the real result to the card.
 * Deterministic: the command comes from the project's config (package.json,
 * Makefile, pytest, cargo, go) — never from an LLM, never from the client.
 */

export interface VerifyCommand {
  command: string;
  source: string;
}

/** Pick the repo's canonical verification command, or null if none is obvious. */
export function detectVerifyCommand(repo: string): VerifyCommand | null {
  const has = (f: string) => fs.existsSync(path.join(repo, f));

  const pkgPath = path.join(repo, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const s = pkg.scripts ?? {};
      if (s.test && !/no test specified/i.test(s.test)) return { command: "npm test", source: "package.json → test" };
      if (s.build) return { command: "npm run build", source: "package.json → build" };
      if (s.lint) return { command: "npm run lint", source: "package.json → lint" };
      if (s.typecheck) return { command: "npm run typecheck", source: "package.json → typecheck" };
    } catch { /* malformed package.json */ }
  }

  const mk = path.join(repo, "Makefile");
  if (fs.existsSync(mk)) {
    try { if (/^test:/m.test(fs.readFileSync(mk, "utf8"))) return { command: "make test", source: "Makefile → test" }; } catch { /* */ }
  }

  if (has("pytest.ini") || has("pyproject.toml") || has("setup.py") || has("tox.ini")) {
    if (has("tests") || has("test") || hasFileMatching(repo, /^test_.*\.py$|_test\.py$/)) {
      return { command: "python -m pytest -q", source: "python project" };
    }
  }
  if (has("Cargo.toml")) return { command: "cargo test", source: "Cargo.toml" };
  if (has("go.mod")) return { command: "go test ./...", source: "go.mod" };
  return null;
}

function hasFileMatching(dir: string, re: RegExp): boolean {
  try { return fs.readdirSync(dir).some((f) => re.test(f)); } catch { return false; }
}

export interface ProveResult {
  ok: boolean;
  code: number;
  output: string;
  ms: number;
  command: string;
  source: string;
}

/** Run the detected command in the repo and capture the outcome. */
export function runProve(repo: string, vc: VerifyCommand, timeoutMs = 180_000): ProveResult {
  const t0 = Date.now();
  const r = spawnSync(vc.command, {
    cwd: repo,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const output = ((r.stdout ?? "") + (r.stderr ?? "")).trim().slice(-8000);
  return {
    ok: r.status === 0,
    code: r.status ?? -1,
    output,
    ms: Date.now() - t0,
    command: vc.command,
    source: vc.source,
  };
}

/** Async variant for the server — doesn't block the event loop / UI refresh. */
export function runProveAsync(repo: string, vc: VerifyCommand, timeoutMs = 180_000): Promise<ProveResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = "";
    const cap = (d: Buffer) => { out += d.toString(); if (out.length > 2_000_000) out = out.slice(-1_000_000); };
    let child;
    try {
      child = spawn(vc.command, { cwd: repo, shell: true, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: -1, output: String(e), ms: Date.now() - t0, command: vc.command, source: vc.source });
      return;
    }
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* */ } }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, output: out.trim().slice(-8000), ms: Date.now() - t0, command: vc.command, source: vc.source });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: String(e), ms: Date.now() - t0, command: vc.command, source: vc.source });
    });
  });
}
