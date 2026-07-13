import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TASK_LABEL = "Foreman: Open Inbox";

/**
 * One-click Foreman from inside VS Code / Cursor: a task in .vscode/tasks.json.
 * Run it via  Terminal → Run Task → Foreman: Open Inbox  (or Ctrl+Shift+P).
 * `foreman ui` reuses the running server and opens the browser either way.
 */
export function installVsCodeTask(dir: string = process.cwd()): string | null {
  const vsdir = path.join(dir, ".vscode");
  const file = path.join(vsdir, "tasks.json");
  let doc: { version?: string; tasks?: unknown[] } = { version: "2.0.0", tasks: [] };
  if (fs.existsSync(file)) {
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null; // JSONC with comments — never clobber a file we can't parse
    }
  }
  doc.version = doc.version ?? "2.0.0";
  const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
  doc.tasks = tasks.filter((t) => (t as { label?: string })?.label !== TASK_LABEL);
  doc.tasks.push({
    label: TASK_LABEL,
    type: "shell",
    command: "foreman ui",
    presentation: { reveal: "silent", panel: "dedicated", close: true },
    problemMatcher: [],
  });
  fs.mkdirSync(vsdir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8");
  return file;
}

export function uninstallVsCodeTask(dir: string = process.cwd()): boolean {
  const file = path.join(dir, ".vscode", "tasks.json");
  if (!fs.existsSync(file)) return false;
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const before = Array.isArray(doc.tasks) ? doc.tasks.length : 0;
    doc.tasks = (doc.tasks ?? []).filter((t: { label?: string }) => t?.label !== TASK_LABEL);
    if (doc.tasks.length === before) return false;
    if (doc.tasks.length === 0 && Object.keys(doc).every((k) => k === "version" || k === "tasks")) {
      fs.rmSync(file);
    } else {
      fs.writeFileSync(file, JSON.stringify(doc, null, 2), "utf8");
    }
    return true;
  } catch {
    return false;
  }
}

/** OS-level entry points: Start Menu + Desktop (Windows), app launcher (Linux). */
export function createShortcuts(): string[] {
  if (process.platform === "win32") {
    const script = [
      "$ws = New-Object -ComObject WScript.Shell",
      "$targets = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))",
      "foreach ($dir in $targets) {",
      "  $s = $ws.CreateShortcut((Join-Path $dir 'Foreman Inbox.lnk'))",
      "  $s.TargetPath = 'powershell.exe'",
      "  $s.Arguments = '-NoProfile -WindowStyle Hidden -Command foreman ui'",
      "  $s.Description = 'Foreman - the review inbox for your AI workforce'",
      "  $s.Save()",
      "}",
      "Write-Output ($targets -join [Environment]::NewLine)",
    ].join("; ");
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    return out.split(/\r?\n/).filter(Boolean).map((d) => path.join(d, "Foreman Inbox.lnk"));
  }
  if (process.platform === "linux") {
    const dir = path.join(process.env.HOME ?? "~", ".local", "share", "applications");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "foreman-inbox.desktop");
    fs.writeFileSync(
      file,
      "[Desktop Entry]\nName=Foreman Inbox\nComment=The review inbox for your AI workforce\nExec=foreman ui\nType=Application\nTerminal=false\nCategories=Development;\n",
      "utf8"
    );
    return [file];
  }
  return []; // macOS: menu bar via `foreman tray` (xbar/SwiftBar) is the native home
}
