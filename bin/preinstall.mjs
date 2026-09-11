#!/usr/bin/env node
/**
 * preinstall — silent Windows global-bin hygiene before npm links `neo`.
 * Never fails the install. Removes stale WinGet-dir shims + prefers %APPDATA%\npm.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function tryUnlink(p) {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* WinGet dirs may be read-only — ignore */
  }
}

try {
  const nodeDir = path.dirname(process.execPath);
  for (const name of ["neo", "neo.cmd", "neo.ps1", "NEO.cmd", "NEO.ps1"]) {
    tryUnlink(path.join(nodeDir, name));
  }

  if (process.platform === "win32") {
    const desired = path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "npm",
    );
    fs.mkdirSync(desired, { recursive: true });
    const cur = spawnSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const current = (cur.stdout || "").trim();
    const looksSystem =
      /WinGet|Program Files|nodejs/i.test(current) ||
      current.toLowerCase() === nodeDir.toLowerCase();
    if (looksSystem || !current) {
      spawnSync("npm", ["config", "set", "prefix", desired], {
        windowsHide: true,
        stdio: "ignore",
      });
    }
  }
} catch {
  /* never fail npm install */
}
