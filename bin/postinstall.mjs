#!/usr/bin/env node
/**
 * postinstall — CLI only; models are huge (~6.5 GB).
 * Opt-in: NEO_INSTALL_MODELS=1 npm install -g @node30/neo
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const wantModels =
  process.env.NEO_INSTALL_MODELS === "1" ||
  process.env.NEO_INSTALL_MODELS === "true" ||
  process.env.npm_config_neo_install_models === "true";

const here = path.dirname(fileURLToPath(import.meta.url));
const installJs = path.join(here, "install.mjs");

if (wantModels) {
  console.log("\n  NEO: NEO_INSTALL_MODELS=1 — running neo install…\n");
  const r = spawnSync(process.execPath, [installJs], {
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

console.log("\n  NEO CLI ready. Run: neo install\n");
