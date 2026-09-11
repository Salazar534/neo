#!/usr/bin/env node
/**
 * Install `neo` globally on Windows PATH (CMD + PowerShell) without Ollama.
 * Run: npm run install-global
 *
 * Durable strategy:
 * 1) %LOCALAPPDATA%\Neo\bin\neo.cmd + User PATH
 * 2) neo.cmd next to node.exe (same folder already on PATH in most shells)
 * 3) PowerShell profile function that refreshes PATH + launches neo
 * 4) Broadcast WM_SETTINGCHANGE so new processes pick up PATH
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { writePackageRootMarker, PACKAGE_ROOT } from "./paths.mjs";

const neoRoot = PACKAGE_ROOT;
const installDir = path.join(process.env.LOCALAPPDATA || "", "Neo", "bin");

if (!process.env.LOCALAPPDATA) {
  console.error("LOCALAPPDATA missing");
  process.exit(1);
}

writePackageRootMarker();
fs.mkdirSync(installDir, { recursive: true });

const cmdBody = `@echo off
setlocal
set /p NEO_ROOT=<"%LOCALAPPDATA%\\Neo\\neo_root.txt"
if not defined NEO_ROOT (
  echo NEO: missing %%LOCALAPPDATA%%\\Neo\\neo_root.txt — run: npm run install-global
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo NEO: node not found on PATH
  exit /b 1
)
set "NEO_WORKSPACE=%CD%"
node "%NEO_ROOT%\\bin\\neo.mjs" %*
exit /b %ERRORLEVEL%
`;

// Only ship .cmd on PATH — PowerShell prefers .ps1 over .cmd and can fail under
// stricter ExecutionPolicy with CommandNotFound-like or script-blocked errors.
fs.writeFileSync(path.join(installDir, "neo.cmd"), cmdBody, "utf8");
for (const stale of ["neo.ps1", "NEO.ps1"]) {
  const p = path.join(installDir, stale);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// Also drop neo.cmd beside node.exe (already on PATH even in stale terminals).
const nodeDir = path.dirname(process.execPath);
try {
  fs.writeFileSync(path.join(nodeDir, "neo.cmd"), cmdBody, "utf8");
  console.log("node shim ->", path.join(nodeDir, "neo.cmd"));
} catch (err) {
  console.warn("node shim skipped:", err?.message || err);
}

// Add installDir to User PATH if missing
const psAddPath = `
$dir = '${installDir.replace(/'/g, "''")}'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$parts = @($userPath -split ';' | Where-Object { $_ -and $_.Trim() -ne '' })
if ($parts -notcontains $dir) {
  $newPath = if ($userPath.Trim()) { "$userPath;$dir" } else { $dir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Output "PATH_UPDATED"
} else {
  Write-Output "PATH_OK"
}
Add-Type -Namespace NeoWin -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@ -ErrorAction SilentlyContinue
try {
  $HWND_BROADCAST = [IntPtr]0xffff
  $WM_SETTINGCHANGE = 0x1A
  $result = [UIntPtr]::Zero
  [void][NeoWin.Native]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  Write-Output "ENV_BROADCAST_OK"
} catch {
  Write-Output "ENV_BROADCAST_SKIP"
}
`;

const pathResult = spawnSync(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psAddPath],
  { encoding: "utf8", windowsHide: true },
);
console.log("launcher ->", installDir);
console.log("neo root ->", neoRoot);
console.log("PATH:", (pathResult.stdout || "").trim() || pathResult.stderr || "check");

const profileSnippet = `
# >>> NEO
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
function neo {
  $rootFile = Join-Path $env:LOCALAPPDATA 'Neo\\neo_root.txt'
  if (-not (Test-Path $rootFile)) {
    Write-Host 'NEO not installed. From the neo folder run: npm run install-global' -ForegroundColor Red
    return
  }
  $NeoRoot = (Get-Content -Raw $rootFile).Trim()
  $entry = Join-Path $NeoRoot 'bin\\neo.mjs'
  if (-not (Test-Path $entry)) {
    Write-Host "NEO: missing $entry" -ForegroundColor Red
    return
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'NEO: node not found on PATH' -ForegroundColor Red
    return
  }
  $env:NEO_WORKSPACE = (Get-Location).Path
  Write-Host 'NEO' -ForegroundColor DarkYellow
  & node $entry @args
}
try {
  Set-PSReadLineOption -Colors @{ Command = '#F0A86A' } -ErrorAction SilentlyContinue
} catch {}
# <<< NEO
`;

function ensureProfile(profilePath) {
  const dir = path.dirname(profilePath);
  fs.mkdirSync(dir, { recursive: true });
  let existing = "";
  if (fs.existsSync(profilePath)) existing = fs.readFileSync(profilePath, "utf8");
  if (existing.includes("# >>> NEO")) {
    existing = existing.replace(/# >>> NEO[\s\S]*?# <<< NEO\s*/g, "").trimEnd() + "\n";
  }
  fs.writeFileSync(profilePath, existing + "\n" + profileSnippet.trim() + "\n", "utf8");
  console.log("profile ->", profilePath);
}

const docs = path.join(process.env.USERPROFILE || "", "Documents");
ensureProfile(path.join(docs, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"));
ensureProfile(path.join(docs, "PowerShell", "Microsoft.PowerShell_profile.ps1"));

const verify = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); Get-Command neo | Format-List Name,CommandType,Source`,
  ],
  { encoding: "utf8", windowsHide: true },
);
console.log((verify.stdout || "").trim());
console.log("\nDone. Open a NEW terminal and type: neo");
console.log("Then: neo install   (downloads Neo brain model — no Ollama needed)");
console.log("Also works as: NEO");
