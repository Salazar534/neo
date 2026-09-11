#!/usr/bin/env node
/**
 * neo doctor — diagnose PATH, model, brain runtime, GPU/CPU, optional image daemon.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_BRAIN_PORT,
  PACKAGE_ROOT,
  loadConfig,
  neoConfigPath,
  neoDataRoot,
  neoModelsDir,
  neoRootMarkerPath,
  resolvePython,
} from "./paths.mjs";

const ok = (m) => console.log("✓", m);
const bad = (m) => console.log("✗", m);
const info = (m) => console.log("·", m);

function which(cmd) {
  const bin = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(bin, [cmd], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  return (r.stdout || "").trim().split(/\r?\n/).filter(Boolean)[0] || null;
}

async function fetchJson(url, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const j = await res.json();
    return { ok: res.ok, status: res.status, json: j };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  console.log("NEO doctor\n");

  // Node
  ok(`node ${process.version} (${process.execPath})`);
  ok(`package ${PACKAGE_ROOT}`);

  // neo on PATH
  const neoCmd = which("neo") || which("neo.cmd");
  if (neoCmd) ok(`neo on PATH → ${neoCmd}`);
  else bad("neo not on PATH — run: npm install -g @node30/neo   or   npm run install-global");

  // Data dir
  const data = neoDataRoot();
  if (fs.existsSync(data)) ok(`data dir → ${data}`);
  else bad(`data dir missing → ${data} (run neo install)`);

  const marker = neoRootMarkerPath();
  if (fs.existsSync(marker)) info(`neo_root.txt → ${(fs.readFileSync(marker, "utf8") || "").trim()}`);

  // Config / model
  const cfg = loadConfig();
  if (cfg) {
    ok(`config → ${neoConfigPath()}`);
    info(`model_id=${cfg.model_id || "?"} n_gpu_layers=${cfg.n_gpu_layers ?? "?"} port=${cfg.brain_port || DEFAULT_BRAIN_PORT}`);
    const mp = cfg.model_path;
    if (mp && fs.existsSync(mp)) {
      const mb = (fs.statSync(mp).size / 1e6).toFixed(1);
      ok(`model file → ${mp} (${mb} MB)`);
    } else {
      bad(`model missing → ${mp || path.join(neoModelsDir(), "(none)")}`);
    }
  } else {
    bad("no config — run: neo install");
  }

  // Python + llama-cpp
  const py = resolvePython();
  info(`python → ${py}`);
  const pyVer = spawnSync(py, ["--version"], { encoding: "utf8", windowsHide: true });
  if (pyVer.status === 0) ok((pyVer.stdout || pyVer.stderr || "").trim());
  else bad("python not runnable");

  const llama = spawnSync(
    py,
    ["-c", "import llama_cpp; print('llama_cpp', llama_cpp.__version__)"],
    { encoding: "utf8", windowsHide: true },
  );
  if (llama.status === 0) ok((llama.stdout || "").trim());
  else bad("llama-cpp-python not installed — run: neo install");

  // GPU probe (best-effort)
  const gpu = spawnSync(
    "nvidia-smi",
    ["--query-gpu=name,memory.total", "--format=csv,noheader"],
    { encoding: "utf8", windowsHide: true },
  );
  if (gpu.status === 0) {
    ok(`NVIDIA GPU: ${(gpu.stdout || "").trim().split(/\r?\n/)[0]}`);
    info("CUDA llama-cpp-python build may be needed for GPU offload (CPU works without it)");
  } else {
    info("no nvidia-smi — will use CPU (fine for small GGUF)");
  }

  // Brain health
  const port = cfg?.brain_port || DEFAULT_BRAIN_PORT;
  const brain = await fetchJson(`http://127.0.0.1:${port}/health`);
  if (brain.ok && brain.json?.ready) {
    ok(`brain daemon ready @ :${port} device=${brain.json.device || "?"}`);
  } else if (brain.ok) {
    bad(`brain listening but not ready: ${brain.json?.error || "loading"}`);
  } else {
    info(`brain daemon not running (starts on first neo chat) — ${brain.error || ""}`);
  }

  // Image daemon optional
  const img = await fetchJson("http://127.0.0.1:8765/health");
  if (img.ok && img.json?.ready) ok("image daemon warm @ :8765");
  else info("image daemon optional / not warm");

  // Ollama optional
  if (process.env.NEO_USE_OLLAMA === "1") {
    const ol = await fetchJson("http://127.0.0.1:11434/api/tags");
    if (ol.ok) ok("NEO_USE_OLLAMA=1 and Ollama reachable");
    else bad("NEO_USE_OLLAMA=1 but Ollama not reachable");
  } else {
    info("Ollama not required (set NEO_USE_OLLAMA=1 to force fallback)");
  }

  // Workspace
  info(`NEO_WORKSPACE=${process.env.NEO_WORKSPACE || process.cwd()}`);

  console.log("\nDoctor done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
