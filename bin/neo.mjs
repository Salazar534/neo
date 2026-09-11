#!/usr/bin/env node
/**
 * Neo CLI — works via npm bin shim on Windows CMD, PowerShell, and Git Bash.
 *
 *   neo              launch agent UI
 *   neo install      download model + brain runtime
 *   neo doctor       diagnose install / GPU / PATH
 *   neo brain        run brain daemon in foreground
 *   neo help
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  writePackageRootMarker,
  resolvePython,
  PACKAGE_ROOT,
  loadConfig,
  DEFAULT_BRAIN_PORT,
  neoBrainInstalled,
  formatBytes,
  neoInstallSizePlan,
} from "./paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = (argv[0] || "").toLowerCase();

// Always write where the user launched from
if (!process.env.NEO_WORKSPACE) {
  process.env.NEO_WORKSPACE = process.cwd();
}

writePackageRootMarker();

/** First-run: offer full model install when Neo Brain is missing. */
async function maybePromptInstallModels() {
  if (neoBrainInstalled()) return;
  if (process.env.NEO_SKIP_INSTALL_PROMPT === "1") return;
  if (!process.stdin.isTTY) {
    console.error("Neo models missing. Run: neo install");
    process.exit(1);
  }
  const plan = neoInstallSizePlan({ skipImage: false });
  console.log(`
  NEO models not found yet.

  Full foundational bundle (~${formatBytes(plan.totalDownloadBytes)} download):
    Neo Brain  ·  Neo Code (hardlink)  ·  Neo Vision  ·  brain runtime

  Run install now? [Y/n]
`);
  const rl = readline.createInterface({ input, output });
  let ans = "y";
  try {
    ans = (await rl.question("  › ")).trim().toLowerCase();
  } finally {
    rl.close();
  }
  if (ans === "n" || ans === "no") {
    console.log("  Skipped. Later: neo install");
    process.exit(0);
  }
  const r = spawnSync(process.execPath, [path.join(here, "install.mjs")], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (r.status) process.exit(r.status || 1);
  if (!neoBrainInstalled()) {
    console.error("Install did not complete. Retry: neo install");
    process.exit(1);
  }
}

async function launchUi() {
  await maybePromptInstallModels();
  const wantInk = process.env.NEO_INK === "1";
  let useInk = false;
  if (wantInk) {
    try {
      const ink = await import("ink");
      useInk = Boolean(process.stdin.isTTY && ink.isRawModeSupported);
    } catch {
      useInk = false;
    }
  }
  if (useInk) {
    await import(pathToFileURL(path.join(here, "..", "ui", "App.mjs")).href);
  } else {
    await import(pathToFileURL(path.join(here, "..", "ui", "classic.mjs")).href);
  }
}

function help() {
  console.log(`NEO — fully local coding agent

Usage:
  neo              Start the agent UI
  neo install      Download ALL Neo models + brain runtime (with progress)
  neo doctor       Check models, PATH, API/daemons
  neo repair       Fix stale neo.cmd / PATH (WinGet EPERM/EEXIST)
  neo brain        Run Neo API/brain daemon (foreground)
  neo help         Show this help

Install:
  npm install -g @node30/neo && neo install
  # until published:
  npm install -g github:Salazar534/neo --force && neo install

Env:
  NEO_WORKSPACE     file write root (default: cwd)
  NEO_BRAIN_PORT    API port (default 8766)
  NEO_N_GPU_LAYERS  GPU layers (-1=all, 0=CPU)
  NEO_N_CTX         context window (default 16384)
  NEO_INSTALL_MODELS=1   postinstall runs neo install
`);
}

async function runBrainFg() {
  const py = resolvePython();
  const script = path.join(PACKAGE_ROOT, "daemon", "brain_daemon.py");
  const cfg = loadConfig();
  const env = {
    ...process.env,
    NEO_BRAIN_PORT: String(cfg?.brain_port || DEFAULT_BRAIN_PORT),
  };
  const child = spawn(py, [script], { stdio: "inherit", env, windowsHide: true });
  child.on("exit", (code) => process.exit(code ?? 1));
}

if (["-h", "--help", "help"].includes(cmd)) {
  help();
} else if (cmd === "install") {
  process.argv = [process.argv[0], path.join(here, "install.mjs"), ...argv.slice(1)];
  await import(pathToFileURL(path.join(here, "install.mjs")).href);
} else if (cmd === "doctor") {
  await import(pathToFileURL(path.join(here, "doctor.mjs")).href);
} else if (cmd === "repair" || cmd === "fix-path") {
  await import(pathToFileURL(path.join(here, "fix-path.mjs")).href);
} else if (cmd === "brain" || cmd === "serve") {
  await runBrainFg();
} else if (!cmd || cmd.startsWith("-") || cmd === "ui" || cmd === "chat") {
  await launchUi();
} else {
  console.error(`Unknown command: ${cmd}`);
  help();
  process.exit(1);
}
