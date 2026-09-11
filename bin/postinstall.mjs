#!/usr/bin/env node
/**
 * postinstall — never fail the npm install. Models are separate (~6.5 GB).
 */
try {
  const want =
    process.env.NEO_INSTALL_MODELS === "1" ||
    process.env.NEO_INSTALL_MODELS === "true" ||
    process.env.npm_config_neo_install_models === "true";
  if (want) {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const r = spawnSync(process.execPath, [path.join(here, "install.mjs")], {
      stdio: "inherit",
      windowsHide: true,
      env: process.env,
    });
    if (r.status) process.exitCode = r.status;
  } else {
    console.log("\n  NEO CLI ready. Run: neo install\n");
  }
} catch (e) {
  console.log("\n  NEO CLI installed. Run: neo install\n");
  console.log("  (postinstall note:", String(e?.message || e), ")");
}
