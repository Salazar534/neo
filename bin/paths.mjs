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
 */
export const NEO_MODELS = {
  brain: {
    id: "neo-brain",
    file: "neo-brain.gguf",
    required: true,
    kind: "gguf",
    n_ctx: 16384,
    // upstream mirror (Hugging Face) — download only; local name is Neo-branded
    upstream_repo: "unsloth/Qwen2.5-Coder-3B-Instruct-GGUF",
    upstream_file: "Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf",
    approx_mb: 1930,
    description: "Primary Neo text/coding brain",
  },
  coder: {
    id: "neo-coder",
    file: "neo-coder.gguf",
    required: true,
    kind: "gguf",
    // Same capable coding weights; stored under Neo name for role clarity
    upstream_repo: "unsloth/Qwen2.5-Coder-3B-Instruct-GGUF",
    upstream_file: "Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf",
    // If brain already downloaded, install may hardlink/copy instead of re-fetch
    alias_of: "brain",
    approx_mb: 1930,
    description: "Neo coding specialist weights",
  },
  image: {
    id: "neo-image",
    dir: "neo-image",
    required: true,
    kind: "diffusers",
    // upstream mirror for image pipeline weights
    upstream_repo: "stabilityai/sd-turbo",
    approx_mb: 3200,
    description: "Neo local image generation weights",
  },
};

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
