#!/usr/bin/env node
/**
 * Dev helper: register neo for local checkout.
 * Prefer: npm install -g .   or   npm install -g github:Salazar534/neo
 *
 * On Windows this no longer drops neo.cmd next to node.exe (breaks WinGet Node).
 * Use `neo repair` / fix-path.mjs if global install hits EEXIST/EPERM.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePackageRootMarker, PACKAGE_ROOT } from "./paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
writePackageRootMarker();

console.log("NEO install-global (safe mode)");
console.log("package →", PACKAGE_ROOT);

// Clean stale shims that block npm -g
spawnSync(process.execPath, [path.join(here, "fix-path.mjs")], {
  stdio: "inherit",
  windowsHide: true,
});

const r = spawnSync("npm", ["install", "-g", PACKAGE_ROOT, "--force"], {
  stdio: "inherit",
  windowsHide: true,
  shell: process.platform === "win32",
});

if (r.status) {
  console.error("\nGlobal install failed. Try:");
  console.error("  npm config set prefix %APPDATA%\\npm   # Windows");
  console.error("  npm install -g github:Salazar534/neo --force");
  process.exit(r.status || 1);
}

console.log("\nDone. Open a NEW terminal if needed, then:");
console.log("  neo doctor");
console.log("  neo install");
