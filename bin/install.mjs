#!/usr/bin/env node
/**
 * neo install — download all Neo-branded model assets + Python brain runtime.
 *
 * Flags:
 *   --dry-run     print plan, download nothing
 *   --check       verify config/model/runtime without downloading
 *   --cpu         force n_gpu_layers=0
 *   --skip-image  skip neo-image weights (text brain only)
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
  loadConfig,
  neoDataRoot,
  neoDbPath,
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

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + ".partial";
    const file = fs.createWriteStream(tmp);
    let received = 0;
    let total = 0;
    let lastPct = -1;

    const get = (u, redirects = 0) => {
      const lib = u.startsWith("https") ? https : http;
      lib
        .get(u, { headers: { "User-Agent": "neo-install/2.0" } }, (res) => {
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
          total = Number(res.headers["content-length"] || 0);
          res.on("data", (chunk) => {
            received += chunk.length;
            if (total > 0) {
              const pct = Math.floor((received / total) * 100);
              if (pct !== lastPct && pct % 5 === 0) {
                lastPct = pct;
                const mb = (received / 1e6).toFixed(1);
                const tot = (total / 1e6).toFixed(0);
                process.stdout.write(`\r  ${path.basename(dest)}  ${pct}%  ${mb}/${tot} MB`);
              }
            } else if (received % (5 * 1024 * 1024) < chunk.length) {
              process.stdout.write(`\r  ${path.basename(dest)}  ${(received / 1e6).toFixed(1)} MB`);
            }
          });
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              process.stdout.write("\n");
              fs.renameSync(tmp, dest);
              resolve();
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
  const req = path.join(PACKAGE_ROOT, "daemon", "requirements-brain.txt");
  run(venvPy, ["-m", "pip", "install", "-U", "pip"]);
  const r = run(venvPy, ["-m", "pip", "install", "-r", req]);
  if (r.status) {
    console.error("pip install failed. On GPU boxes see README for CUDA rebuild.");
    process.exit(r.status || 1);
  }
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

async function ensureGguf(key, brainPath) {
  const spec = NEO_MODELS[key];
  const dest = path.join(neoModelsDir(), spec.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
    log(`${spec.id} ok → ${dest}`);
    return dest;
  }
  if (spec.alias_of && brainPath && fs.existsSync(brainPath) && fs.statSync(brainPath).size > 1_000_000) {
    log(`${spec.id} ← ${spec.alias_of} (${spec.file})`);
    if (!dryRun) {
      const how = tryHardlinkOrCopy(brainPath, dest);
      log(`  ${how} → ${dest}`);
    }
    return dest;
  }
  const url = ggufUrl(spec);
  log(`${spec.id} → ${dest}`);
  log(`  (~${spec.approx_mb} MB; upstream mirror)`);
  if (dryRun) return dest;
  await download(url, dest);
  return dest;
}

async function ensureImage(venvPy) {
  const spec = NEO_MODELS.image;
  const dest = path.join(neoModelsDir(), spec.dir);
  const marker = path.join(dest, ".neo-ready");
  if (fs.existsSync(marker)) {
    log(`${spec.id} ok → ${dest}`);
    return dest;
  }
  log(`${spec.id} → ${dest}`);
  log(`  (~${spec.approx_mb} MB; upstream mirror ${spec.upstream_repo})`);
  if (dryRun) return dest;
  fs.mkdirSync(dest, { recursive: true });
  // Prefer huggingface_hub snapshot into Neo-named folder
  const pyCode = `
from huggingface_hub import snapshot_download
import os
dest = r${JSON.stringify(dest)}
repo = r${JSON.stringify(spec.upstream_repo)}
os.makedirs(dest, exist_ok=True)
snapshot_download(repo_id=repo, local_dir=dest, local_dir_use_symlinks=False)
open(os.path.join(dest, ".neo-ready"), "w").write("ok\\n")
print(dest)
`;
  const r = spawnSync(venvPy, ["-c", pyCode], { stdio: "inherit", windowsHide: true });
  if (r.status) {
    console.error("neo-image download failed (optional: neo install --skip-image)");
    process.exit(r.status || 1);
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
  // Drop legacy vendor filenames from config if present
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
    if (!cfg.model_path || !fs.existsSync(cfg.model_path)) issues.push("neo-brain model file missing");
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

function printDryRunPlan() {
  log("(dry-run — no writes/downloads)");
  log(`data → ${neoDataRoot()}`);
  log(`db   → ${neoDbPath()}`);
  log(`would create venv → ${neoVenvDir()}`);
  log(`would pip install → daemon/requirements-brain.txt`);
  for (const key of ["brain", "coder"]) {
    const s = NEO_MODELS[key];
    const dest = path.join(neoModelsDir(), s.file);
    log(`would install ${s.id} → ${dest}`);
    if (s.alias_of) log(`  (hardlink/copy of ${s.alias_of} when possible)`);
    else log(`  from upstream mirror (~${s.approx_mb} MB)`);
  }
  if (!skipImage) {
    const s = NEO_MODELS.image;
    log(`would install ${s.id} → ${path.join(neoModelsDir(), s.dir)}`);
    log(`  from upstream mirror (~${s.approx_mb} MB)`);
  } else {
    log("skipping neo-image (--skip-image)");
  }
  log(`would write config → ${path.join(neoDataRoot(), "config.json")}`);
}

async function main() {
  log("NEO install");
  log(`data → ${neoDataRoot()}`);

  if (checkOnly) {
    checkRuntime();
    return;
  }

  if (dryRun) {
    printDryRunPlan();
    return;
  }

  writePackageRootMarker();
  fs.mkdirSync(neoModelsDir(), { recursive: true });

  const venvPy = ensureVenv();
  pipInstall(venvPy);
  const brainPath = await ensureGguf("brain");
  const coderPath = await ensureGguf("coder", brainPath);
  let imagePath = null;
  if (!skipImage) {
    imagePath = await ensureImage(venvPy);
  } else {
    log("skipping neo-image (--skip-image)");
  }
  writeCfg(path.resolve(brainPath), path.resolve(coderPath), imagePath ? path.resolve(imagePath) : null);

  log("\nDone. Assets:");
  log(`  ${NEO_MODELS.brain.file}`);
  log(`  ${NEO_MODELS.coder.file}`);
  if (imagePath) log(`  ${NEO_MODELS.image.dir}/`);
  log("\nNext:");
  log("  neo doctor");
  log("  neo");
  log("\nOptional GPU: rebuild llama-cpp-python with CUDA (see README).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
