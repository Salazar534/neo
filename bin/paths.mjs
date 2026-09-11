/**
 * Shared Neo install / data paths (cross-platform; Windows-first).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function neoDataRoot() {
  if (process.env.NEO_HOME) return path.resolve(process.env.NEO_HOME);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Neo");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Neo");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "neo");
}

export function neoModelsDir() {
  return path.join(neoDataRoot(), "models");
}

export function neoDbPath() {
  return path.join(neoDataRoot(), "neo.db");
}

export function neoConfigPath() {
  return path.join(neoDataRoot(), "config.json");
}

export function neoVenvDir() {
  return path.join(neoDataRoot(), "venv");
}

export function neoRootMarkerPath() {
  return path.join(neoDataRoot(), "neo_root.txt");
}

/**
 * Neo-branded model assets.
 * upstream_* fields are fetch mirrors only — never shown as product names.
 *
 * Modes Neo Plan / Neo Code / Neo Work all run on neo-brain.gguf (one GGUF).
 * neo-coder / neo-plan / neo-work are the same weights under role names (hardlink when possible).
 * Neo Vision = local image weights under models/neo-image/.
 */
function brainAlias(id, brand, file, description) {
  return {
    id,
    brand,
    file,
    required: true,
    kind: "gguf",
    upstream_repo: "unsloth/Qwen2.5-Coder-3B-Instruct-GGUF",
    upstream_file: "Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf",
    alias_of: "brain",
    approx_bytes: 1_930_000_000,
    approx_mb: 1930,
    download: false,
    description,
  };
}

export const NEO_MODELS = {
  brain: {
    id: "neo-brain",
    brand: "Neo Brain",
    modes: ["Neo Plan", "Neo Code", "Neo Work"],
    file: "neo-brain.gguf",
    required: true,
    kind: "gguf",
    n_ctx: 16384,
    // upstream mirror — download only; local name is Neo-branded
    upstream_repo: "unsloth/Qwen2.5-Coder-3B-Instruct-GGUF",
    upstream_file: "Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf",
    approx_bytes: 1_930_000_000,
    approx_mb: 1930,
    download: true,
    description: "Primary Neo text brain (powers Plan / Code / Work modes)",
  },
  coder: brainAlias(
    "neo-coder",
    "Neo Code",
    "neo-coder.gguf",
    "Neo Code role weights (same file as Neo Brain; hardlink when possible)",
  ),
  plan: brainAlias(
    "neo-plan",
    "Neo Plan",
    "neo-plan.gguf",
    "Neo Plan role weights (same file as Neo Brain; hardlink when possible)",
  ),
  work: brainAlias(
    "neo-work",
    "Neo Work",
    "neo-work.gguf",
    "Neo Work role weights (same file as Neo Brain; hardlink when possible)",
  ),
  image: {
    id: "neo-vision",
    brand: "Neo Vision",
    dir: "neo-image",
    required: true,
    kind: "diffusers",
    // upstream mirror for image pipeline; install pulls fp16 diffusers layout only
    upstream_repo: "stabilityai/sd-turbo",
    approx_bytes: 2_600_000_000,
    approx_mb: 2600,
    download: true,
    description: "Neo Vision — local image generation weights",
  },
};

/** Approx pip/runtime footprint (brain + vision deps). Not model weights. */
export const NEO_RUNTIME_APPROX = {
  brain_pip_mb: 120,
  vision_pip_mb: 1800,
  description: "Python venv: llama-cpp + (optional) torch/diffusers for Neo Vision",
};

/**
 * Bundle size plan for neo install (download vs disk).
 * @param {{ skipImage?: boolean }} [opts]
 */
