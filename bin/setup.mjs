#!/usr/bin/env node
/**
 * Local/dev setup — catalog, optional image deps, register PATH.
 * Model download is via `neo install` (not Ollama).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const comfyPy = path.resolve(root, "..", "ComfyUI", ".venv", "Scripts", "python.exe");
const comfyPip = path.resolve(root, "..", "ComfyUI", ".venv", "Scripts", "pip.exe");
const py = fs.existsSync(comfyPy) ? comfyPy : "python";
const pip = fs.existsSync(comfyPip) ? comfyPip : "pip";

const args = process.argv.slice(2);

function run(cmd, a, opts = {}) {
  console.log("+", cmd, a.join(" "));
  const r = spawnSync(cmd, a, { stdio: "inherit", ...opts });
  if (r.status) process.exit(r.status);
}

if (args.includes("--catalog-only")) {
  run(py, [path.join(root, "core", "gen_catalog.py")]);
  process.exit(0);
}

if (args.includes("--daemon")) {
  run(py, [path.join(root, "daemon", "image_daemon.py")]);
  process.exit(0);
}

console.log("NEO setup (no Ollama required)");
run(py, [path.join(root, "core", "gen_catalog.py")]);

if (!args.includes("--skip-image-deps")) {
  run(pip, [
    "install",
    "-U",
    "diffusers",
    "transformers",
    "accelerate",
    "safetensors",
    "sentencepiece",
    "pillow",
    "httpx",
  ]);
}

// Register `neo` on PATH for any directory (CMD + PowerShell)
run("node", [path.join(root, "bin", "install-global.mjs")]);

// Brain model + llama-cpp runtime
run("node", [path.join(root, "bin", "neo.mjs"), "install", ...args.filter((a) => a.startsWith("--"))]);

console.log("\nDone. Next:");
console.log("  neo doctor");
console.log("  neo");
console.log("  Optional: npm run image-daemon  (keep warm for /img)");
