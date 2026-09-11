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
import { spawn } from "node:child_process";
import { writePackageRootMarker, resolvePython, PACKAGE_ROOT, loadConfig, DEFAULT_BRAIN_PORT } from "./paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = (argv[0] || "").toLowerCase();

// Always write where the user launched from
if (!process.env.NEO_WORKSPACE) {
  process.env.NEO_WORKSPACE = process.cwd();
}

writePackageRootMarker();

async function launchUi() {
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
  console.log(`NEO — local agent OS (no Ollama required)

Usage:
  neo              Start the agent UI
  neo install      Download Neo model + brain runtime
  neo doctor       Check GPU/CPU, model, PATH, daemons
  neo brain        Run brain daemon (foreground)
  neo help         Show this help

Install (world-wide):
  npm install -g @node30/neo
  neo install
  neo

Env:
  NEO_WORKSPACE     file write root (default: cwd)
  NEO_USE_OLLAMA=1  optional Ollama fallback
  NEO_BRAIN_PORT    default 8766
  NEO_N_GPU_LAYERS  llama.cpp GPU layers (-1=all, 0=CPU)
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
} else if (cmd === "brain" || cmd === "serve") {
  await runBrainFg();
} else if (!cmd || cmd.startsWith("-") || cmd === "ui" || cmd === "chat") {
  // bare `neo` or unknown flags → UI (pass remaining as unused for now)
  await launchUi();
} else {
  console.error(`Unknown command: ${cmd}`);
  help();
  process.exit(1);
}
