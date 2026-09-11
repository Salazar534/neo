#!/usr/bin/env node
/**
 * neo install — download ALL Neo foundational model assets + Python brain runtime.
 *
 * Full bundle (default): Neo Brain (+ Neo Code hardlink) + Neo Vision + pip runtime.
 *
 * Flags:
 *   --dry-run     print size plan, download nothing
 *   --check       verify config/model/runtime without downloading
 *   --cpu         force n_gpu_layers=0
 *   --skip-image  skip Neo Vision weights (text brain only)
 *   --brain-only  alias for --skip-image
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import {
  DEFAULT_BRAIN_PORT,
  NEO_MODELS,
  PACKAGE_ROOT,
  formatBytes,
  loadConfig,
  neoDataRoot,
  neoDbPath,
  neoInstallSizePlan,
  neoModelsDir,
  neoVenvDir,
  resolvePython,
  saveConfig,
  writePackageRootMarker,
} from "./paths.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const checkOnly = args.includes("--check");
const forceCpu = args.includes("--cpu");
const skipImage = args.includes("--skip-image") || args.includes("--brain-only");

function log(msg) {
  console.log(msg);
}

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    encoding: "utf8",
    windowsHide: true,
  });
  return r.status === 0 ? (r.stdout || "").trim().split(/\r?\n/)[0] : null;
}

function run(cmd, a, opts = {}) {
  log(`+ ${cmd} ${a.join(" ")}`);
  if (dryRun) return { status: 0 };
  const r = spawnSync(cmd, a, { stdio: "inherit", windowsHide: true, ...opts });
  return r;
}

/** Tracks overall bundle download progress across files. */
class BundleProgress {
  constructor(totalBytes) {
    this.totalBytes = Math.max(1, totalBytes || 1);
    this.completedBytes = 0;
    this.currentLabel = "";
    this.currentReceived = 0;
    this.currentTotal = 0;
    this.lastLine = "";
  }

  beginFile(label, expectedBytes) {
    this.currentLabel = label;
    this.currentReceived = 0;
    this.currentTotal = expectedBytes || 0;
    this.render(true);
  }

  onChunk(n, contentLength) {
    this.currentReceived += n;
    if (contentLength > 0) this.currentTotal = contentLength;
    this.render(false);
  }

  endFile() {
    const counted = this.currentTotal > 0 ? this.currentTotal : this.currentReceived;
    this.completedBytes += counted;
    this.currentReceived = 0;
    this.currentTotal = 0;
    process.stdout.write("\n");
    this.lastLine = "";
  }

  render(force) {
    const fileDone = this.currentReceived;
    const fileTot = this.currentTotal;
    const filePct = fileTot > 0 ? Math.min(100, Math.floor((fileDone / fileTot) * 100)) : -1;
    const overallDone = this.completedBytes + fileDone;
    const overallPct = Math.min(100, Math.floor((overallDone / this.totalBytes) * 100));
    const fileBit =
      filePct >= 0
        ? `${formatBytes(fileDone)} / ${formatBytes(fileTot)} (${filePct}%)`
        : `${formatBytes(fileDone)}`;
    const line = `  ${this.currentLabel}  ${fileBit}  ·  bundle ${overallPct}% (${formatBytes(overallDone)} / ${formatBytes(this.totalBytes)})`;
    if (!force && line === this.lastLine) return;
    // throttle to ~every 1% of file or every 2MB when unknown
    if (!force && fileTot > 0) {
      const pct = filePct;
      const prev = this._lastPct ?? -1;
      if (pct === prev && pct % 1 !== 0) return;
      if (pct === prev) return;
      this._lastPct = pct;
    } else if (!force && fileTot <= 0) {
      const bucket = Math.floor(fileDone / (2 * 1024 * 1024));
      if (bucket === this._lastBucket) return;
      this._lastBucket = bucket;
    }
    this.lastLine = line;
    process.stdout.write(`\r${line}${" ".repeat(Math.max(0, 12))}`);
  }
}

