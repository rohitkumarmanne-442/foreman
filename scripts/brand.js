#!/usr/bin/env node
/**
 * Brand compositor — puts the thought-cloud text onto the Foreman mascot art.
 *
 *   1. Save the original art (no cloud text) as:
 *        assets/brand/logo-raw.png    (portrait mascot)
 *        assets/brand/banner-raw.png  (wide banner)
 *   2. node scripts/brand.js
 *   3. Branded files land at assets/brand/logo.png and assets/brand/banner.png
 *
 * Zero dependencies: PNG dimensions are read from the file header and the
 * composition is rendered by headless Chromium (Playwright's, Chrome, or Edge
 * — first one found; override with the CHROME env var).
 *
 * `node scripts/brand.js --self-test` proves the pipeline without the art:
 * it draws placeholder rawcards with an empty cloud, composes them, and
 * checks the output.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BRAND = path.join(ROOT, "assets", "brand");

/** What the mascot is thinking. Short enough to read at thumbnail size. */
const CLOUD_TEXT = "Prove it.";

/** Per-image placement of the cloud text (fractions of image size). */
const LAYOUT = {
  "logo-raw.png": {
    out: "logo.png",
    left: 0.825, top: 0.265, width: 0.24, rotate: -5, fontFrac: 0.052,
  },
  "banner-raw.png": {
    out: "banner.png",
    left: 0.862, top: 0.235, width: 0.17, rotate: -3, fontFrac: 0.026,
  },
};

function pngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(12) !== 0x49484452) throw new Error(`${file} is not a PNG`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function findChromium() {
  const candidates = [
    process.env.CHROME,
    "C:\\Users\\Dell\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/chromium", "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("No Chromium/Chrome/Edge found — set the CHROME env var to a browser executable.");
}

function screenshot(html, w, h, out) {
  const tmp = path.join(os.tmpdir(), `foreman-brand-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tmp, html, "utf8");
  execFileSync(findChromium(), [
    "--headless=old", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
    `--window-size=${w},${h}`, "--default-background-color=00000000",
    `--screenshot=${out}`, `file:///${tmp.replace(/\\/g, "/")}`,
  ], { stdio: "pipe", windowsHide: true });
  fs.rmSync(tmp, { force: true });
}

function composeHtml(imgPath, w, h, layout) {
  const fontPx = Math.round(w * layout.fontFrac);
  return `<!doctype html><html><head><style>
  *{margin:0;padding:0}
  body{width:${w}px;height:${h}px;overflow:hidden}
  img{position:absolute;inset:0;width:${w}px;height:${h}px}
  .cloud-text{
    position:absolute;
    left:${(layout.left * 100).toFixed(2)}%;
    top:${(layout.top * 100).toFixed(2)}%;
    width:${(layout.width * 100).toFixed(2)}%;
    transform:translate(-50%,-50%) rotate(${layout.rotate}deg);
    font:900 ${fontPx}px/1.05 "Segoe UI","Arial Rounded MT Bold",Arial,sans-serif;
    letter-spacing:-.02em;
    color:#1b2030;
    text-align:center;
    -webkit-text-stroke:${Math.max(1, Math.round(fontPx / 28))}px #1b2030;
  }
  </style></head><body>
    <img src="file:///${imgPath.replace(/\\/g, "/")}">
    <div class="cloud-text">${CLOUD_TEXT}</div>
  </body></html>`;
}

function compose(rawName) {
  const layout = LAYOUT[rawName];
  const raw = path.join(BRAND, rawName);
  if (!fs.existsSync(raw)) return false;
  const { w, h } = pngSize(raw);
  const out = path.join(BRAND, layout.out);
  screenshot(composeHtml(raw, w, h, layout), w, h, out);
  console.log(`✅ ${layout.out}  (${w}x${h}, "${CLOUD_TEXT}" at ${Math.round(layout.left * 100)}%,${Math.round(layout.top * 100)}%)`);
  return true;
}

function selfTest() {
  fs.mkdirSync(BRAND, { recursive: true });
  // draw stand-in art: light page with an empty cloud where the real art has one
  const stand = (w, h, cx, cy, rw) => `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;background:#f4f2ec">
    <div style="position:absolute;left:${cx * 100}%;top:${cy * 100}%;width:${rw * 100}%;aspect-ratio:1.6;transform:translate(-50%,-50%);background:#fff;border:6px solid #111;border-radius:50%"></div>
  </body></html>`;
  screenshot(stand(743, 1000, LAYOUT["logo-raw.png"].left, LAYOUT["logo-raw.png"].top, 0.3), 743, 1000, path.join(BRAND, "logo-raw.png"));
  screenshot(stand(1024, 336, LAYOUT["banner-raw.png"].left, LAYOUT["banner-raw.png"].top, 0.22), 1024, 336, path.join(BRAND, "banner-raw.png"));
  compose("logo-raw.png");
  compose("banner-raw.png");
  console.log("Self-test rendered placeholder art + composed text. Inspect assets/brand/*.png, then replace the *-raw.png files with the real mascot art and rerun.");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  fs.mkdirSync(BRAND, { recursive: true });
  const done = Object.keys(LAYOUT).map(compose).filter(Boolean).length;
  if (!done) {
    console.error(`No source art found. Save the mascot images as:`);
    console.error(`  ${path.join(BRAND, "logo-raw.png")}   (portrait)`);
    console.error(`  ${path.join(BRAND, "banner-raw.png")} (wide banner)`);
    console.error(`then rerun: node scripts/brand.js`);
    process.exit(1);
  }
}
