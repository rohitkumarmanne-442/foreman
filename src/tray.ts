import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FOREMAN_HOME, ensureDirs } from "./paths.js";
import { startServer } from "./server.js";

/**
 * `foreman tray` — the inbox in your system tray (Windows).
 *
 * Zero dependencies: a WinForms NotifyIcon driven by PowerShell. Left-click or
 * "Open inbox" opens the UI; the tooltip live-counts sessions needing review;
 * a balloon pops when a NEW critical card appears. Exiting the tray stops the
 * bundled server. macOS/Linux: `foreman ui` remains the way in for now.
 */
export function runTray(port: number, iconPng?: string): void {
  if (process.platform !== "win32") {
    console.error("foreman tray is Windows-only for now — use `foreman ui` (menu-bar builds are on the roadmap).");
    process.exit(1);
  }
  ensureDirs();
  startServer(port);
  console.log(`🧑‍🏭 Foreman tray running — inbox on http://127.0.0.1:${port} (Exit via the tray menu)`);

  const script = buildTrayScript(port, iconPng);
  const scriptPath = path.join(FOREMAN_HOME, "tray.ps1");
  fs.writeFileSync(scriptPath, script, "utf8");

  const child = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath],
    { stdio: "ignore", windowsHide: true }
  );
  // The tray owns the lifetime: menu Exit → PowerShell exits → server stops.
  child.on("exit", () => process.exit(0));
  child.on("error", () => {
    console.error("Could not start the tray (PowerShell unavailable?) — server keeps running; open the inbox manually.");
  });
}

function buildTrayScript(port: number, iconPng?: string): string {
  const iconLine = iconPng
    ? `$bmp = New-Object System.Drawing.Bitmap "${iconPng.replace(/\\/g, "\\\\")}"; $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())`
    : `$icon = [System.Drawing.SystemIcons]::Information`;
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "SilentlyContinue"
$url = "http://127.0.0.1:${port}"
${iconLine}

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = "Foreman - starting..."
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add("Open inbox")
$open.add_Click({ Start-Process $url })
$menu.Items.Add("-") | Out-Null
$exit = $menu.Items.Add("Exit Foreman")
$exit.add_Click({ $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() })
$ni.ContextMenuStrip = $menu
$ni.add_MouseClick({ if ($_.Button -eq "Left") { Start-Process $url } })

$script:seen = @{}
$script:first = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.add_Tick({
  try {
    $cards = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 "$url/api/cards").Content | ConvertFrom-Json
    $need = @($cards | Where-Object { $_.review -ne "approved" }).Count
    $crit = @($cards | Where-Object { $_.level -eq "critical" -and $_.review -ne "approved" }).Count
    $ni.Text = "Foreman - $need need review" + $(if ($crit) { " ($crit critical)" } else { "" })
    foreach ($c in $cards) {
      if ($c.level -eq "critical" -and $c.review -ne "approved" -and -not $c.session.StartsWith("demo-") -and -not $script:seen.ContainsKey($c.session)) {
        $script:seen[$c.session] = $true
        if (-not $script:first) {
          $ni.BalloonTipTitle = "Foreman: critical session"
          $ni.BalloonTipText = "Risk $($c.score)/100 in $($c.cwd) - click the tray to review"
          $ni.ShowBalloonTip(6000)
        }
      }
    }
    $script:first = $false
  } catch { $ni.Text = "Foreman - inbox unreachable" }
})
$timer.Start()

$ni.Text = "Foreman - watching your AI workforce"
[System.Windows.Forms.Application]::Run()
$timer.Stop()
$ni.Dispose()
`;
}