function download(url, dest, progress, label, expectedBytes) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + ".partial";
    const file = fs.createWriteStream(tmp);
    progress?.beginFile(label || path.basename(dest), expectedBytes || 0);

    const get = (u, redirects = 0) => {
      const lib = u.startsWith("https") ? https : http;
      lib
        .get(u, { headers: { "User-Agent": "neo-install/2.2" } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            if (redirects > 8) return reject(new Error("too many redirects"));
            res.resume();
            return get(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            reject(new Error(`download HTTP ${res.statusCode}`));
            res.resume();
            return;
          }
          const contentLength = Number(res.headers["content-length"] || 0);
          res.on("data", (chunk) => {
            progress?.onChunk(chunk.length, contentLength);
          });
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              progress?.endFile();
              fs.renameSync(tmp, dest);
              resolve({ bytes: contentLength || fs.statSync(dest).size });
            });
          });
        })
        .on("error", (err) => {
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* */
          }
          reject(err);
        });
    };
    get(url);
  });
}

function ensureVenv() {
  const venv = neoVenvDir();
  const py = resolvePython();
  const venvPy =
    process.platform === "win32"
      ? path.join(venv, "Scripts", "python.exe")
      : path.join(venv, "bin", "python");

  if (fs.existsSync(venvPy)) {
    log(`venv ok → ${venvPy}`);
    return venvPy;
  }

  const systemPy = which("python") || which("python3") || "python";
  log(`creating venv at ${venv}`);
  const r = run(systemPy, ["-m", "venv", venv]);
  if (r.status) {
    console.error("Failed to create venv. Install Python 3.10+ and retry.");
    process.exit(r.status || 1);
  }
  if (!fs.existsSync(venvPy) && !dryRun) {
    console.error("venv python missing after create");
    process.exit(1);
  }
  return dryRun ? py : venvPy;
}

function pipInstall(venvPy) {
  const brainReq = path.join(PACKAGE_ROOT, "daemon", "requirements-brain.txt");
  run(venvPy, ["-m", "pip", "install", "-U", "pip"]);
  const r = run(venvPy, ["-m", "pip", "install", "-r", brainReq]);
  if (r.status) {
    console.error("pip install failed (network?). Will still try to download Neo model assets.");
    console.error("Retry later: neo install   — or see README for CUDA rebuild.");
    return false;
  }
  if (!skipImage) {
    const imgReq = path.join(PACKAGE_ROOT, "daemon", "requirements-image.txt");
    if (fs.existsSync(imgReq)) {
      log("installing Neo Vision runtime (torch / diffusers)…");
      const r2 = run(venvPy, ["-m", "pip", "install", "-r", imgReq]);
      if (r2.status) {
        console.error("Neo Vision pip deps failed — image features may need: neo install (retry)");
      }
    }
  }
  return true;
}

function ggufUrl(spec) {
  return `https://huggingface.co/${spec.upstream_repo}/resolve/main/${spec.upstream_file}`;
}

function tryHardlinkOrCopy(src, dest) {
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    fs.linkSync(src, dest);
    return "hardlink";
  } catch {
    fs.copyFileSync(src, dest);
    return "copy";
  }
}

async function ensureGguf(key, brainPath, progress) {
  const spec = NEO_MODELS[key];
  const dest = path.join(neoModelsDir(), spec.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
    log(`${spec.brand} (${spec.id}) ok → ${dest}`);
    if (progress && spec.download) progress.completedBytes += spec.approx_bytes || 0;
    return dest;
  }
  // Migrate legacy vendor-named GGUF if present in models dir
  if (!dryRun && spec.upstream_file) {
    const legacy = path.join(neoModelsDir(), spec.upstream_file);
    if (fs.existsSync(legacy) && fs.statSync(legacy).size > 1_000_000) {
      log(`${spec.brand} ← migrate legacy file → ${spec.file}`);
      tryHardlinkOrCopy(legacy, dest);
      if (progress && spec.download) progress.completedBytes += spec.approx_bytes || 0;
      return dest;
    }
  }
  if (spec.alias_of && brainPath && fs.existsSync(brainPath) && fs.statSync(brainPath).size > 1_000_000) {
    log(`${spec.brand} ← ${NEO_MODELS[spec.alias_of].brand} (${spec.file})`);
    if (!dryRun) {
      const how = tryHardlinkOrCopy(brainPath, dest);
      log(`  ${how} → ${dest}${how === "hardlink" ? " (0 extra disk)" : " (full copy)"}`);
    }
    return dest;
  }
  const url = ggufUrl(spec);
  log(`${spec.brand} → ${dest}`);
  log(`  download ~${formatBytes(spec.approx_bytes)} (${spec.id})`);
  if (dryRun) return dest;
  await download(url, dest, progress, spec.brand, spec.approx_bytes);
  return dest;
}

