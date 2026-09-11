#!/usr/bin/env node
/**
 * neo repair — remove stale neo shims that block npm global install (esp. WinGet Node).
 *
 * Fixes:
 *  - neo.cmd / neo.ps1 / neo next to node.exe (WinGet-managed dirs often EPERM/EEXIST)
 *  - %LOCALAPPDATA%\Neo\bin\neo.cmd leftovers from old install-global
 *  - prefers user-writable npm prefix (%APPDATA%\npm on Windows)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function log(m) {
  console.log(m);
}

function tryUnlink(p) {
  if (!p || !fs.existsSync(p)) return false;
  try {
    fs.unlinkSync(p);
    log(`  removed ${p}`);
    return true;
  } catch (e) {
    log(`  could not remove ${p}: ${e.message || e}`);
    return false;
  }
}

function collectCandidates() {
  const out = [];
  const nodeDir = path.dirname(process.execPath);
  for (const name of ["neo.cmd", "neo.ps1", "neo", "NEO.cmd", "NEO.ps1"]) {
    out.push(path.join(nodeDir, name));
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const neoBin = path.join(local, "Neo", "bin");
    for (const name of ["neo.cmd", "neo.ps1", "NEO.cmd", "NEO.ps1"]) {
      out.push(path.join(neoBin, name));
    }
  }
  // npm global prefix shims (safe to clear before reinstall)
  try {
    const pref = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", windowsHide: true });
    if (pref.status === 0) {
      const prefix = (pref.stdout || "").trim();
      if (prefix) {
        for (const name of ["neo.cmd", "neo.ps1", "neo"]) {
          out.push(path.join(prefix, name));
          if (process.platform !== "win32") out.push(path.join(prefix, "bin", name));
        }
      }
    }
  } catch {
    /* */
  }
  return [...new Set(out)];
}

function ensureWindowsNpmPrefix() {
  if (process.platform !== "win32") {
    log("· non-Windows: npm global bin is usually already user-writable");
    return;
  }
  const desired = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm");
  fs.mkdirSync(desired, { recursive: true });
  const cur = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", windowsHide: true });
  const current = (cur.stdout || "").trim();
  if (current.toLowerCase() !== desired.toLowerCase()) {
    log(`· setting npm prefix → ${desired}`);
    spawnSync("npm", ["config", "set", "prefix", desired], {
      stdio: "inherit",
      windowsHide: true,
    });
  } else {
    log(`· npm prefix already → ${desired}`);
  }

  // Prepend to User PATH if missing
  const ps = `
$dir = '${desired.replace(/'/g, "''")}'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$parts = @($userPath -split ';' | Where-Object { $_ -and $_.Trim() -ne '' })
if ($parts -notcontains $dir) {
  $newPath = if ($userPath.Trim()) { "$dir;$userPath" } else { $dir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Output "PATH_UPDATED"
} else {
  # move to front
  $rest = @($parts | Where-Object { $_ -ne $dir })
  [Environment]::SetEnvironmentVariable('Path', ((@($dir) + $rest) -join ';'), 'User')
  Write-Output "PATH_OK"
}
`;
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
    { encoding: "utf8", windowsHide: true },
  );
  log(`· User PATH: ${(r.stdout || "").trim() || "check"}`);
  log(`  Open a NEW terminal after repair so PATH refreshes.`);
}

function stripPowerShellNeoFunction() {
  if (process.platform !== "win32") return;
  const home = os.homedir();
  const profiles = [
    path.join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
  ];
  for (const pf of profiles) {
    if (!fs.existsSync(pf)) continue;
    try {
      let raw = fs.readFileSync(pf, "utf8");
      if (!raw.includes("# >>> NEO")) continue;
      raw = raw.replace(/# >>> NEO[\s\S]*?# <<< NEO\s*/g, "").trimEnd() + "\n";
      fs.writeFileSync(pf, raw, "utf8");
      log(`  cleaned PowerShell profile → ${pf}`);
    } catch (e) {
      log(`  could not clean profile ${pf}: ${e.message || e}`);
    }
  }
}

function main() {
  log("NEO repair — cleaning stale neo shims\n");
  let n = 0;
  for (const p of collectCandidates()) {
    if (tryUnlink(p)) n++;
  }
  if (!n) log("  (no stale neo shims found)");
  stripPowerShellNeoFunction();
  log("");
  ensureWindowsNpmPrefix();
  log("\nNext:");
  log("  npm install -g .          # from a clone");
  log("  neo install");
  log("  (after npm publish: npm install -g @node30/neo)");
}

main();
