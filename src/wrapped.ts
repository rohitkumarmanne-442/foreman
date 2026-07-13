import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { buildCards } from "./cards.js";

/** Locate a headless-capable browser the user already has. */
export function findChrome(): string | null {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function mascotDataUri(): string {
  try {
    const here = decodeURIComponent(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const png = fs.readFileSync(path.join(path.dirname(path.dirname(here)), "ui", "mascot.png"));
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch { return ""; }
}

export interface WrappedStats {
  days: number | null;
  sessions: number; files: number; commands: number;
  claims: number; verified_pct: number | null;
  critical: number; findings: number; top_rule: string | null;
  busiest: string | null; agents: number;
}

export function wrappedStats(days?: number): WrappedStats {
  let cards = buildCards().filter((c) => !c.session.startsWith("demo-"));
  if (days) { const cut = Date.now() - days * 86400000; cards = cards.filter((c) => new Date(c.started).getTime() >= cut); }
  const claimed = cards.filter((c) => c.claims.length);
  const ruleCnt: Record<string, number> = {};
  for (const c of cards) for (const f of c.findings) ruleCnt[f.rule] = (ruleCnt[f.rule] || 0) + 1;
  const top = Object.entries(ruleCnt).sort((a, b) => b[1] - a[1])[0];
  const repoCnt: Record<string, number> = {};
  for (const c of cards) { const r = c.cwd.split(/[\\/]/).pop() || c.cwd; repoCnt[r] = (repoCnt[r] || 0) + 1; }
  const busiest = Object.entries(repoCnt).sort((a, b) => b[1] - a[1])[0];
  return {
    days: days ?? null,
    sessions: cards.length,
    files: cards.reduce((n, c) => n + c.files.length, 0),
    commands: cards.reduce((n, c) => n + c.commands.length, 0),
    claims: claimed.length,
    verified_pct: claimed.length ? Math.round((claimed.filter((c) => c.verified_claims).length / claimed.length) * 100) : null,
    critical: cards.filter((c) => c.level === "critical").length,
    findings: cards.reduce((n, c) => n + c.findings.length, 0),
    top_rule: top ? top[0] : null,
    busiest: busiest ? busiest[0] : null,
    agents: new Set(cards.map((c) => c.agent)).size,
  };
}

export function wrappedHtml(s: WrappedStats): string {
  const stat = (v: string | number, l: string, color = "#ecf0f8") =>
    `<div class="s"><b style="color:${color}">${v}</b><span>${l}</span></div>`;
  return `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="card" style="width:1200px;height:630px;position:relative;overflow:hidden;background:#070a12;font-family:'Segoe UI Variable Display','Segoe UI',system-ui,sans-serif;color:#ecf0f8;display:flex;flex-direction:column;padding:52px 60px;box-sizing:border-box">
  <style>
    #card::before{content:'';position:absolute;inset:0;background:radial-gradient(700px 400px at 12% -10%,rgba(106,149,255,.16),transparent 60%),radial-gradient(560px 360px at 92% -14%,rgba(143,123,255,.12),transparent 60%)}
    .s{display:flex;flex-direction:column;background:linear-gradient(180deg,#141a2b,#0f1421);border:1px solid #1d2537;border-radius:18px;padding:22px 28px;min-width:190px;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
    .s b{font-size:46px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.1}
    .s span{font-size:13px;color:#8d96ae;text-transform:uppercase;letter-spacing:.12em;margin-top:6px}
  </style>
  <div style="display:flex;align-items:center;gap:16px;z-index:1">
    <div style="font-weight:800;font-size:26px;letter-spacing:.14em">FORE<span style="color:#6a95ff">MAN</span></div>
    <div style="color:#5d6579;font-size:17px">· my AI workforce${s.days ? `, last ${s.days} days` : ""}</div>
  </div>
  <div style="display:flex;gap:18px;margin-top:40px;z-index:1">
    ${stat(s.sessions, "agent sessions")}
    ${stat(s.files, "files touched")}
    ${stat(s.commands, "commands run")}
    ${stat(s.verified_pct === null ? "—" : s.verified_pct + "%", "claims proven", s.verified_pct !== null && s.verified_pct < 60 ? "#ffa14a" : "#3fe0a0")}
  </div>
  <div style="display:flex;gap:18px;margin-top:18px;z-index:1">
    ${stat(s.findings, "findings caught", "#ffa14a")}
    ${stat(s.critical, "near-misses (critical)", s.critical ? "#ff5468" : "#3fe0a0")}
    ${s.top_rule ? stat(s.top_rule.replace(/_/g, " "), "most-caught risk", "#ecf0f8") : ""}
  </div>
  <div style="margin-top:auto;display:flex;align-items:flex-end;z-index:1">
    <div>
      <div style="font-size:30px;font-weight:800">Your agents say “done.” <span style="color:#6a95ff">Foreman says “prove it.”</span></div>
      <div style="color:#5d6579;font-size:16px;margin-top:8px;font-family:Consolas,monospace">npm i -g foremanjs · github.com/rohitkumarmanne-442/Foreman</div>
    </div>
    <img src="${mascotDataUri()}" style="width:172px;margin-left:auto;border-radius:16px;border:1px solid #2b3654;box-shadow:0 20px 50px rgba(0,0,0,.5)">
  </div>
</div></body>`;
}

/** Render the card. PNG when a system Chrome/Edge exists, else HTML + browser. */
export function renderWrapped(days?: number, out?: string): { file: string; png: boolean } {
  const stats = wrappedStats(days);
  const html = wrappedHtml(stats);
  const htmlPath = path.resolve(out ? out.replace(/\.png$/i, ".html") : "foreman-wrapped.html");
  fs.writeFileSync(htmlPath, html, "utf8");
  const chrome = findChrome();
  if (chrome) {
    const pngPath = path.resolve(out ?? "foreman-wrapped.png");
    execFileSync(chrome, [
      "--headless=old", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      "--window-size=1200,630", `--screenshot=${pngPath}`, "file:///" + htmlPath.replace(/\\/g, "/"),
    ], { stdio: "ignore", windowsHide: true, timeout: 30000 });
    if (fs.existsSync(pngPath)) return { file: pngPath, png: true };
  }
  try {
    const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", htmlPath]] : process.platform === "darwin" ? ["open", [htmlPath]] : ["xdg-open", [htmlPath]];
    spawn(opener[0] as string, opener[1] as string[], { stdio: "ignore", detached: true }).unref();
  } catch { /* headless env */ }
  return { file: htmlPath, png: false };
}

export const BADGE_MD = `[![AI code human-reviewed with Foreman](https://img.shields.io/badge/AI%20code-human--reviewed%20with%20Foreman-6a95ff?labelColor=0b0e14)](https://github.com/rohitkumarmanne-442/Foreman)`;