async function ensureImage(venvPy, progress) {
  const spec = NEO_MODELS.image;
  const dest = path.join(neoModelsDir(), spec.dir);
  const marker = path.join(dest, ".neo-ready");
  if (fs.existsSync(marker)) {
    log(`${spec.brand} (${spec.id}) ok → ${dest}`);
    if (progress) progress.completedBytes += spec.approx_bytes || 0;
    return dest;
  }
  log(`${spec.brand} → ${dest}`);
  log(`  download ~${formatBytes(spec.approx_bytes)} (fp16 pipeline)`);
  if (dryRun) return dest;
  fs.mkdirSync(dest, { recursive: true });
  progress?.beginFile(spec.brand, spec.approx_bytes);
  // Prefer huggingface_hub snapshot into Neo-named folder (fp16 + configs only)
  const pyCode = `
from huggingface_hub import snapshot_download
import os
dest = r${JSON.stringify(dest)}
repo = r${JSON.stringify(spec.upstream_repo)}
os.makedirs(dest, exist_ok=True)
snapshot_download(
    repo_id=repo,
    local_dir=dest,
    local_dir_use_symlinks=False,
    ignore_patterns=["*.png", "*.jpg", "sd_turbo.safetensors", "**/model.safetensors", "**/diffusion_pytorch_model.safetensors"],
    allow_patterns=[
        "model_index.json",
        "scheduler/*",
        "tokenizer/*",
        "text_encoder/config.json",
        "text_encoder/model.fp16.safetensors",
        "unet/config.json",
        "unet/diffusion_pytorch_model.fp16.safetensors",
        "vae/config.json",
        "vae/diffusion_pytorch_model.fp16.safetensors",
    ],
)
open(os.path.join(dest, ".neo-ready"), "w").write("ok\\n")
print(dest)
`;
  const r = spawnSync(venvPy, ["-c", pyCode], { stdio: "inherit", windowsHide: true });
  if (r.status) {
    console.error("Neo Vision download failed (optional: neo install --skip-image)");
    process.exit(r.status || 1);
  }
  // Mark file complete in overall progress (hub shows its own bars)
  if (progress) {
    progress.currentReceived = 0;
    progress.currentTotal = 0;
    progress.completedBytes += spec.approx_bytes || 0;
    process.stdout.write(
      `\r  ${spec.brand}  done  ·  bundle ${Math.min(100, Math.floor((progress.completedBytes / progress.totalBytes) * 100))}%\n`,
    );
  }
  return dest;
}

function writeCfg(modelPath, coderPath, imagePath) {
  const prev = loadConfig() || {};
  const brain = NEO_MODELS.brain;
  const cfg = {
    ...prev,
    model_id: brain.id,
    model_file: brain.file,
    model_path: modelPath,
    coder_id: NEO_MODELS.coder.id,
    coder_path: coderPath || null,
    image_id: NEO_MODELS.image.id,
    image_path: imagePath || null,
    brain_port: prev.brain_port || DEFAULT_BRAIN_PORT,
    n_ctx: prev.n_ctx || brain.n_ctx,
    n_gpu_layers: forceCpu ? 0 : prev.n_gpu_layers ?? -1,
    db_path: neoDbPath(),
    installed_at: new Date().toISOString(),
  };
  delete cfg.model_repo;
  if (dryRun) {
    log("config (dry-run): " + JSON.stringify(cfg, null, 2));
    return cfg;
  }
  saveConfig(cfg);
  writePackageRootMarker();
  log(`config → ${path.join(neoDataRoot(), "config.json")}`);
  return cfg;
}