export function neoInstallSizePlan(opts = {}) {
  const skipImage = Boolean(opts.skipImage);
  const brain = NEO_MODELS.brain;
  const image = NEO_MODELS.image;
  const aliasNote = (spec) =>
    "hardlink ≈ 0 extra disk; copy ≈ +" + formatBytes(spec.approx_bytes) + " if hardlink fails";
  const assets = [
    {
      key: "brain",
      brand: brain.brand,
      pathName: brain.file,
      role: "Shared GGUF (Plan / Code / Work)",
      downloadBytes: brain.approx_bytes,
      diskBytes: brain.approx_bytes,
      note: "one download from Hugging Face",
    },
    {
      key: "coder",
      brand: NEO_MODELS.coder.brand,
      pathName: NEO_MODELS.coder.file,
      role: "Neo Code role alias",
      downloadBytes: 0,
      diskBytes: 0,
      note: aliasNote(NEO_MODELS.coder),
    },
    {
      key: "plan",
      brand: NEO_MODELS.plan.brand,
      pathName: NEO_MODELS.plan.file,
      role: "Neo Plan role alias",
      downloadBytes: 0,
      diskBytes: 0,
      note: aliasNote(NEO_MODELS.plan),
    },
    {
      key: "work",
      brand: NEO_MODELS.work.brand,
      pathName: NEO_MODELS.work.file,
      role: "Neo Work role alias",
      downloadBytes: 0,
      diskBytes: 0,
      note: aliasNote(NEO_MODELS.work),
    },
  ];
  if (!skipImage) {
    assets.push({
      key: "image",
      brand: image.brand,
      pathName: image.dir + "/",
      role: "Local image generation",
      downloadBytes: image.approx_bytes,
      diskBytes: image.approx_bytes,
      note: "Hugging Face snapshot (fp16 pipeline)",
    });
  }
  const runtimeMb =
    NEO_RUNTIME_APPROX.brain_pip_mb + (skipImage ? 0 : NEO_RUNTIME_APPROX.vision_pip_mb);
  const downloadBytes = assets.reduce((s, a) => s + a.downloadBytes, 0);
  const diskBytes = assets.reduce((s, a) => s + a.diskBytes, 0);
  return {
    assets,
    modelsDownloadBytes: downloadBytes,
    modelsDiskBytes: diskBytes,
    runtimeApproxBytes: runtimeMb * 1_000_000,
    totalDownloadBytes: downloadBytes + runtimeMb * 1_000_000,
    totalDiskBytes: diskBytes + runtimeMb * 1_000_000,
    skipImage,
  };
}

export function formatBytes(n) {
  const x = Number(n) || 0;
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)} GB`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(0)} MB`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(0)} KB`;
  return `${x} B`;
}

/** True when neo-brain.gguf is present and usable. */
export function neoBrainInstalled() {
  const brain = path.join(neoModelsDir(), NEO_MODELS.brain.file);
  try {
    return fs.existsSync(brain) && fs.statSync(brain).size > 1_000_000;
  } catch {
    return false;
  }
}

/** @deprecated use NEO_MODELS.brain — kept for older scripts */
export const DEFAULT_MODEL = {
  id: NEO_MODELS.brain.id,
  repo: NEO_MODELS.brain.upstream_repo,
  file: NEO_MODELS.brain.file,
  upstream_file: NEO_MODELS.brain.upstream_file,
  n_ctx: NEO_MODELS.brain.n_ctx,
};

export const DEFAULT_BRAIN_PORT = Number(process.env.NEO_BRAIN_PORT || 8766);
export const DEFAULT_IMAGE_PORT = Number(process.env.NEO_IMAGE_PORT || 8765);

export function loadConfig() {
  const p = neoConfigPath();
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function saveConfig(cfg) {
  const root = neoDataRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(neoModelsDir(), { recursive: true });
  fs.writeFileSync(neoConfigPath(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function resolvePython() {
  const venv = neoVenvDir();
  if (process.platform === "win32") {
    const win = path.join(venv, "Scripts", "python.exe");
    if (fs.existsSync(win)) return win;
  } else {
    const unix = path.join(venv, "bin", "python");
    if (fs.existsSync(unix)) return unix;
  }
  const comfy = path.resolve(PACKAGE_ROOT, "..", "ComfyUI", ".venv", "Scripts", "python.exe");
  if (fs.existsSync(comfy)) return comfy;
  return process.platform === "win32" ? "python" : "python3";
}

export function writePackageRootMarker() {
  const root = neoDataRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(neoRootMarkerPath(), PACKAGE_ROOT + "\n", "utf8");
}