function checkRuntime() {
  const cfg = loadConfig();
  const issues = [];
  if (!cfg) issues.push("no config.json — run neo install");
  else {
    if (!cfg.model_path || !fs.existsSync(cfg.model_path)) issues.push("Neo Brain model file missing");
    else if (!String(cfg.model_file || path.basename(cfg.model_path)).startsWith("neo-")) {
      issues.push("model file should be Neo-branded (re-run neo install)");
    }
  }
  const py = resolvePython();
  const r = spawnSync(py, ["-c", "import llama_cpp; print(llama_cpp.__version__)"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) issues.push("llama-cpp-python not importable (run neo install)");
  else log(`llama-cpp-python ${(r.stdout || "").trim()}`);

  if (issues.length) {
    for (const i of issues) console.error("✗", i);
    process.exit(1);
  }
  log("✓ neo install check passed");
}

function printSizePlan() {
  const plan = neoInstallSizePlan({ skipImage });
  log("");
  log("Install size plan (approximate)");
  log("─".repeat(72));
  log(
    `${"Asset".padEnd(14)} ${"Path".padEnd(18)} ${"Download".padStart(10)} ${"Disk".padStart(10)}  Role`,
  );
  for (const a of plan.assets) {
    log(
      `${a.brand.padEnd(14)} ${a.pathName.padEnd(18)} ${formatBytes(a.downloadBytes).padStart(10)} ${formatBytes(a.diskBytes).padStart(10)}  ${a.role}`,
    );
    if (a.note) log(`${"".padEnd(14)} ${a.note}`);
  }
  log("─".repeat(72));
  log(`Models download   ${formatBytes(plan.modelsDownloadBytes)}`);
  log(`Models disk       ${formatBytes(plan.modelsDiskBytes)}  (Neo Code hardlink ≈ 0 extra)`);
  log(`Runtime (pip)     ~${formatBytes(plan.runtimeApproxBytes)}`);
  log(`TOTAL download    ~${formatBytes(plan.totalDownloadBytes)}`);
  log(`TOTAL disk        ~${formatBytes(plan.totalDiskBytes)}`);
  log("");
  log("Honest note: Neo Plan / Neo Code / Neo Work share one GGUF (neo-brain.gguf).");
  log("Neo Code also installs neo-coder.gguf as a hardlink/copy of that same file.");
  log("Neo Vision is separate image weights under models/neo-image/.");
  if (skipImage) log("(Neo Vision skipped via --skip-image)");
  log("");
}

function printDryRunPlan() {
  log("(dry-run — no writes/downloads)");
  log(`data → ${neoDataRoot()}`);
  log(`db   → ${neoDbPath()}`);
  log(`would create venv → ${neoVenvDir()}`);
  log(`would pip install → daemon/requirements-brain.txt`);
  if (!skipImage) log(`would pip install → daemon/requirements-image.txt`);
  printSizePlan();
  for (const key of ["brain", "coder"]) {
    const s = NEO_MODELS[key];
    const dest = path.join(neoModelsDir(), s.file);
    log(`would install ${s.brand} (${s.id}) → ${dest}`);
    if (s.alias_of) log(`  (hardlink/copy of ${NEO_MODELS[s.alias_of].brand})`);
  }
  if (!skipImage) {
    const s = NEO_MODELS.image;
    log(`would install ${s.brand} (${s.id}) → ${path.join(neoModelsDir(), s.dir)}`);
  } else {
    log("skipping Neo Vision (--skip-image)");
  }
  log(`would write config → ${path.join(neoDataRoot(), "config.json")}`);
}

async function main() {
  log("NEO install — full foundational bundle");
  log(`data → ${neoDataRoot()}`);

  if (checkOnly) {
    checkRuntime();
    return;
  }

  if (dryRun) {
    printDryRunPlan();
    return;
  }

  printSizePlan();
  writePackageRootMarker();
  fs.mkdirSync(neoModelsDir(), { recursive: true });

  const plan = neoInstallSizePlan({ skipImage });
  const progress = new BundleProgress(plan.modelsDownloadBytes);

  const venvPy = ensureVenv();
  const pipOk = pipInstall(venvPy);
  const brainPath = await ensureGguf("brain", null, progress);
  const coderPath = await ensureGguf("coder", brainPath, progress);
  let imagePath = null;
  if (!skipImage) {
    imagePath = await ensureImage(venvPy, progress);
  } else {
    log("skipping Neo Vision (--skip-image)");
  }
  writeCfg(path.resolve(brainPath), path.resolve(coderPath), imagePath ? path.resolve(imagePath) : null);

  log("\nDone. Assets:");
  log(`  ${NEO_MODELS.brain.brand.padEnd(12)} ${NEO_MODELS.brain.file}`);
  log(`  ${NEO_MODELS.coder.brand.padEnd(12)} ${NEO_MODELS.coder.file}`);
  if (imagePath) log(`  ${NEO_MODELS.image.brand.padEnd(12)} ${NEO_MODELS.image.dir}/`);
  if (!pipOk) {
    log("\n⚠ Brain runtime pip install did not complete — retry when PyPI is reachable.");
    process.exitCode = 2;
  }
  log("\nNext:");
  log("  neo doctor");
  log("  neo");
  log("\nOptional GPU: rebuild llama-cpp-python with CUDA (see README).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
